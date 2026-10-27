# Known limits

What the platform does not do, does only partly, or does with a caveat you should know before you trust a number. The design is in [design.md](design.md); each phase's own document in [phases/](phases/) lists its smaller limits and how each was settled.

## What the results can and cannot tell you

- **Small suites give wide intervals.** The interval comes from resampling tasks, so with 8 or 12 tasks it is wide: a real but modest gain often reads `inconclusive`. More repetitions narrow each task's pass rate; only more tasks narrow the spread between tasks. A verdict needs at least 3 tasks and 2 counted runs per task and configuration.
- **A verdict is about these tasks.** The bootstrap treats the suite's tasks as a sample of the work you care about. If the tasks are not representative, neither is the verdict.
- **Several candidates are compared one at a time.** Each candidate gets its own interval against the baseline; there is no correction for comparing many candidates at once, so with five candidates one may look better by chance.
- **Execution errors count as failures.** A run that broke (a provider outage, a timeout, the token cap) counts as not passed. The sensitivity figure beside each verdict shows the result without those runs, so you can tell an agent's answers from runs that broke, but the headline verdict includes them.
- **The judge is one model.** `llm_judge` checks are graded by the platform's judge (`JUDGE_PROVIDER`, `JUDGE_MODEL`), the same for every arm. When the judge is the same model family as the agent, it may favour its own style. A re-score grades with the judge configured at that moment.
- **The answer format is part of the task.** An answer is the last fenced `json` block of the final reply, or a reply that is nothing but one JSON object. A reply that puts the answer in prose is `ungradable`, which counts as not passed and is reported separately.
- **Money is compared exactly by `json_match`.** A model that prints `3339.4299999` instead of `3339.43` fails a `json_match` key; `numeric_tolerance` keys allow the declared tolerance.
- **`trajectory_match` matches argument values exactly**, so a path must be spelled as the agent sends it, and an MCP tool named as Hermes names it (`mcp__<server>__<tool>`).

## What a run can and cannot do

- **One Hermes revision.** Every run uses Hermes v0.22.4 at 4d04303. Results from a different revision are not comparable without re-running.
- **Each run starts from nothing.** No memory, session history or files carry over between runs. Memory is tested with seeded memory files and with what the agent saves within one run; recalling across sessions is not tested.
- **Tool output is cut twice.** Hermes truncates a tool's output before the model sees it, and its event stream, which the run timeline records, cuts every tool result at 5,000 characters. So the inspector can show less of a long tool result (an MCP page, a large file) than the model received.
- **No web or browser suite.** The `web` and `browser` toolsets work (egress opens public addresses for them), but no suite tests them: live pages change between runs, so references could not be computed, and Hermes's web search needs a search provider's key, which trials never receive.
- **The terminal reaches the whole container.** With the `terminal` toolset the agent can read anything in its own trial: its home, its workspace, the seeded memory files even with memory off, and the environment of its stdio MCP servers.
- **Stdio MCP servers are readable by the agent.** A stdio server runs inside the trial, so the values in its environment and the data it reads are readable by the agent; the UI labels each such variable "Readable by the agent". Stdio servers also have no network. A server that needs a secret kept from the agent, or a remote service, must be defined as http, where egress adds the header.
- **Remote MCP state is not reset.** The platform resets everything inside a trial, but not the state of a remote MCP server between runs.
- **Hermes's own background requests are refused.** Hermes makes one pricing request to Nous at start, which egress refuses; the run inspector shows it as a neutral "Hermes background" row. It happens the same way in every arm.
- **Caps are enforced by polling.** The disk cap (2 GiB or 50,000 files) is checked every second, so a fast writer can overshoot by about a second of writes; the token cap can be overshot by the model calls already in flight when it is reached.

## Scope and operation

- **One user, one machine, no login.** There is no authentication or access control. Every port is bound to 127.0.0.1.
- **Suites are trusted.** Verifier scripts are code. They run in their own container with no network, read-only inputs and no worker environment, and a zip import asks before it brings scripts in; but a suite is assumed to come from you or someone you trust. A verifier container still sees the trial image's own public `ENV` values.
- **Verifier scripts are Python only**, and need docker-guard: with no guard, no verifier runs.
- **Configurations and experiments are never deleted.** A configuration an experiment used stays forever, so evidence keeps its meaning, and every configuration appears in New experiment's list. There is no archive yet to hide old ones.
- **Unused blobs are not swept.** Zips validated but never imported, preview uploads and deleted documents stay in the blob store.
- **Suite-level files.** A suite's README at its root is kept on disk through saves, but a zip import leaves it out and a version download does not include it.
- **macOS file sharing.** On Colima and Docker Desktop, the worker sees `./suites` through the VM's file sharing, which can show a removed folder for about a second; the loader retries once before it records a folder as missing.
- **Tested on macOS only.** A clean install was tested on Colima and on Docker Desktop. Linux with native Docker should work (the README gives the folder permissions it needs) but is untested.
- **Costs are list prices.** A run's cost is its tokens times `config/prices.yaml`. GPT-6.1 Sol is priced at OpenAI's published rates; the platform reaches it through Nous Portal, whose own price page could not be read when the price was checked, so costs on that route are estimates. A model missing from the table shows its cost as "—" and the spend ceiling counts it as unpriced, never as free.
