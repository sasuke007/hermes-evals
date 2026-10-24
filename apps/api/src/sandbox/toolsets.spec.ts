import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { checkCreateBody } from '@hermes-evals/docker-guard/policy';
import { HERMES_TOOLSETS } from '@hermes-evals/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EngineClient } from './engine-client.js';
import { listToolsets, parseToolsetList, toolsetListSpec, type ToolsetDeps } from './toolsets.js';
import { trialContainerBody } from './trial-spec.js';

/** `hermes tools list` in the trial image, captured 24 Oct 2026 (docker run, no network). */
const CAPTURED = `Built-in toolsets (cli):
  ✓ enabled  web  🔍 Web Search & Scraping
  ✓ enabled  browser  🌐 Browser Automation
  ✓ enabled  terminal  💻 Terminal & Processes
  ✓ enabled  file  📁 File Operations
  ✓ enabled  code_execution  ⚡ Code Execution
  ✓ enabled  vision  👁️  Vision / Image Analysis
  ✗ disabled  video  🎬 Video Analysis
  ✓ enabled  image_gen  🎨 Image Generation
  ✗ disabled  video_gen  🎬 Video Generation
  ✗ disabled  x_search  🐦 X (Twitter) Search
  ✓ enabled  tts  🔊 Text-to-Speech
  ✗ disabled  stt  🎙️ Speech-to-Text
  ✓ enabled  skills  📚 Skills
  ✓ enabled  todo  📋 Task Planning
  ✗ disabled  kanban  📌 Kanban
  ✓ enabled  memory  💾 Memory
  ✗ disabled  context_engine  🧩 Context Engine
  ✓ enabled  session_search  🔎 Session Search
  ✓ enabled  connections  🔌 Connections
  ✓ enabled  clarify  ❓ Clarifying Questions
  ✓ enabled  delegation  👥 Task Delegation
  ✓ enabled  cronjob  ⏰ Cron Jobs
  ✗ disabled  yuanbao  🤖 Yuanbao
  ✓ enabled  computer_use  🖱️  Computer Use (macOS/Windows/Linux)

Plugin toolsets (cli):
  ✗ disabled  a2a  🔌 A2A
`;

const IMAGE = 'hermes-evals/trial:v0.22.4-4d04303';
const VOLUME = 'hermes-evals-trials';

describe('parseToolsetList', () => {
  it('returns the enabled built-in toolsets in runtime order: the shared fallback list', () => {
    expect(parseToolsetList(CAPTURED)).toEqual([...HERMES_TOOLSETS]);
  });

  it('reads the lines as the log decoder delivers them: blank lines dropped, CRLF, colour', () => {
    const lines = CAPTURED.split('\n').filter(Boolean);
    expect(parseToolsetList(lines.join('\n'))).toEqual([...HERMES_TOOLSETS]);
    expect(parseToolsetList(CAPTURED.replaceAll('\n', '\r\n'))).toEqual([...HERMES_TOOLSETS]);
    const coloured = CAPTURED.replace('✓ enabled', '\u001b[32m✓ enabled\u001b[0m');
    expect(parseToolsetList(coloured)).toEqual([...HERMES_TOOLSETS]);
  });

  it('ignores plugin toolsets, even enabled ones', () => {
    const withPlugin = CAPTURED.replace('✗ disabled  a2a', '✓ enabled  a2a');
    expect(parseToolsetList(withPlugin)).not.toContain('a2a');
  });

  it('accepts rows without a mark', () => {
    expect(parseToolsetList('Built-in toolsets:\n  enabled  file  x\n  disabled  web\n')).toEqual([
      'file',
    ]);
  });

  it('refuses output it cannot read rather than guessing', () => {
    expect(() => parseToolsetList('Usage: hermes tools [list|enable|disable]')).toThrow(
      /no "Built-in toolsets" section/,
    );
    expect(() => parseToolsetList('Built-in toolsets (cli):\n\nPlugin toolsets (cli):\n')).toThrow(
      /lists no toolset/,
    );
    expect(() => parseToolsetList('Built-in toolsets (cli):\n  ✓ on  web\n')).toThrow(
      /unreadable "Built-in toolsets" row: ✓ on {2}web/,
    );
    expect(() => parseToolsetList('Built-in toolsets (cli):\n  ✓ enabled  Web!\n')).toThrow(
      /unreadable/,
    );
  });
});

