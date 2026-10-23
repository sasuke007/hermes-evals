# UI Design Brief: Hermes Evals Platform

You are designing the complete user interface for an internal tool called the Hermes Evals Platform. Design every screen, every component, every state, and the flows between them. For each screen, explain what the user is trying to do there, what they see first, what they can act on, and where they go next. Produce the design as a component library plus annotated screens, so a frontend engineer building it in Vue 3 can implement it without guessing.

Read this whole brief before designing. The product context, terminology and data shapes below are fixed. The visual direction, layout and interaction details are yours to decide within the constraints in section 2.

---

## 1. Product context

### What the product does

Engineers build AI agents on an open-source agent runtime called Hermes Agent. When they change something about the agent, such as the model, a skill, a memory setting, a tool or an MCP server, they need to know whether the agent got better, got worse, or stayed the same. This platform answers that question with evidence.

The platform:

1. Holds a set of **tasks**, each with a prompt, fixture files, a hidden reference answer and a verification definition.
2. Holds **configurations** of the agent to compare: model, provider, toolsets, memory on or off, skills, documents, MCP servers.
3. Runs every task under every configuration, several times each, in isolated environments. Each of these runs is a **run**.
4. Scores each run against the task's verification definition.
5. Compares configurations and states a **verdict** with a confidence interval: better, worse, or inconclusive.
6. Lets the user open any single run and see exactly why it passed or failed.

### Who uses it

One user type: a software engineer who works on AI agents. They are technical, comfortable with YAML and JSON, and impatient with decoration. They use the tool in sessions of two kinds: setting up an experiment (ten minutes of form work), and reading results (anything from a glance at a verdict to an hour digging through runs).

### The core promise

Every number on screen must be traceable to evidence. A verdict links to per-task results; a per-task result links to runs; a run links to the exact tool calls, output and files that produced the score. The UI's job is to make that chain of evidence obvious and fast to follow.

### What it is not

It is not a chat interface. It is not a general observability product. It is not multi-tenant, has no login, no roles, no billing. Do not design any of those.

---

## 2. Constraints

- **Stack**: Vue 3 with TypeScript. Design components that map cleanly to Vue single-file components. Name them.
- **Desktop first**, minimum width 1280px for the full layout. Below 1024px the layout may collapse to a single column; it does not need to be optimised for phones, but nothing may break.
- **Light and dark theme**, both designed with equal care. Status colours (pass, fail, error, ungradable, running, queued) must read correctly in both.
- **Data density**: this is a tool for reading many numbers. Prefer tables, grids and compact rows over cards and whitespace. Use tabular figures for all numbers.
- **No decorative illustration, no emoji, no stock imagery.** Icons are allowed where they carry meaning.
- **Real content only.** Use the sample data in section 7 in every mockup. No lorem ipsum, no "Task 1", no placeholder names.
- **Long-running work is normal.** An experiment takes 20 to 60 minutes. The UI must make progress visible without the user refreshing, and must look correct both while work is in flight and after it finishes.
- **Local tool.** It runs on the engineer's own machine via Docker Compose. There is one user and no concurrent editing to handle.

---

## 3. Terminology

Use these words exactly, in the UI and in your annotations. Do not invent synonyms.

| Term           | Meaning                                                                                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Suite          | A versioned collection of tasks, loaded from files on disk. Read-only in the UI.                                                                                                                     |
| Task           | One prompt plus fixtures plus a reference answer plus verification entries. Belongs to one suite.                                                                                                    |
| Verification   | The list of checks a task defines. Each has a key, a type and parameters. Types: `numeric_tolerance`, `json_match`, `exact_match`, `file_check`, `trajectory_match`, `verifier_script`, `llm_judge`. |
| Resource       | An uploaded or defined thing a configuration can include. Three kinds: skill, document, MCP server.                                                                                                  |
| Configuration  | A named record of how the agent is set up: model, provider, toolsets, memory flag, skills, documents, MCP servers, turn limit, time budget.                                                          |
| Experiment     | A frozen combination of one suite (or a subset of its tasks), two or more configurations, and a repetition count. Creating it generates runs.                                                        |
| Baseline       | The configuration in an experiment that others are compared against.                                                                                                                                 |
| Candidate      | Any non-baseline configuration in an experiment.                                                                                                                                                     |
| Run            | One task, under one configuration, for one repetition. Has a status and, once scored, score rows.                                                                                                    |
| Attempt        | One execution try of a run. A run normally has one attempt; a retried execution error has two or more.                                                                                               |
| Score          | One named result for one run: key, score (0 to 1), status, comment, evidence references.                                                                                                             |
| Status (run)   | `queued`, `running`, `executed`, `scoring`, `scored`, `execution_error`, `cancelled`.                                                                                                                |
| Status (score) | `passed`, `failed`, `error`, `ungradable`.                                                                                                                                                           |
| Verdict        | The comparison result for a candidate against the baseline: `better`, `worse`, `inconclusive`, plus the interval.                                                                                    |
| Trial home     | The isolated environment a run executed in. Shown in the run inspector's launch record.                                                                                                              |

