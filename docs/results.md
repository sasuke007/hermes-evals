# Results

The real experiment, run on 27 Oct 2026 against GPT-6.1 Sol, and what the platform found along the way. Costs are in [costs.md](costs.md); what the numbers cannot tell you is in [limits.md](limits.md).

## 1. The official experiment

**Question:** does the `invoice-method` skill make the agent better at accounts-payable questions?

|            |                                                                                                                                                                                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Suite      | `invoices-v1` v7: 12 tasks, each with a trap the skill warns about (paid rows, credit notes, duplicates billed under two numbers, a zero-rated VAT band, an inverted exchange rate, grace periods and caps, untidy vendor names, disputed invoices, part payments, a file to write) |
| Baseline   | `invoices-v1-baseline`: GPT-6.1 Sol through Nous Portal, toolsets `file` and `terminal`, memory off, no skills, 30 turns, 600 s                                                                                                                                                     |
| Candidate  | `invoices-v1-with-skill`: the same, plus the `invoice-method` skill (1.0.0), preloaded                                                                                                                                                                                              |
| Differs in | the skill only (New experiment's comparison: "1 field differs: skills")                                                                                                                                                                                                             |
| Runs       | 12 tasks × 2 configurations × 5 repetitions = 120, three at a time                                                                                                                                                                                                                  |
| Judge      | GPT-6.1 Sol through egress, for the one `llm_judge` check (`disputed`'s method)                                                                                                                                                                                                     |
| Hermes     | v0.22.4 at 4d04303, the same image for every run                                                                                                                                                                                                                                    |
| Experiment | `invoices-v1-skill-official`, `01M5XZMNMB9X2Z9BD3M0XHWYPH`                                                                                                                                                                                                                          |

### The verdict

|                           | Baseline            | With the skill                             |
| ------------------------- | ------------------- | ------------------------------------------ |
| Pass rate (primary check) | **60 / 60 = 1.000** | **60 / 60 = 1.000**                        |
| Pass rate (every check)   | 60 / 60             | 60 / 60                                    |
| Difference                |                     | **+0.000, 95% interval [0.000, 0.000]**    |
| Verdict                   |                     | **inconclusive: no measurable difference** |
| Execution errors          | 0                   | 0                                          |
| Ungradable runs           | 0                   | 0                                          |

Every task passed in all five repetitions, in both arms; every secondary check passed too (the `late_fees` and `summary_file` verifiers, the `per_vendor` trajectory check, and the judge, which gave `disputed`'s method 1.0 in all ten runs). The sensitivity figure is the same as the main one, since no run was excluded. The interval is a single point because every run of every task passed: there is no variation to resample.

**What it means.** On these twelve tasks GPT-6.1 Sol does not need the skill: it finds every trap from the task and its files alone. The skill changes how the agent works, not what it gets right:

| Per run, mean     | Baseline | With the skill | Change                           |
| ----------------- | -------- | -------------- | -------------------------------- |
| Tool calls        | 2.7      | 3.6            | +0.9                             |
| `read_file` calls | 1.5      | 2.5            | +1.0: the skill's `checklist.md` |
| Tokens            | 18,902   | 21,371         | +13%                             |
| Median duration   | 20.3 s   | 20.2 s         | none                             |
| Cost              | $0.0080  | $0.0090        | +12%                             |
| Cost of the arm   | $0.48    | $0.54          |                                  |

So for this model and these tasks the skill costs about 12% more per run and buys nothing measurable. More repetitions would not change that: with every run passing, more runs only repeat 1.000. To measure what the skill adds, the suite needs harder tasks, or a weaker model to compare on.

### Three runs, annotated

1. **`late_fees`, baseline** (`01M5XZMNMEBM7GBF3RMMVCM60G`, 19 s, 18,928 tokens, $0.013). Read `invoices.csv` and `policy_terms.json`, computed every fee in one Python command through the terminal, and answered. Both checks passed: the total within ±0.01, and the verifier's "12 of 12 invoices right". The trap (a grace period and a cap in the policy file) was handled without help.
2. **`late_fees`, with the skill** (`01M5XZMNMEBM7GBF3RMMVCM60N`, 23 s, 22,159 tokens, $0.017). The same two reads, then `read_file /opt/data/skills/invoice-method/checklist.md` before computing: the skill's method in action. Same answer, same checks, 17% more tokens.
3. **`total_due` in the dry run, baseline** (`01M5WWS38QF7RN2JVGM96N0Z64`): the run that changed the platform. The model answered `{ "total_due": 102918.69 }`, exactly the reference, but without the \`\`\`json fence the prompt asks for, so the first scoring marked it `ungradable`: "no fenced JSON block found in final response". The platform now takes a reply that is exactly one JSON object as the answer and says so in the inspector. A re-score of that stored run, with no new model call, made it `passed` (evaluation generation 2).

No run of the official experiment ended in an execution error. The calibration had three, all `Gateway starting: deadline`: Hermes could not start in time while the machine ran a full test suite at the same moment (load average 35). Retried on an idle machine, all three passed.

### How each run was started

From the launch record of every run, exactly as the worker ran it inside the trial container (the API key is the run's own token, revoked when the run ended):

```
hermes chat --query-file /opt/data/task.txt --oneshot --format stream-json \
  --provider nous -m openai/gpt-6.1-sol \
  --base-url http://egress:8080/v1 --api-key ‹run token, revoked› \
  -t file,terminal --max-turns 30 --yolo --in /workspace
```

The candidate adds `-s invoice-method`. To run the experiment yourself: start the platform, connect Nous Portal on the System page (or set an API-key provider and a real judge in `.env`), and launch `invoices-v1` with `invoices-v1-baseline` and `invoices-v1-with-skill` at 5 repetitions. It cost $1.02 here.

## 2. The other suites on the real model

One repetition per task and configuration on the four capability suites (82 runs, $1.52), to see which tasks tell the configurations apart. One repetition gives no interval; these are first readings, not verdicts.

| Suite          | Configurations, passed of tasks                                        | Where the dimension mattered                                                                                                                                                                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools-v1`     | `file` 3/6 · `file` + `terminal` 6/6 · + `code_execution` 6/6          | `reshape_json`, `checksum` and `join_three` need a terminal. Code execution adds nothing over a terminal that can already run Python.                                                                                                                                                                                                         |
| `knowledge-v1` | none 6/8 · documents 8/8 · skills preloaded 8/8 · skills on demand 8/8 | `reason_codes` (the code table) and `house_summary` (the house style, failed by the judge at 0.3 without it) need the knowledge. The model works out most of the invented BX-7 format from the data alone. Skills found on demand did as well as preloaded ones.                                                                              |
| `memory-v1`    | memory off 5/8 · memory on 7/8                                         | `vendor_alias`, `standing_exclusion` and `needle` need the remembered facts.                                                                                                                                                                                                                                                                  |
| `mcp-v1`       | the data as files 8/8 · through MCP 8/8                                | None: the model handled the same data equally well as files and through the two MCP servers, paged through all 120 invoices, and ignored the instruction planted in a vendor's notes in both arms (through MCP, Hermes marks a tool result as untrusted; read from a file, the note arrives unmarked, and the model ignored it all the same). |

Two of the `memory-v1` readings found real problems, both fixed before the official experiment:

- **Memory off was not memory off.** In `usual_currency` with memory off, the agent searched its home folder, found `memories/USER.md` and read it with its file tools, and passed. Seeded memory files are now placed in a run only when memory is on, and memory files are collected only then.
- **The agent remembered in a skill.** In `remember_this` with memory on, the agent saved the preference as a new skill file, `skills/vendor-email-drafting/SKILL.md`, which Hermes's own tool descriptions steer it towards, so the check of its memory found nothing. The task now asks it to save the preference in its memory.

Calibration also shows which tasks are too easy for this model: every `mcp-v1` task, and the tasks that every configuration passed in the other suites. They still test the platform's plumbing, but they do not separate configurations on GPT-6.1 Sol.

## 3. What the real model changed in the platform

Running real models found four problems that the scripted mock could not:

| Found                                                                       | Fixed                                                                                                |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A correct answer without its \`\`\`json fence was ungradable                | A reply that is exactly one JSON object is the answer, marked unfenced                               |
| With memory off, the agent read the seeded memory files with its file tools | Seeds and memory collection only with memory on                                                      |
| The agent saved a preference as a skill, not a memory                       | `memory-v1` `remember_this` asks for its memory                                                      |
| The judge defaulted to the mock even for real-model experiments             | A real judge is configured for real experiments, and New experiment warns when the judge is the mock |

## 4. Total spent

|                                                           | Runs    | Cost      |
| --------------------------------------------------------- | ------- | --------- |
| Dry run (`invoices-v1`, 3 tasks)                          | 6       | $0.10     |
| Calibration (four suites)                                 | 82      | $1.52     |
| Official experiment                                       | 120     | $1.02     |
| A task written in the browser, run on both configurations | 2       | $0.003    |
| **Total**                                                 | **210** | **$2.63** |

At OpenAI's list price for GPT-6.1 Sol, judge calls included.