describe('the toolset listing container', () => {
  it('is a trial-shaped probe with no network, which docker-guard accepts', () => {
    const attemptId = '01K8ZQ7M3V5X9C2B4N6P8R0T1W';
    const spec = toolsetListSpec(
      {
        engine: new EngineClient('/nonexistent'),
        trialsDir: '/trials',
        image: IMAGE,
        volume: VOLUME,
      },
      attemptId,
      60_000,
    );
    expect(spec.network).toBe('none');
    expect(spec.name).toBe(`hermes-evals-probe-${attemptId}`);
    const body = JSON.parse(JSON.stringify(trialContainerBody(spec))) as unknown;
    const result = checkCreateBody(body, {
      trialImage: IMAGE,
      trialVolume: VOLUME,
      trialNetworks: ['hermes-evals-trial-0'],
    });
    expect(result.ok ? 'accepted' : result.reasons).toBe('accepted');
  });
});

/** One stdout frame of Docker's multiplexed log stream. */
const frame = (text: string): Buffer => {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};

/** The Engine calls runTrial makes, answering with a container that prints `stdout` and exits. */
function fakeEngine(stdout: string, exitCode = 0) {
  const calls: string[] = [];
  const engine = {
    list: async () => [],
    createContainer: async (name: string) => {
      calls.push(`create ${name}`);
      return 'c'.repeat(64);
    },
    waitForExit: () => ({
      registered: Promise.resolve(),
      exited: Promise.resolve({ StatusCode: exitCode }),
    }),
    start: async () => void calls.push('start'),
    logs: async () => Readable.from([frame(stdout)]) as unknown as IncomingMessage,
    inspect: async () => ({ State: { OOMKilled: false } }),
    stop: async () => {},
    kill: async () => {},
    remove: async () => void calls.push('remove'),
  };
  return { engine: engine as unknown as EngineClient, calls };
}

describe('listToolsets', () => {
  let trialsDir: string;

  beforeEach(async () => {
    trialsDir = await mkdtemp(join(tmpdir(), 'hermes-evals-toolsets-'));
  });

  afterEach(async () => {
    await rm(trialsDir, { recursive: true, force: true });
  });

  const deps = (engine: EngineClient): ToolsetDeps => ({
    engine,
    trialsDir,
    image: IMAGE,
    volume: VOLUME,
  });

  it('runs the listing, parses it, and removes the container and the trial directory', async () => {
    const { engine, calls } = fakeEngine(CAPTURED);
    expect(await listToolsets(deps(engine))).toEqual([...HERMES_TOOLSETS]);
    expect(calls).toEqual([
      expect.stringMatching(/^create hermes-evals-probe-/),
      'start',
      'remove',
    ]);
    expect(await readdir(trialsDir)).toEqual([]);
  });

  it('fails on a non-zero exit, with stderr, and still cleans up', async () => {
    const { engine, calls } = fakeEngine('Traceback (most recent call last):\n', 1);
    await expect(listToolsets(deps(engine))).rejects.toThrow(/hermes tools list exited 1/);
    expect(calls.at(-1)).toBe('remove');
    expect(await readdir(trialsDir)).toEqual([]);
  });

  it('fails on output it cannot parse, and still cleans up', async () => {
    const { engine } = fakeEngine('hermes 0.22.4\n');
    await expect(listToolsets(deps(engine))).rejects.toThrow(/no "Built-in toolsets"/);
    expect(await readdir(trialsDir)).toEqual([]);
  });
});

/**
 * One real listing through docker-guard in the pinned trial image. Inside the
 * worker container the defaults apply; from a development machine point
 * DOCKER_SOCKET at a docker-guard socket, and TRIALS_DIR at the host
 * directory that backs TRIAL_VOLUME. The gated files share TRIALS_DIR and
 * each checks it leaves the directory as it found it, so run them one at a
 * time (`vitest run --no-file-parallelism`).
 */
describe.runIf(process.env.RUN_SANDBOX_TESTS === '1')('listToolsets in the trial image', () => {
  it('lists the 17 enabled built-in toolsets', { timeout: 120_000 }, async () => {
    const env = process.env;
    const socket = env.DOCKER_SOCKET ?? '/run/guard/docker.sock';
    expect(existsSync(socket), `docker-guard socket ${socket}`).toBe(true);
    const trialsDir = env.TRIALS_DIR ?? '/trials';
    const toolsets = await listToolsets({
      engine: new EngineClient(socket),
      trialsDir,
      image: env.TRIAL_IMAGE ?? IMAGE,
      volume: env.TRIAL_VOLUME ?? VOLUME,
    });
    expect(toolsets).toEqual([...HERMES_TOOLSETS]);
  });
});