---

## 4. Information architecture

Top-level navigation, in this order:

1. **Experiments** (default landing page)
2. **Suites**
3. **Configurations**
4. **Resources**

Everything else is reached by drilling down:

```
Experiments
├── Experiment list
├── New experiment (form)
└── Experiment detail
    ├── Overview tab (progress while running, verdict when done)
    ├── Comparison tab (baseline vs candidate, task grid)
    ├── Runs tab (filterable table of all runs)
    └── Run inspector (drawer or full page, opened from any run reference anywhere)

Suites
├── Suite list
└── Suite detail
    └── Task detail (prompt, fixtures, verification, reference, validity status)

Configurations
├── Configuration list
├── New / edit configuration (form)
└── Configuration detail (fields, experiments that used it)

Resources
├── Resource library (tabs: Skills, Documents, MCP servers)
├── Upload skill / Upload document (dialog)
└── Define MCP server (form)
```

Design a persistent left sidebar or top bar for the four sections, your choice, but justify it. The run inspector is opened from many places (comparison grid, runs table, experiment overview), so decide whether it is a right-hand drawer over the current page or a full page with a back link, and keep that decision consistent.

---

## 5. Screens

For every screen below, deliver: the layout, every component on it, the empty state, the loading state, the error state, and the in-progress state where one exists. Annotate what each element does and where it leads.

### 5.1 Experiment list

**Purpose**: find a past experiment, see at a glance which ones are running, start a new one.

**Shows**: a table of experiments, newest first. Columns: name, suite and version, configurations (baseline name, then candidate names), repetitions, total runs, progress (e.g. 87 / 120 scored), status (`draft`, `running`, `paused`, `completed`, `failed`), verdict summary for completed ones (one chip per candidate: better / worse / inconclusive), created date, estimated cost so far.

**Actions**: New experiment (primary button). Row click opens the experiment detail. Running experiments show a live progress bar in the row.

**Empty state**: no experiments yet. Explain in two sentences what an experiment is and show the New experiment button.

### 5.2 New experiment

**Purpose**: choose what to run and how much. This is the most important form in the product. The user must understand the size and cost of what they are about to launch before they launch it.

**Sections, in order**:

