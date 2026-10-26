/**
 * knowledge-v1's four recommended arms, played without a stack the way the
 * mock model plays them (apps/egress/src/mock-model.ts): the first script
 * whose `match` occurs in the request answers it, with the step the number
 * of tool results so far picks, the last step repeated. Each request holds
 * what Hermes puts in it for that arm (each preloaded skill's SKILL.md, or
 * on demand only the skills index of names and descriptions), then the
 * prompt, then every call's arguments and result. A tool call is answered
 * from the files that arm's trial holds: the fixture in /workspace, the
 * documents in /workspace/docs, the skills in /opt/data/skills; bx7.py is
 * run for real with python3.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { z } from 'zod';
import {
  BX7_PY,
  BX7_PY_DOCUMENT,
  chosen,
  DOCUMENTS,
  DOCUMENTS_DIR,
  frontMatter,
  listFiles,
  readText,
  SKILL_NAMES,
  SKILLS_DIR,
  SUITE_DIR,
  TASK_FILES,
  type MockScript,
  type TaskKey,
} from './support.js';

export const ARMS = ['none', 'docs', 'preload', 'on_demand'] as const;
export type Arm = (typeof ARMS)[number];
export const KNOWLEDGE_ARMS: readonly Arm[] = ['docs', 'preload', 'on_demand'];
/** Where the trial's home keeps the skills, in both loading modes. */
const SKILLS_HOME = '/opt/data/skills';

export type Step = MockScript['steps'][number];
export type ToolStep = Extract<Step, { tool: string }>;
export const isTool = (step: Step): step is ToolStep => 'tool' in step;

export interface Played {
  /** The `match` of the script that answered each request, in order. */
  matches: string[];
  /** Each request's text, as the mock searches it, in order. */
  requests: string[];
  calls: { name: string; input: Record<string, unknown>; output: string }[];
  finalText: string;
}

/** Every file of the three skills, by its path under samples/skills (`bx7-format/SKILL.md`). */
export async function readSkills(): Promise<Map<string, string>> {
  const skills = new Map<string, string>();
  for (const name of SKILL_NAMES) {
    for (const file of await listFiles(join(SKILLS_DIR, name))) {
      skills.set(`${name}/${file}`, await readText(SKILLS_DIR, name, file));
    }
  }
  return skills;
}

/** What the trial of `arm` holds for task `key`: absolute path → text. */
async function trialFiles(
  arm: Arm,
  key: TaskKey,
  skills: ReadonlyMap<string, string>,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const file = TASK_FILES[key].file;
  files.set(`/workspace/${file}`, await readText(SUITE_DIR, key, 'fixtures', file));
  if (arm === 'docs') {
    for (const { doc } of DOCUMENTS) {
      files.set(`/workspace/docs/${doc}`, await readText(DOCUMENTS_DIR, doc));
    }
  }
  if (arm === 'preload' || arm === 'on_demand') {
    for (const [path, text] of skills) files.set(`${SKILLS_HOME}/${path}`, text);
  }
  return files;
}

/**
 * What Hermes adds to the first request: each preloaded skill's SKILL.md
 * with its folder (agent/skill_commands.py), or on demand only the index of
 * names and descriptions (agent/system_prompt.py).
 */
export function hermesPrompt(arm: Arm, skills: ReadonlyMap<string, string>): string {
  const skillMd = (name: string) => skills.get(`${name}/SKILL.md`)!;
  if (arm === 'preload') {
    return SKILL_NAMES.map(
      (name) =>
        `[IMPORTANT: The user launched this CLI session with the "${name}" skill preloaded.]\n\n` +
        `${skillMd(name)}\n[Skill directory: ${SKILLS_HOME}/${name}]`,
    ).join('\n\n');
  }
  if (arm === 'on_demand') {
    return SKILL_NAMES.map((name) => `- ${name}: ${frontMatter(skillMd(name)).description}`).join(
      '\n',
    );
  }
  return '';
}

