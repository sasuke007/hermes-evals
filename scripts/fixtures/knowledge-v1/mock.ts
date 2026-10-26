/**
 * knowledge-v1's mock scripts (scripts/phase6b-knowledge-v1-mock-scripts.json,
 * plan 18.5 step 3, Phase 6b R8): the four recommended arms (none, the
 * documents, the skills preloaded, the skills on demand) differ only in
 * whether the knowledge reaches a request, and the scripts answer right only
 * once it has.
 *
 * The mock plays the n-th step of the first script whose `match` occurs in a
 * request, n being the tool results so far, and repeats a script's last step
 * once it runs out (apps/egress/src/mock-model.ts). Every script after the
 * no-knowledge ones has a single step, so it plays the same step whatever n
 * it is entered at; the scripts chain through phrases the previous step's
 * result brings:
 *
 *   1. judges: house_summary's judge request, by the agent's title (the trap
 *      title first, as the reference's title is in every judge request);
 *   2. unrelated: read expenses.csv, then the right answer, in every arm;
 *   3. finals: a task's right answer, matched by what bx7.py printed for the
 *      task's own file, by codes.md's marker (reason_codes, which reads it)
 *      or by the template's marker (house_summary, which reads it);
 *   4. reads: reason_codes and house_summary read codes.md or the template
 *      once bx7.py has printed their file;
 *   5. the knowledge: the marker of bx7-format's SKILL.md body runs bx7.py on
 *      the workspace's statement;
 *   6. no knowledge yet: a task's prompt phrase opens the skill
 *      (skill_view), then the document, then reads the statement, then
 *      answers with the trap answer.
 *
 * How the marker of step 5 arrives: preloaded, in the prompt from the first
 * call; on demand, in skill_view's result; documents, in read_file's result
 * of docs/bx7-spec.md; none, never (skill_view does not exist and the
 * document is not there). Every command and path works in each arm, so the
 * same script serves all three knowledge arms.
 */
import type { Json } from '../invoices-v1/ledger.ts';
import { MARKERS } from './knowledge.ts';
import { HOUSE_REPLY_NOTE } from './report-tasks.ts';
import type { Task } from './tasks.ts';

/** bx7.py's line for a file it read (the reader prints it as `file <name>: format BX07, ...`). */
export const parserLine = (file: string): string => `file ${file}: format BX07,`;

/** The trial's paths: the home (skills) is /opt/data, the workspace /workspace. */
const SKILLS = '/opt/data/skills';
const DOCS = '/workspace/docs';
export const RUN_PARSER = `python3 ${SKILLS}/bx7-format/scripts/bx7.py /workspace/*.bx* 2>/dev/null || python3 ${DOCS}/bx7.py /workspace/*.bx*`;
export const READ_CODES = `cat ${SKILLS}/bx7-format/codes.md 2>/dev/null || cat ${DOCS}/codes.md`;
export const READ_TEMPLATE = `cat ${SKILLS}/house-style/templates/summary-template.md 2>/dev/null || cat ${DOCS}/summary-template.md`;
export const SPEC_DOCUMENT = `${DOCS}/bx7-spec.md`;

type Step = { tool: string; arguments: { [key: string]: Json } } | { content: string };
export type Script = { match: string; steps: Step[] };

const answerBlock = (value: Json): string => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const terminal = (command: string): Step => ({ tool: 'terminal', arguments: { command } });

function knowledgeReply(task: Task): string {
  const lead =
    task.key === 'house_summary'
      ? HOUSE_REPLY_NOTE
      : task.key === 'reason_codes'
        ? `I read ${task.file} with bx7.py and looked up the class of each reason code in codes.md.`
        : task.key === 'prompt_override'
          ? `I read ${task.file} with bx7.py and, as the prompt says, took W as money in and V as money out.`
          : `I read ${task.file} with bx7.py and applied the BX-7 rules.`;
  return `${lead}\n\n${answerBlock(task.reference)}`;
}

export function mockScripts(tasks: readonly Task[]): Script[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const task = (key: string) => byKey.get(key)!;
  const house = task('house_summary');
  const judge = (match: string, score: number, comment: string): Script => ({
    match,
    steps: [{ content: JSON.stringify({ score, comment }) }],
  });
  const unrelated = task('unrelated');
  const statements = tasks.filter((t) => t.statement);
  const answeredByParser = statements.filter(
    (t) => t.key !== 'reason_codes' && t.key !== 'house_summary',
  );
  return [
    judge(
      String(house.trap.answer['title']),
      0.2,
      'The figures are there, but the title, the dates and the amounts ignore the house style.',
    ),
    judge(
      String(house.reference['title']),
      0.9,
      'The title, the dates, the amounts and the layout follow the house style, and the figures match the reference.',
    ),
    {
      match: unrelated.phrase,
      steps: [
        { tool: 'read_file', arguments: { path: `/workspace/${unrelated.file}` } },
        {
          content: `I added up the September travel claims of ${unrelated.file}.\n\n${answerBlock(unrelated.reference)}`,
        },
      ],
    },
    ...answeredByParser.map((t): Script => ({
      match: parserLine(t.file),
      steps: [{ content: knowledgeReply(t) }],
    })),
    { match: MARKERS.codes, steps: [{ content: knowledgeReply(task('reason_codes')) }] },
    { match: MARKERS.template, steps: [{ content: knowledgeReply(house) }] },
    { match: parserLine(task('reason_codes').file), steps: [terminal(READ_CODES)] },
    { match: parserLine(house.file), steps: [terminal(READ_TEMPLATE)] },
    { match: MARKERS.bx7, steps: [terminal(RUN_PARSER)] },
    ...statements.map((t): Script => ({
      match: t.phrase,
      steps: [
        { tool: 'skill_view', arguments: { name: 'bx7-format' } },
        { tool: 'read_file', arguments: { path: SPEC_DOCUMENT } },
        { tool: 'read_file', arguments: { path: `/workspace/${t.file}` } },
        { content: `Here is my reading of ${t.file}.\n\n${answerBlock(t.trap.answer)}` },
      ],
    })),
  ];
}
