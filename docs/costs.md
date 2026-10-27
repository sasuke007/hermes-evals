# Costs

What it costs to run Hermes Evals, measured on the real model in October 2026. There are two kinds of cost: the model calls, which you pay your provider for, and the machine that runs the platform, which is your own.

## 1. Model calls

### The formula

Every model call goes through egress, which meters its tokens per run. A run's cost is its tokens times the price table in [`config/prices.yaml`](../config/prices.yaml), frozen into each experiment when it launches:

```
cost = uncached input × input price
     + cached input   × cache-read price
     + cache writes   × cache-write price
     + output         × output price
```

The model used here is GPT-6.1 Sol (`openai/gpt-6.1-sol`), reached through Nous Portal, at OpenAI's published standard-tier rates (checked 27 Oct 2026):

| Per 1 million tokens | Input | Cached input | Cache write | Output |
| -------------------- | ----- | ------------ | ----------- | ------ |
| GPT-6.1 Sol          | $2.00 | $0.10        | $2.50       | $10.00 |

Nous Portal's own price page could not be read on that date, so these are estimates at OpenAI's list price. A model missing from the table shows its cost as "—", and the spend ceiling counts its runs as unpriced, never as free.

### What a run costs

Measured on 88 real runs: 6 in the dry run on `invoices-v1` and 82 in the calibration of the four capability suites (one run per task and configuration). The official experiment's 120 runs on `invoices-v1` came out a little cheaper: $0.0085 a run on average, median 20 s and about 20,000 tokens.

| Suite                            | Runs   | Median time | Median tokens | Mean cost per run | Highest    |
| -------------------------------- | ------ | ----------- | ------------- | ----------------- | ---------- |
| `invoices-v1` (dry run, 3 tasks) | 6      | 35 s        | 20,500        | $0.016            | $0.021     |
| `mcp-v1`                         | 16     | 28 s        | 19,224        | $0.014            | $0.045     |
| `memory-v1`                      | 16     | 25 s        | 18,744        | $0.013            | $0.019     |
| `knowledge-v1`                   | 32     | 28 s        | 30,913        | $0.019            | $0.051     |
| `tools-v1`                       | 18     | 22 s        | 16,974        | $0.025            | $0.135     |
| **All**                          | **88** | **25 s**    | **21,900**    | **$0.018**        | **$0.135** |

What moves the cost:

- **Missing tools cost more.** `tools-v1` without a terminal cost $0.050 a run on average and up to $0.135, because the agent paged through large files with `read_file`; the same tasks with a terminal cost $0.011 to $0.015.
- **Knowledge saves exploration.** `knowledge-v1` with no documents or skills cost $0.023 a run and took 43 s; with the skills preloaded, $0.015 and 20 s.
- **Prompt caching.** Most of a run's input is the same system prompt and history sent again on each turn; the provider reads it from its cache at a twentieth of the price. A setting that changes the prompt at the start of the run (for example seeded memory in the system prompt) can change how much is cached, so two runs with similar token counts can differ in cost.

### The LLM judge

`llm_judge` checks call the platform's judge, also GPT-6.1 Sol through egress: about 1,100 to 1,400 tokens and $0.003 a call. Two of the 42 sample tasks have one (`invoices-v1` `disputed` and `knowledge-v1` `house_summary`). A re-score calls the judge again; nothing else in a re-score calls a model.

### What an experiment costs

Runs × mean cost per run, which New experiment estimates before you launch, from the median tokens of earlier runs on the same suite (or from the time budget when there are none):

| Experiment                                                                          | Runs | Measured                                                              |
| ----------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------- |
| Dry run: `invoices-v1`, 3 tasks × 2 configurations × 1 repetition                   | 6    | $0.10                                                                 |
| Calibration: the four capability suites, 1 repetition per task and configuration    | 82   | $1.52                                                                 |
| The official experiment: `invoices-v1`, 12 tasks × 2 configurations × 5 repetitions | 120  | $1.02 ($0.48 without the skill, $0.54 with it, $0.02 of it the judge) |

Set a spend ceiling on every real experiment: the worker pauses the experiment when the spent cost reaches it, and you can raise it and resume.

## 2. The machine

The platform runs on your own machine; nothing is hosted.

| Resource    | Measured                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| Memory      | about 2.2 GB for the whole stack while an experiment runs (Colima VM peak); the VM is given 6 GB     |
| Disk        | about 10 GB for images, plus the database, blobs and kept trial workspaces as experiments accumulate |
| First build | 2 minutes on a fast connection, 11 minutes at about 3 MB/s (Hermes's image is 1.1 GB)                |
| CPU         | 4 cores run 3 trials at once; each trial is capped at 1 CPU and 1.5 GB                               |

Running trials while the machine is busy with something heavy (a full test run, for example) can make Hermes miss its start-up deadline, which shows as an execution error with category `other`; retry those runs when the machine is idle.

## 3. With the mock model

Every test, smoke script and sample experiment can run against the scripted mock model, which costs nothing: `config/prices.yaml` prices it at zero. A fresh install starts with it.