/** A file as Hermes's read_file returns it: numbered lines, as JSON. */
const numbered = (text: string) =>
  JSON.stringify({
    content: text
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(6)}|${l}`)
      .join('\n'),
  });

/** The repository file a trial path stands for, to run it for real. */
function realPath(key: TaskKey, path: string): string {
  if (path === `${SKILLS_HOME}/bx7-format/scripts/bx7.py`) return BX7_PY;
  if (path === '/workspace/docs/bx7.py') return BX7_PY_DOCUMENT;
  return join(SUITE_DIR, key, 'fixtures', path.replace('/workspace/', ''));
}

/** The mock's commands, run against the trial's files: `cat` and `python3`, each alternative of `||`. */
function terminal(key: TaskKey, files: ReadonlyMap<string, string>, command: string): string {
  for (const alternative of command.split(' || ')) {
    const [program, target, ...args] = alternative.replace(' 2>/dev/null', '').split(' ');
    if (!target || !files.has(target)) continue;
    if (program === 'cat') return JSON.stringify({ output: files.get(target), exit_code: 0 });
    if (program === 'python3') {
      const glob = (arg: string) =>
        arg === '/workspace/*.bx*'
          ? [...files.keys()].filter((p) => /^\/workspace\/[^/]*\.bx[^/]*$/.test(p))
          : [arg];
      const run = spawnSync(
        'python3',
        [realPath(key, target), ...args.flatMap(glob).map((p) => realPath(key, p))],
        { encoding: 'utf8', env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } },
      );
      return JSON.stringify({ output: run.stdout + run.stderr, exit_code: run.status });
    }
  }
  return JSON.stringify({
    output: `${command.split(' ')[0]}: No such file or directory`,
    exit_code: 1,
  });
}

/** One tool call as the arm's trial answers it. */
function answer(
  arm: Arm,
  key: TaskKey,
  files: ReadonlyMap<string, string>,
  skills: ReadonlyMap<string, string>,
  step: ToolStep,
): string {
  const args = step.arguments;
  if (step.tool === 'skill_view') {
    if (arm !== 'on_demand') return JSON.stringify({ error: 'Unknown tool: skill_view' });
    const name = z.string().parse(args.name);
    const text = skills.get(`${name}/SKILL.md`);
    if (!text) return JSON.stringify({ success: false, error: `Skill '${name}' not found.` });
    return JSON.stringify({
      success: true,
      name,
      description: frontMatter(text).description,
      content: text,
      skill_dir: `${SKILLS_HOME}/${name}`,
    });
  }
  if (step.tool === 'read_file') {
    const path = z.string().parse(args.path);
    const text = files.get(path);
    return text === undefined
      ? JSON.stringify({ error: `File not found: ${path}` })
      : numbered(text);
  }
  if (step.tool === 'terminal') return terminal(key, files, z.string().parse(args.command));
  throw new Error(`the mock calls ${step.tool}, which no arm has`);
}

/** Plays one run of `key` in `arm`, whose prompt is `prompt`, as the mock model would. */
export async function play(
  scripts: readonly MockScript[],
  skills: ReadonlyMap<string, string>,
  arm: Arm,
  key: TaskKey,
  prompt: string,
): Promise<Played> {
  const files = await trialFiles(arm, key, skills);
  const transcript = [hermesPrompt(arm, skills), prompt];
  const out: Played = { matches: [], requests: [], calls: [], finalText: '' };
  for (let n = 0; n < 10; n += 1) {
    const text = transcript.join('\n');
    const script = chosen(scripts, text);
    if (!script) throw new Error(`${arm}/${key}: no script answers request ${n + 1}`);
    out.matches.push(script.match);
    out.requests.push(text);
    const step = script.steps[Math.min(n, script.steps.length - 1)]!;
    if (!isTool(step)) {
      out.finalText = step.content;
      return out;
    }
    const output = answer(arm, key, files, skills, step);
    out.calls.push({ name: step.tool, input: step.arguments, output });
    // Each later request holds the call's arguments and its result.
    transcript.push(JSON.stringify(step.arguments), output);
  }
  throw new Error(`${arm}/${key}: no answer after 10 requests`);
}