1. **Name and description.** Name is required.
2. **Suite and tasks.** Select one suite. Then a task list with checkboxes, all selected by default. Each task row shows its id, a one-line summary, the number of verification entries, and a validity indicator (tasks that failed self-check are shown but cannot be selected; explain why on hover).
3. **Configurations.** Pick two or more from the configuration list. One must be marked as baseline. Show each chosen configuration as a compact summary row: model, skills count, MCP servers count, memory on/off. Provide a "compare side by side" expander that shows the chosen configurations as columns with one row per field, highlighting fields that differ. This diff view is important: it is how the user confirms the experiment is controlled.
4. **Repetitions.** A number input, default 5, minimum 1. When set to 1, show an inline warning that a single repetition cannot produce a confidence interval.
5. **Limits.** Concurrency (default 3). Spend ceiling in USD (optional). Per-run time budget override (optional, defaults to each task's own limit).
6. **Summary and launch.** A live summary panel, always visible (sticky), that recomputes as the form changes: number of tasks × configurations × repetitions = total runs; estimated duration based on concurrency and a per-run estimate; estimated cost from a price table. The launch button is here. It is disabled until the form is valid, with the reason shown.

**After launch**: navigate to the experiment detail, Overview tab, showing live progress.

### 5.3 Experiment detail: Overview tab

**Purpose while running**: show progress and let the user pause, resume or cancel.

**Purpose when complete**: show the verdict for every candidate against the baseline, and the headline numbers.

**While running, shows**: progress bar (runs scored / total); a breakdown by status as counts (queued, running, executed, scoring, scored, execution_error); per-configuration progress; a live feed of the last ten run completions (task id, configuration, pass or fail, duration); elapsed time; spend so far against ceiling. Controls: Pause, Resume, Cancel (cancel requires a confirmation step built into the page, not a browser dialog).

**When complete, shows**: one verdict card per candidate. Each card: candidate name versus baseline name; pass rate of each; the difference with its 95% interval; the verdict word (better, worse, inconclusive) with a colour; counts of tasks improved, regressed, unchanged; a link to the Comparison tab. Below the cards: a table of per-configuration aggregates with columns pass rate, mean score, median duration, mean tokens, estimated cost, execution errors, ungradable runs.

**Also shows**: the frozen snapshot summary (suite version, configuration names with a "view as of this experiment" link, Hermes revision), so the user knows what was tested.

### 5.4 Experiment detail: Comparison tab

**Purpose**: understand where a difference comes from. This is the screen a sceptical reviewer spends the most time on.

**Controls at the top**: baseline selector (fixed to the experiment's baseline, but shown), candidate selector (when there are several candidates), score key selector (default: the primary key of each task; the user can switch to any key that all tasks share, or to "any key failed").

**Main element: the task grid.** One row per task. For each row: task id; the baseline's repetitions as a row of small cells, one per repetition, coloured by score status (passed, failed, error, ungradable); the baseline pass rate; the candidate's repetitions the same way; the candidate pass rate; the difference, signed and coloured. Rows are sortable by difference. A filter toggles: all tasks, improved only, regressed only, unchanged only.

Each repetition cell is clickable and opens the run inspector for that run. Hovering a cell shows task, configuration, repetition number, status, duration and the primary score comment.

**Below the grid**: the statistics panel. Observed mean difference, the 95% bootstrap interval, the number of bootstrap resamples, the verdict, and a one-paragraph plain-English explanation of how to read it, including that "inconclusive" is not "equivalent". Show the interval visually: a horizontal number line centred on zero with the interval drawn as a bar and the observed difference as a point.

**Secondary metrics**: a small table of duration, tokens and cost per configuration, and execution error counts, so the user can see whether a "win" is really a timeout difference.

### 5.5 Experiment detail: Runs tab

**Purpose**: find a specific run, or scan for problems.

**Shows**: a dense table of all runs. Columns: task id, configuration, repetition, attempt count, status, primary score status, duration, tokens, cost, finished time. Filters: configuration, task, run status, score status, "has execution error", "ungradable". Sort by any column. Row click opens the run inspector.

**Bulk actions**: re-score selected runs (never re-executes), retry execution for selected runs with execution errors.

### 5.6 Run inspector

**Purpose**: answer "why did this run pass or fail" in the order an engineer asks it.

**Header**: task id, configuration name, repetition and attempt, run status, duration, tokens in and out, estimated cost. Buttons: previous run and next run within the current filter; open the same task under the other configuration (a direct A/B jump); re-score; copy run id.

**Section 1, Outcome**: one row per score key. Each row: key, status chip, score value, expected value, observed value, the scorer's comment in full. If the status is error or ungradable, show the reason prominently (for example, "no fenced JSON block found in final response").

**Section 2, Timeline**: the sequence of events from the run. Each tool call is one expandable row: tool name (MCP tools show their server name as a prefix), a one-line input summary, duration, and an error flag. Expanding shows the full input and the output, with the output truncated to the first 5000 characters and a note that the runtime truncates it. Text events from the agent appear between tool calls as they occurred. The timeline must stay readable with 60 or more tool calls: consider a collapsed overview strip (one tick per event, coloured by type and error) above the detailed list, acting as a scrubber.

**Section 3, Final response**: the agent's complete final text, with the extracted JSON answer block highlighted and the parsed answer shown beside it.

**Section 4, Artifacts**: files the agent wrote in its workspace: path, size, hash, a preview for text and CSV, a download link.

**Section 5, Launch record**: the exact command flags, the configuration file that was written for this run, the skill names and content hashes, the MCP server definitions as written, the Hermes revision, and the trial home path. Collapsed by default.

**Failure states to design**: a run with status `execution_error` (show the stderr tail and the error category: provider, timeout, setup, cancelled); a run with status `running` (timeline grows live); a run that was cancelled mid-way.

### 5.7 Suite list and suite detail

**Suite list**: name, version, task count, number of valid tasks, last loaded time, a "reload from disk" action.

**Suite detail**: the task list with id, summary, verification types used (as chips), limits, validity status. A task that failed self-check shows the failure reason inline.

**Task detail**: the prompt, rendered as text; the fixtures list with preview; the verification entries each shown as a readable sentence derived from its type and params (for example, "json_match on `duplicates`, unordered, pass at 1.0") with the raw YAML available in an expander; the reference answer, clearly marked as hidden from the agent; the verifier script source if present; the self-check result and when it ran. A list of experiments that included this task, with its pass rate in each.

Tasks are read-only in the UI. Make that clear without making the screen feel broken. Include a small hint on where the files live on disk.

### 5.8 Configuration list, form and detail

**List**: name, model, provider, toolsets, memory on/off, skills (names), MCP servers (names), documents count, created date, number of experiments used in.

**Form (new and edit)**: name; model (text input with suggestions from a known list); provider (select); toolsets (multi-select chips from a fixed list); memory enabled (switch, default off, with a one-line note that the runtime's own default is on); skills (multi-select from the resource library, with an "upload new" shortcut); documents (same); MCP servers (same); max turns (number); time budget in seconds (number). Save creates a new version if the configuration has been used in an experiment, and the form says so.

**Detail**: the fields as a two-column definition list; the version history; experiments that used this configuration with its pass rate in each.

**Compare configurations**: from the list, select two or more and open a side-by-side diff with one column per configuration and one row per field, differing fields highlighted. This is the same component used in the New experiment form.

### 5.9 Resource library

Three tabs: Skills, Documents, MCP servers.

**Skills tab**: table of uploaded skills: name (from the skill's own metadata), version, description, content hash short form, uploaded date, used by N configurations. Upload action opens a dialog: drop a zip; the dialog shows validation results (found `SKILL.md`, parsed name and description, file count) before confirming. Clicking a skill shows its `SKILL.md` rendered and its file tree.

**Documents tab**: table: filename, size, type, hash, uploaded date, attached to (tasks and configurations). Upload is a simple file drop.

**MCP servers tab**: table: name, transport (`http` or `stdio`), endpoint or command, tool filter summary, defined date, used by N configurations. Define action opens a form: name; transport choice; for http: URL and optional headers; for stdio: command, arguments, environment variable names (values are supplied by the platform's secret store, never typed here, and the form says so); tool include and exclude lists; timeout. Beside the transport choice, a short explanation: http servers are hosted by the user and are not reset between runs; stdio servers are started fresh for every run inside the worker.

---

## 6. Flows to document end to end

Draw each as a sequence of screens with the user's action at each step and the system's response. Show the state of the data after each step.

**Flow A: first-time setup to first result.** Land on an empty Experiments page → go to Resources, upload a skill zip, see validation, confirm → go to Configurations, create `baseline` (no skills) and `with-skill` (the uploaded skill), everything else identical → open the compare view, confirm only the skills row differs → New experiment: pick the invoices suite, all 12 tasks, both configurations with `baseline` as baseline, 5 repetitions → read the summary panel (120 runs, estimated duration, estimated cost) → launch → watch Overview progress → experiment completes → verdict card shows `with-skill` better → open Comparison tab → sort by difference → click a failed baseline cell on `dup_invoices` → run inspector shows the scorer comment "expected 2 pairs, got 0" and a timeline with no `read_file` call → use "open same task under other configuration" → see the candidate's timeline with the file read and the correct answer.

**Flow B: investigating an inconclusive verdict.** Overview shows inconclusive → Comparison shows the interval crossing zero → the grid shows two tasks improved and two regressed → the user opens a regressed task's candidate runs → finds one is an execution error (timeout) rather than a wrong answer → goes to the Runs tab, filters execution errors, retries them → progress resumes → verdict updates.

**Flow C: testing with and without an MCP server.** Define an MCP server with the stdio transport → create configuration `with-mcp` that includes it, and `baseline` without → New experiment → in the run inspector of a `with-mcp` run, the timeline shows tool calls prefixed with the server name → a task whose verification includes `trajectory_match` shows a passed score for the tool use requirement.

**Flow D: a broken check.** A task's verifier script fails its self-check after a suite reload → the task shows as invalid in the suite detail with the script's output → in New experiment the task is shown but cannot be selected, with the reason on hover.

---

## 7. Sample data to use in every mockup

Use these names and numbers verbatim. The numbers are illustrative and consistent with each other.

**Suite**: `invoices-v1`, 12 tasks:
`total_due`, `overdue_list`, `dup_invoices`, `vat_split`, `credit_notes`, `currency_mix`, `missing_po`, `late_fees`, `per_vendor`, `disputed`, `partial_pay`, `summary_file`.

**Configurations**:

- `baseline`: model `openai/gpt-6.1-sol`, provider `nous`, toolsets `file, terminal`, memory off, no skills, no MCP servers, max turns 20, budget 300 s.
- `with-skill`: identical plus skill `invoice-method`.
- `with-mcp`: identical to baseline plus MCP server `invoice-db` (stdio).

**Experiment**: `Skill vs no skill, invoices-v1`, 12 tasks × 2 configurations × 5 repetitions = 120 runs, concurrency 3, completed.

**Per-task pass rates** (baseline, with-skill):

```
total_due     1.00  1.00
overdue_list  0.60  1.00
dup_invoices  0.20  0.80
vat_split     0.80  1.00
credit_notes  0.20  0.60
currency_mix  0.80  1.00
missing_po    1.00  1.00
late_fees     0.20  0.60
per_vendor    1.00  1.00
disputed      0.20  0.40
partial_pay   0.60  0.80
summary_file  1.00  1.00
```

Aggregate: baseline 0.633, with-skill 0.850, difference +0.217, 95% interval [+0.117, +0.333], verdict better, 8 improved, 0 regressed, 4 unchanged. Median duration 48 s baseline, 61 s with-skill. Mean tokens 14,200 baseline, 19,800 with-skill. Estimated cost $0.71 baseline, $0.98 with-skill. Execution errors: 1 baseline, 0 with-skill. Ungradable: 2 baseline, 0 with-skill.

**A sample run** for the inspector: task `dup_invoices`, configuration `baseline`, repetition 3, status scored, primary score `answer` failed with comment "expected 2 duplicate pairs, got 0; agent compared invoice numbers only". Timeline: `terminal` (`head invoices.csv`, 0.4 s), `terminal` (`python3 -c "..."`, 1.2 s, error: `KeyError: 'vendor'`), `terminal` (retry, 1.1 s), text, final response. Tokens 11,400 in, 1,900 out. Duration 52 s.

**Resources**: skill `invoice-method` v1.0.0, "Method for reconciling vendor invoices: always check credit notes, duplicates and partial payments before totalling". MCP server `invoice-db`, stdio, `npx invoice-db-mcp`, tools included `list_invoices, get_invoice`. Document `vendor-policy-v3.pdf`, 214 KB.

---

## 8. Component library to deliver

Name each component as it would appear as a Vue file. At minimum:

- `AppShell` with navigation and theme toggle
- `DataTable` with sorting, filtering, column density, row selection, sticky header
- `StatusChip` for run status and score status, with the full colour set in both themes
- `VerdictCard`
- `IntervalBar` (number line with interval and point)
- `RepetitionCells` (the row of small coloured cells)
- `TaskGrid` (composed of the above)
- `ConfigDiffTable` (side-by-side configuration comparison)
- `ExperimentSummaryPanel` (the sticky live summary on the new experiment form)
- `ProgressBreakdown` (runs by status)
- `RunInspector` with its five sections
- `EventTimeline` and `TimelineScrubber`
- `JsonBlock` with highlighted extracted answer
- `VerificationSentence` (a verification entry rendered as readable text)
- `ResourceUploadDialog` with validation step
- `McpServerForm`
- `ConfirmInline` (a confirmation step rendered in the page, since browser dialogs are not available)
- `EmptyState`, `ErrorBanner`, `LiveIndicator` (shows that a page is receiving live updates)

For each: props in plain language, states, and an example with the sample data.

---

## 9. What to explain in your output

For every screen and flow, write the explanation an engineer needs: what the user is doing, what they see first and why, what each control does, what happens on success and on failure, and what changes while work is in progress. Where you made a layout or interaction choice that could have gone another way, say what you chose and why in one or two sentences.

Deliver the visual direction (palette with hex values for both themes, type scale, spacing scale, density rules) before the screens, so that everything after it is consistent.
