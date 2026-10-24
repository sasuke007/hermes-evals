/**
 * The toolsets the trial image's Hermes offers (decision D6). The worker runs
 * `hermes tools list` in a throwaway trial container at start and stores the
 * enabled built-in toolsets on its `workers` row, so the configuration form
 * offers exactly what a trial can enable. HERMES_TOOLSETS in the shared
 * package is the fallback until a worker has reported.
 *
 * The container has the full trial shape (through docker-guard, uid 10000,
 * read-only image, fresh home and workspace) but no network at all: listing
 * toolsets needs none, so it takes no slot network away from a trial and
 * needs no egress registration.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newId } from '../database/ids.js';
import type { EngineClient } from './engine-client.js';
import { prepareTrialDirs, removeTrialDirs, runTrial } from './trial-runner.js';
import { TRIAL_HOME, type TrialSpec } from './trial-spec.js';

/** What listing needs from the sandbox; SandboxService satisfies it. */
export interface ToolsetDeps {
  engine: EngineClient;
  trialsDir: string;
  image: string;
  volume: string;
}

/** The listing takes about 2 s; this bounds a container that hangs. */
export const TOOLSET_LIST_DEADLINE_MS = 60_000;

const SECTION_HEADER = /^Built-in toolsets\b/;
/**
 * One row of the section, e.g. `  ✓ enabled  web  🔍 Web Search & Scraping`
 * or `  ✗ disabled  video  🎬 Video Analysis`. The mark is optional so that a
 * plain-text rendering parses too.
 */
const TOOLSET_ROW = /^\s+(?:\S+\s+)?(enabled|disabled)\s+(\S+)/;
/** A toolset name as Hermes prints it and as config.yaml takes it: `code_execution`. */
const TOOLSET_NAME = /^[a-z][a-z0-9_]*$/;
// oxlint-disable-next-line no-control-regex -- ESC is exactly what must be removed
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[A-Za-z]/g;

/**
 * The enabled toolsets of the "Built-in toolsets" section of `hermes tools
 * list`, in the order Hermes prints them. The section ends at a blank line or
 * the next unindented header ("Plugin toolsets (cli):"); plugin toolsets are
 * not offered. Throws when the section is missing, empty or has a row it
 * cannot read: the image is pinned, so a different format means something is
 * wrong, and guessing would offer toolsets that do not exist.
 */
export function parseToolsetList(output: string): string[] {
  const lines = output.replace(ANSI_ESCAPE, '').split(/\r?\n/);
  const start = lines.findIndex((line) => SECTION_HEADER.test(line));
  if (start < 0) throw new Error('`hermes tools list` printed no "Built-in toolsets" section');
  const enabled: string[] = [];
  let rows = 0;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || !/^\s/.test(line)) break;
    const match = TOOLSET_ROW.exec(line);
    const name = match?.[2];
    if (!match || !name || !TOOLSET_NAME.test(name)) {
      throw new Error(`unreadable "Built-in toolsets" row: ${line.trim()}`);
    }
    rows += 1;
    if (match[1] === 'enabled' && !enabled.includes(name)) enabled.push(name);
  }
  if (rows === 0) throw new Error('"Built-in toolsets" lists no toolset');
  return enabled;
}

/** The container that lists toolsets: a probe of the trial shape with no network. */
export function toolsetListSpec(
  deps: ToolsetDeps,
  attemptId: string,
  deadlineMs: number,
): TrialSpec {
  return {
    name: `hermes-evals-probe-${attemptId}`,
    runId: attemptId,
    attemptId,
    image: deps.image,
    volume: deps.volume,
    network: 'none',
    cmd: ['tools', 'list'],
    env: { HOME: TRIAL_HOME, HERMES_HOME: TRIAL_HOME, TMPDIR: '/tmp' },
    deadline: Math.floor((Date.now() + deadlineMs) / 1000) + 60,
  };
}

/**
 * Runs `hermes tools list` in a fresh trial container and returns the enabled
 * built-in toolsets. The container and the trial directory are removed
 * whatever happens. Throws when the container cannot run, does not exit 0, or
 * prints a list that does not parse.
 */
export async function listToolsets(
  deps: ToolsetDeps,
  deadlineMs = TOOLSET_LIST_DEADLINE_MS,
): Promise<string[]> {
  const attemptId = newId();
  const dirs = await prepareTrialDirs(deps.trialsDir, attemptId);
  try {
    // Keeps Hermes from copying its bundled skills into a home that is deleted next.
    await writeFile(join(dirs.home, '.no-bundled-skills'), '');
    const stdout: string[] = [];
    const stderr: Buffer[] = [];
    const outcome = await runTrial({
      engine: deps.engine,
      spec: toolsetListSpec(deps, attemptId, deadlineMs),
      deadlineMs,
      onStdoutLine: (line) => stdout.push(line),
      onStderr: (chunk) => stderr.push(chunk),
    });
    if (outcome.stopReason !== 'exited' || outcome.exitCode !== 0) {
      const tail = Buffer.concat(stderr).toString('utf8').slice(-1000).trim();
      throw new Error(
        `hermes tools list ${outcome.stopReason === 'exited' ? `exited ${outcome.exitCode}` : `stopped (${outcome.stopReason})`}${tail ? `: ${tail}` : ''}`,
      );
    }
    return parseToolsetList(stdout.join('\n'));
  } finally {
    await removeTrialDirs(deps.trialsDir, attemptId);
  }
}
