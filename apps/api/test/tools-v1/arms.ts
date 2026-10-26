/**
 * The tools-v1 experiment's three arms, played without a stack: one task's
 * requests to the mock model, answered as Hermes v0.22.4 would answer each
 * tool call the scripts make. The mock plays the n-th step of the first
 * script whose `match` occurs in a request, n being the tool results so far
 * (apps/egress/src/mock-model.ts); a request holds the prompt, each call's
 * arguments and each tool result.
 *
 * - A tool the arm does not offer: Hermes's tool error "Tool '<name>' does
 *   not exist. Available tools: …" (agent/turn_tool_validation.py), and the
 *   run stops at the third such call in a row.
 * - execute_code and terminal: the scripted Python and shell really run, on
 *   a copy of the task's fixtures, with /workspace mapped to it.
 * - read_file: the first page, at most 2,000 numbered lines within 100,000
 *   characters (tools/file_tools.py); write_file writes the file.
 */
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  primaryKey,
  readText,
  scoreKey,
  SUITE_DIR,
  type LoadedSuite,
  type MockScript,
  type TaskKey,
} from './support.js';

/** The recommended arms' toolsets (suite.yaml): memory off, no skills, documents or MCP servers. */
export const ARM_TOOLSETS = {
  file: ['file'],
  'file-terminal': ['file', 'terminal'],
  'file-terminal-code': ['file', 'terminal', 'code_execution'],
} as const;

/**
 * The tools Hermes offers in each arm (toolsets.py: file is read_file,
 * write_file, patch and search_files; terminal adds terminal and
 * process_manage; code_execution adds execute_code).
 */
export const ARMS = {
  file: ['patch', 'read_file', 'search_files', 'write_file'],
  'file-terminal': [
    'patch',
    'process_manage',
    'read_file',
    'search_files',
    'terminal',
    'write_file',
  ],
  'file-terminal-code': [
    'execute_code',
    'patch',
    'process_manage',
    'read_file',
    'search_files',
    'terminal',
    'write_file',
  ],
} as const;
export type Arm = keyof typeof ARM_TOOLSETS;
export const ARM_NAMES = Object.keys(ARMS) as Arm[];

type ToolStep = Extract<MockScript['steps'][number], { tool: string }>;

/** What one played run left, graded. */
export interface Played {
  text: string;
  workspace: string;
  /** The calls Hermes ran, in order. */
  calls: { name: string; input: Record<string, unknown> }[];
  /** The calls Hermes refused: tools the arm lacks. */
  refused: string[];
  /** The script that answered each request. */
  answeredBy: string[];
  /** Each request's text, as the mock searches it, in order. */
  requests: string[];
  /** The primary key's status. */
  primary: string;
  /** reshape_json's verifier key, graded too. */
  quantities?: string;
}

/** What read_file shows from line 1, as the JSON Hermes hands back. */
export function readFilePage(text: string): string {
  const lines = text.replace(/\n$/, '').split('\n');
  const shown: string[] = [];
  let chars = 0;
  for (const [i, line] of lines.slice(0, 2000).entries()) {
    const width = `${i + 1}|${line}`.length + (shown.length > 0 ? 1 : 0);
    if (chars + width > 100_000) break;
    chars += width;
    shown.push(`${i + 1}|${line}`);
  }
  const more = shown.length < lines.length;
  return JSON.stringify({
    content: shown.join('\n'),
    total_lines: lines.length,
    ...(more ? { truncated: true, next_offset: shown.length + 1 } : {}),
  });
}

/** Runs one tool call on the workspace as the trial would; returns the result Hermes hands back. */
async function runTool(step: ToolStep, workspace: string): Promise<string> {
  const inWorkspace = (text: string) => text.replaceAll('/workspace', workspace);
  const shown = (text: string) => text.replaceAll(workspace, '/workspace');
  const args = step.arguments;
  switch (step.tool) {
    case 'execute_code': {
      const run = spawnSync('python3', ['-c', inWorkspace(z.string().parse(args.code))], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      const output = shown(run.stdout + run.stderr);
      return JSON.stringify({ status: run.status === 0 ? 'success' : 'error', output });
    }
    case 'terminal': {
      const run = spawnSync('bash', ['-c', inWorkspace(z.string().parse(args.command))], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      const output = shown(run.stdout + run.stderr).trimEnd();
      return JSON.stringify({ output, exit_code: run.status });
    }
    case 'read_file':
      return readFilePage(await readFile(inWorkspace(z.string().parse(args.path)), 'utf8'));
    case 'write_file': {
      const path = inWorkspace(z.string().parse(args.path));
      const content = z.string().parse(args.content);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
      return JSON.stringify({ bytes_written: Buffer.byteLength(content) });
    }
    default:
      throw new Error(`the scripts call ${step.tool}, which the arms do not play`);
  }
}

/**
 * Plays one task in one arm until the mock answers, in a copy of its
 * fixtures under `scratch`, and grades the reply and the workspace with
 * the real scorers.
 */
export async function play(
  scripts: readonly MockScript[],
  suite: LoadedSuite,
  key: TaskKey,
  arm: Arm,
  scratch: string,
): Promise<Played> {
  const workspace = join(scratch, key, arm);
  await cp(join(SUITE_DIR, key, 'fixtures'), workspace, { recursive: true });
  const messages = [await readText(SUITE_DIR, key, 'prompt.md')];
  const run: Omit<Played, 'primary'> = {
    text: '',
    workspace,
    calls: [],
    refused: [],
    answeredBy: [],
    requests: [],
  };
  let toolResults = 0;
  let refusedInARow = 0;
  for (let request = 1; request <= 20; request++) {
    const text = messages.join('\n');
    const script = scripts.find((s) => text.includes(s.match));
    if (!script) throw new Error(`${key} · ${arm}: no script answers request ${request}`);
    run.answeredBy.push(script.match);
    run.requests.push(text);
    const step = script.steps[Math.min(toolResults, script.steps.length - 1)]!;
    if ('content' in step) {
      const row = suite.byKey.get(key)!;
      const graded = { text: step.content, workspace, calls: run.calls };
      const primary = (await scoreKey(row, primaryKey(row), graded)).status;
      const quantities =
        key === 'reshape_json' ? (await scoreKey(row, 'quantities', graded)).status : undefined;
      return { ...run, text: step.content, primary, quantities };
    }
    messages.push(JSON.stringify(step.arguments));
    const offered: readonly string[] = ARMS[arm];
    if (offered.includes(step.tool)) {
      refusedInARow = 0;
      run.calls.push({ name: step.tool, input: step.arguments });
      messages.push(await runTool(step, workspace));
    } else {
      if (++refusedInARow >= 3) throw new Error(`${key} · ${arm}: Hermes stops at a third refusal`);
      run.refused.push(step.tool);
      messages.push(`Tool '${step.tool}' does not exist. Available tools: ${offered.join(', ')}`);
    }
    toolResults++;
  }
  throw new Error(`${key} · ${arm}: no answer after 20 requests`);
}
