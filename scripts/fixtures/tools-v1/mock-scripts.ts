/**
 * The mock model's scripts for the tools-v1 experiment (plan 18.5 step 3),
 * written to scripts/phase6b-tools-v1-mock-scripts.json. The mock plays the
 * n-th step of the first script whose `match` occurs in a request, n being
 * the tool results so far (apps/egress/src/mock-model.ts), so the outcome
 * scripts come first: they take over once a tool result brings their phrase.
 *
 * Each task's prompt script (matched by `tv1-<key>.`, which only its prompt
 * holds) tries the strongest tool first:
 *
 *   0  execute_code: Python that prints `tv1-<key>-code=<value>`
 *   1  terminal: a command that prints `tv1-<key>-term=<value>`
 *   2… read_file of the task's files, write_file where the task writes one,
 *      then the answer the file tools alone give (the trap, or null)
 *
 * In an arm without the tool, Hermes answers the call with the tool error
 * "Tool '<name>' does not exist. Available tools: …" (a tool result, so n
 * moves on), and two such calls in a row stay under its limit of three
 * (agent/turn_tool_validation.py). The value after a marker is what the tool
 * printed from the fixtures, and the generator puts the right value in the
 * outcome script's `match`, so the right answer is played only when the
 * tool really ran and computed it; no request holds that text otherwise
 * (the call's own arguments hold the marker before a format, not the value).
 *
 * - file (`file`): execute_code and terminal fail, the file-only answer is
 *   played: every task fails but the control, small_lookup.
 * - file-terminal (`file`, `terminal`): execute_code fails, terminal prints
 *   its marker, the `-term=` script answers: every task passes.
 * - file-terminal-code (`file`, `terminal`, `code_execution`): execute_code
 *   prints its marker and the `-code=` script answers: every task passes,
 *   with no terminal call.
 *
 * small_lookup, the control, needs no tool beyond file in any arm: its
 * prompt script reads catalog.csv, and the target product's row, which only
 * that read brings, answers with its bin.
 */
import {
  codeMarker,
  promptPhrase,
  termMarker,
  type Json,
  type JsonObject,
  type ToolsTask,
} from './common.ts';

type Step = { tool: string; arguments: JsonObject } | { content: string };

const answer = (text: string, value: JsonObject): Step => ({
  content: `${text}\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``,
});

const workspace = (path: string): string => `/workspace/${path}`;

export function mockScripts(tasks: readonly ToolsTask[]): Json[] {
  const outcomes: Json[] = [];
  const prompts: Json[] = [];
  for (const t of tasks) {
    const fileSteps: Step[] = [
      ...t.fileOnly.reads.map((f) => ({ tool: 'read_file', arguments: { path: workspace(f) } })),
      ...Object.entries(t.fileOnly.writes ?? {}).map(([path, content]) => ({
        tool: 'write_file',
        arguments: { path: workspace(path), content },
      })),
      answer(t.fileOnly.text, t.fileOnly.answer),
    ];
    if (t.tools === null) {
      if (t.readPhrase === undefined)
        throw new Error(`${t.key}: a task without tools needs a readPhrase`);
      outcomes.push({
        match: t.readPhrase,
        steps: [answer('catalog.csv lists the product on this row.', t.reference)],
      });
      prompts.push({ match: promptPhrase(t.key), steps: fileSteps });
      continue;
    }
    outcomes.push(
      {
        match: `${codeMarker(t.key)}${t.tools.value}`,
        steps: [answer('I computed it with execute_code over the whole input.', t.reference)],
      },
      {
        match: `${termMarker(t.key)}${t.tools.value}`,
        steps: [answer('I computed it in the terminal over the whole input.', t.reference)],
      },
    );
    prompts.push({
      match: promptPhrase(t.key),
      steps: [
        { tool: 'execute_code', arguments: { code: t.tools.code } },
        { tool: 'terminal', arguments: { command: t.tools.command } },
        ...fileSteps,
      ],
    });
  }
  return [...outcomes, ...prompts];
}
