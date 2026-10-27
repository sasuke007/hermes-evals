/**
 * The attempt runner end to end on FakeEngine and FakeEgress, with real
 * directories, a real blob store and docker-guard's own create-body check:
 * every row of the plan 8.4 exit table, the launch contract, the order of
 * sink writes, egress registration and removal, and what is left on disk.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LaunchRecordSchema, RunEventPayloadSchema } from '@hermes-evals/shared';
import { hermesRun, streamJson, type FakeTrialScript } from '../../../test/support/fake-engine.js';
import { EngineError } from '../../sandbox/engine-client.js';
import type { AttemptOutcome } from '../contracts.js';
import {
  createAttemptWorld,
  DAEMON,
  FIXTURE_CSV,
  MemorySink,
  runnerKit,
  SLOT,
  type AttemptWorld,
} from './testing.helper-spec.js';

let world: AttemptWorld;

beforeEach(async () => {
  world = await createAttemptWorld();
});

afterEach(async () => {
  await world.cleanup();
});

const ANSWER = 'The total is 1042.\n```json\n{"total": 1042.00}\n```';

async function runWith(
  script: FakeTrialScript,
  overrides: Parameters<AttemptWorld['plan']>[0] = {},
  options: Parameters<typeof runnerKit>[2] = {},
) {
  const plan = world.plan(overrides);
  const kit = runnerKit(world, () => script, options);
  const sink = new MemorySink(plan.attemptId);
  const outcome = await kit.runner.run(plan, sink, new AbortController().signal);
  return { plan, sink, outcome, ...kit };
}

const subtypes = (outcome: AttemptOutcome) =>
  outcome.finalEvents.map(
    (e) => `${e.type}:${typeof e.payload.subtype === 'string' ? e.payload.subtype : ''}`,
  );

describe('a run that answers', () => {
  it('is executed with the result text, session, tokens, and every event in order', async () => {
    const { plan, sink, outcome, engine, egress } = await runWith(hermesRun(ANSWER));
    expect(outcome).toMatchObject({
      status: 'executed',
      category: null,
      errorMessage: null,
      exitCode: 0,
      finalText: ANSWER,
      sessionId: '20261024_120000_abcdef',
      tokens: { input: 3300, output: 63, total: 3363, cache_read: 0, cache_write: 0 },
      stderrTail: null,
      redactions: 0,
      egressUsage: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);

    // The launch record first, then the container, then events; all before nothing else.
    expect(sink.calls.slice(0, 2)).toEqual(['launch', 'container']);
    expect(engine.calls[0]).toBe(`create hermes-evals-run-${plan.runId}`);
    expect(sink.container).toEqual({ id: engine.containers[0]!.info.id, hostId: DAEMON });
    expect(sink.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(sink.events.map((e) => e.type)).toEqual([
      'platform',
      'system',
      'tool_use',
      'tool_result',
      'text',
      'result',
    ]);
    expect(sink.events[0]!.payload).toMatchObject({ subtype: 'started', network: SLOT });
    for (const event of sink.events)
      expect(RunEventPayloadSchema.parse(event.payload)).toBeTruthy();
    expect(sink.events[5]!.payload).toMatchObject({ type: 'result', text: ANSWER, exit_code: 0 });

    // The container is gone, the token is dead, the home is deleted and the workspace kept.
    expect(engine.present()).toEqual([]);
    expect(egress.removed).toEqual([plan.attemptId]);
    expect(egress.registrations.size).toBe(0);
    expect(existsSync(plan.paths.home)).toBe(false);
    expect(await readFile(join(plan.paths.workspace, 'invoices.csv'), 'utf8')).toBe(FIXTURE_CSV);
    expect(existsSync(join(plan.paths.root, 'stderr.log'))).toBe(true);
    expect(subtypes(outcome)).toEqual(['platform:collected']);
  });

  it('launches exactly the plan 8.2 contract and records it without the token', async () => {
    const { plan, sink, engine, egress } = await runWith(hermesRun(ANSWER));
    const info = engine.containers[0]!.info;
    expect(info.argv).toEqual([
      '/opt/hermes/.venv/bin/hermes',
      'chat',
      '--query-file',
      '/opt/data/task.txt',
      '--oneshot',
      '--format',
      'stream-json',
      '--provider',
      'custom',
      '-m',
      'mock/scripted',
      '--base-url',
      'http://egress:8080/v1',
      '--api-key',
      plan.token,
      '-t',
      'file,terminal',
      '-s',
      'invoice-audit',
      '--max-turns',
      '6',
      '--yolo',
      '--in',
      '/workspace',
    ]);
    const proxy = `http://${plan.attemptId}:${plan.token}@egress:3128`;
    expect(info.env).toMatchObject({
      HOME: '/opt/data',
      HERMES_HOME: '/opt/data',
      HERMES_WRITE_SAFE_ROOT: '/workspace:/opt/data',
      XDG_RUNTIME_DIR: '/opt/data/.run',
      TMPDIR: '/tmp',
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      NO_PROXY: 'egress',
      HERMES_EVALS_ATTEMPT_TOKEN: plan.token,
    });
    expect(info.network).toBe(SLOT);
    expect(info.labels).toMatchObject({
      'hermes-evals.role': 'trial',
      'hermes-evals.run': plan.runId,
      'hermes-evals.attempt': plan.attemptId,
    });

    const record = LaunchRecordSchema.parse(sink.launch);
    expect(record.argv).toContain('<attempt-token>');
    expect(JSON.stringify(sink.launch)).not.toContain(plan.token);
    expect(record.limits).toEqual({ max_turns: 6, run_budget_seconds: 30, deadline_seconds: 30 });
    expect(record.inputs).toEqual([
      { path: 'invoices.csv', sha256: world.fixtureSha, source: 'fixture' },
      {
        path: 'docs/policy.md',
        sha256: world.docSha,
        source: 'document',
        document_id: plan.configuration.documents[0]!.id,
      },
    ]);
    expect(record.skills).toEqual([
      {
        skill_id: plan.configuration.skills[0]!.id,
        name: 'invoice-audit',
        version: '1.0.0',
        content_hash: world.skillHash,
      },
    ]);
    expect(record.secret_env_names).toContain('HERMES_EVALS_ATTEMPT_TOKEN');
    expect(sink.launch).toMatchObject({
      container: {
        image: 'hermes-evals/trial:v0.22.4-4d04303',
        network: SLOT,
        user: '10000:10000',
      },
    });

    expect(egress.history).toEqual([
      {
        attemptId: plan.attemptId,
        registration: {
          token: plan.token,
          mode: 'allowlist',
          allowHosts: [],
          provider: 'custom',
          models: ['mock/scripted'],
          upstream: { baseUrl: 'http://mock-model:8090/v1' },
          expiresAt: expect.any(Number),
          mcp: [],
        },
      },
    ]);
  });

  it('is executed on the partial text of a turn stopped by max turns (exit 1)', async () => {
    const { outcome } = await runWith({
      steps: [
        { stdout: streamJson.init() },
        { stdout: streamJson.result({ text: 'Partial: INV-1 is 100.', exitCode: 1 }) },
      ],
      exitCode: 1,
    });
    expect(outcome).toMatchObject({
      status: 'executed',
      category: null,
      exitCode: 1,
      finalText: 'Partial: INV-1 is 100.',
    });
  });

  it('is executed with an empty answer when a completed turn printed none', async () => {
    const { outcome } = await runWith({
      steps: [{ stdout: streamJson.init() }, { stdout: streamJson.result({ text: '' }) }],
    });
    expect(outcome).toMatchObject({ status: 'executed', finalText: '' });
  });
});

describe('provider errors', () => {
  it.each([
    ['Error code: 401 - invalid api key', 'refused'],
    ['403 Forbidden', 'refused'],
    ['Error code: 429 - rate limit exceeded', 'failed'],
    ['Error code: 503 - upstream unavailable', 'failed'],
    ['Connection error.', 'failed'],
  ])('a result with error %j is provider', async (error, word) => {
    const { outcome } = await runWith({
      steps: [
        { stdout: streamJson.init() },
        {
          stdout: streamJson.result({
            text: 'I could not reach the model.',
            exitCode: 1,
            error,
            tokens: { input: 0, output: 0 },
          }),
        },
      ],
      exitCode: 1,
    });
    expect(outcome).toMatchObject({ status: 'execution_error', category: 'provider' });
    expect(outcome.errorMessage).toContain(word);
    expect(outcome.errorMessage).toContain(error);
    // The human message is kept as evidence, never as the answer of an executed run.
    expect(outcome.finalText).toBe('I could not reach the model.');
  });
});

describe('timeouts', () => {
  it('stops a trial that runs past the deadline with SIGTERM and synthesises a result', async () => {
    const { outcome, engine } = await runWith(
      { steps: [{ stdout: streamJson.init() }], hang: true },
      { limits: { runBudgetS: 1 } },
    );
    expect(outcome).toMatchObject({
      status: 'execution_error',
      category: 'timeout',
      exitCode: 143,
      finalText: null,
      tokens: null,
    });
    expect(outcome.errorMessage).toMatch(/run budget of 1 s plus 0 s passed without a result/);
    expect(engine.calls.some((c) => c.startsWith('stop '))).toBe(true);
    expect(subtypes(outcome)).toEqual(['platform:killed', 'result:', 'platform:collected']);
    expect(outcome.finalEvents[0]!.payload).toMatchObject({ reason: 'deadline', exit_code: 143 });
    expect(outcome.finalEvents[1]!.payload).toMatchObject({ type: 'result', synthesized: true });
    expect(engine.present()).toEqual([]);
  });

  it('stays a timeout when the container was removed after it exited, before it was inspected', async () => {
    // Recovery's sweep, or anything else, removed the stopped container under the runner.
    const plan = world.plan({ limits: { runBudgetS: 1 } });
    const kit = runnerKit(world, () => ({ steps: [{ stdout: streamJson.init() }], hang: true }));
    kit.engine.inspect = () => Promise.reject(new EngineError(404, 'No such container'));
    const outcome = await kit.runner.run(
      plan,
      new MemorySink(plan.attemptId),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({
      status: 'execution_error',
      category: 'timeout',
      exitCode: 143,
    });
    expect(outcome.errorMessage).toMatch(/run budget of 1 s/);
  });

  it('kills a trial that ignores SIGTERM once the stop grace runs out', async () => {
    const { outcome } = await runWith(
      { steps: [{ stdout: streamJson.init() }], hang: true, ignoreSigterm: true },
      { limits: { runBudgetS: 1 } },
      { settings: { stopGraceS: 1 } },
    );
    expect(outcome).toMatchObject({ category: 'timeout', exitCode: 137 });
    expect(outcome.finalEvents[0]!.payload).toMatchObject({
      reason: 'deadline',
      signal: 'SIGTERM, then SIGKILL after 1 s',
    });
  });
});

describe('setup failures', () => {
  it('exit 3 "Input required" is setup', async () => {
    const { outcome } = await runWith({
      steps: [
        { stdout: streamJson.init() },
        {
          stdout: streamJson.result({
            exitCode: 3,
            error:
              'Input required; detached without cancelling. Resume this session interactively.',
          }),
        },
      ],
      exitCode: 3,
    });
    expect(outcome).toMatchObject({ status: 'execution_error', category: 'setup', exitCode: 3 });
    expect(outcome.errorMessage).toContain('exit 3');
  });

  it('a container the guard refuses to create is setup, with no container recorded', async () => {
    const { outcome, sink, engine, egress } = await runWith({ createError: 'no such image' });
    expect(outcome).toMatchObject({ status: 'execution_error', category: 'setup', exitCode: null });
    expect(outcome.errorMessage).toContain('could not be created: ');
    expect(outcome.errorMessage).toContain('no such image');
    expect(sink.container).toBeNull();
    expect(engine.present()).toEqual([]);
    expect(egress.registrations.size).toBe(0);
    expect(outcome.artifacts).toEqual([]);
  });

  it('egress refusing the registration is setup: no container, and the registration is cleared', async () => {
    const { outcome, sink, engine, egress, plan } = await runWith(
      hermesRun(ANSWER),
      {},
      {
        egress: { registerError: 'upstream.baseUrl is required for custom' },
      },
    );
    expect(outcome).toMatchObject({ status: 'execution_error', category: 'setup', exitCode: null });
    expect(outcome.errorMessage).toContain('Egress did not accept the attempt');
    expect(sink.calls).toEqual(['launch']);
    expect(engine.containers).toEqual([]);
    expect(egress.removeCalls).toEqual([plan.attemptId]);
    expect(outcome.egressUsage).toBeNull();
    expect(existsSync(plan.paths.home)).toBe(false);
  });

  it('a container that fails to start is setup, and is removed', async () => {
    const { outcome, sink, engine } = await runWith({ startError: 'OCI runtime create failed' });
    expect(outcome).toMatchObject({ category: 'setup', exitCode: null });
    expect(outcome.errorMessage).toContain('could not be started');
    expect(sink.container).not.toBeNull();
    expect(engine.present()).toEqual([]);
  });

  it('Hermes failing before init (no output at all) is setup and keeps the stderr tail', async () => {
    const { outcome } = await runWith({
      steps: [{ stderr: 'Traceback (most recent call last):\nImportError: broken venv\n' }],
      exitCode: 1,
    });
    expect(outcome).toMatchObject({ category: 'setup', exitCode: 1 });
    expect(outcome.errorMessage).toContain('before it started the run: Traceback');
    expect(outcome.stderrTail).toBe('Traceback (most recent call last):\nImportError: broken venv');
  });

  it('a failed start that Hermes reports in its result is setup', async () => {
    const { outcome } = await runWith({
      steps: [
        { stdout: streamJson.init() },
        { stdout: streamJson.result({ exitCode: 1, error: 'credentials or agent init failed' }) },
      ],
      exitCode: 1,
    });
    expect(outcome).toMatchObject({ category: 'setup' });
    expect(outcome.errorMessage).toContain('credentials or agent init failed');
  });

  it("a run egress stopped at its token cap is limit, from egress's log rather than the status", async () => {
    // Hermes 4d04303's terminal copy for egress's 402: billing words, not the cap's.
    const { outcome } = await runWith(
      {
        steps: [
          { stdout: streamJson.init() },
          { stdout: streamJson.result({ exitCode: 1, error: 'HTTP 402: Payment required' }) },
        ],
        exitCode: 1,
      },
      {},
      {
        egress: {
          report: () => ({
            usage: { calls: 3, totalTokens: 1043 },
            log: [
              { at: new Date().toISOString(), kind: 'model', decision: 'allowed', status: 200 },
              {
                at: new Date().toISOString(),
                kind: 'model',
                decision: 'denied',
                status: 402,
                reason: 'token cap reached: 1043 of 1000 tokens used',
              },
            ],
          }),
        },
      },
    );
    expect(outcome).toMatchObject({ status: 'execution_error', category: 'limit' });
    expect(outcome.errorMessage).toBe(
      'The model gateway stopped the run at its token cap: 1043 of 1000 tokens used.',
    );
  });

  it('an MCP server that failed to start, with no result, is setup', async () => {
    const { outcome } = await runWith({
      steps: [
        { stdout: streamJson.init() },
        { stderr: "MCP server 'invoice-db' failed to start: command not found\n" },
      ],
      exitCode: 1,
    });
    expect(outcome).toMatchObject({ category: 'setup' });
  });
});

describe('killed containers', () => {
  it('an OOM-killed container is other', async () => {
    const { outcome } = await runWith({ steps: [{ stdout: streamJson.init() }], oomKilled: true });
    expect(outcome).toMatchObject({ status: 'execution_error', category: 'other', exitCode: 137 });
    expect(outcome.errorMessage).toContain('ran out of memory (limit 1536 MiB)');
    expect(outcome.finalEvents[0]!.payload).toMatchObject({ subtype: 'killed', reason: 'oom' });
  });

  it('a trial past the disk cap is killed and is other, naming the cap', async () => {
    const { outcome } = await runWith(
      {
        steps: [
          { stdout: streamJson.init() },
          ...Array.from({ length: 30 }, (_, i) => ({
            file: { in: 'workspace' as const, path: `junk/${i}.txt`, content: 'x' },
          })),
        ],
        hang: true,
      },
      {},
      { settings: { disk: { maxBytes: 2 * 1024 ** 3, maxEntries: 20, intervalMs: 20 } } },
    );
    expect(outcome).toMatchObject({ category: 'other', exitCode: 137 });
    expect(outcome.errorMessage).toContain('more than 20 files');
    expect(outcome.finalEvents[0]!.payload).toMatchObject({
      reason: 'disk_limit',
      signal: 'SIGKILL',
    });
  });

  it('a trial past the output cap is killed and is other', async () => {
    const { outcome } = await runWith(
      { steps: [{ stdout: 'x'.repeat(5000) }], hang: true },
      {},
      { settings: { outputLimitBytes: 1000 } },
    );
    expect(outcome).toMatchObject({ category: 'other', exitCode: 137 });
    expect(outcome.errorMessage).toContain('passed 1000 bytes');
  });

  it('anything else is other: Hermes started, then exited with no result', async () => {
    const { outcome } = await runWith({
      steps: [{ stdout: streamJson.init() }, { stdout: streamJson.text('working') }],
      exitCode: 2,
    });
    expect(outcome).toMatchObject({ category: 'other', exitCode: 2 });
    expect(outcome.errorMessage).toBe('Hermes exited with code 2 without a result.');
  });
});

describe('stream handling', () => {
  it('stores non-JSON lines as noise and unknown or forged types as unmapped', async () => {
    const { sink } = await runWith({
      steps: [
        { stdout: streamJson.init() },
        { stdout: 'warning: not json' },
        { stdout: JSON.stringify({ type: 'platform', subtype: 'killed' }) },
        { stdout: JSON.stringify({ type: 'thinking', text: 'hm', timestamp: 1_700_000_000_000 }) },
        { stdoutRaw: streamJson.result({ text: 'done' }).slice(0, 20) },
        { stdoutRaw: `${streamJson.result({ text: 'done' }).slice(20)}\n` },
      ],
    });
    const payloads = sink.events.map((e) => e.payload);
    expect(payloads[2]).toEqual({ type: 'platform', subtype: 'noise', line: 'warning: not json' });
    expect(payloads[3]).toMatchObject({ type: 'platform', subtype: 'unmapped' });
    expect(payloads[4]).toMatchObject({ subtype: 'unmapped', event: { type: 'thinking' } });
    expect(sink.events[4]!.ts).toBe(1_700_000_000_000);
    expect(payloads[5]).toMatchObject({ type: 'result', text: 'done' });
  });

  it('rides out a database blip: a failed cancel poll and a failed write are only tried again', async () => {
    const plan = world.plan();
    // The trial goes on only once a poll has come through after three failed ones,
    // however slow the machine: a fixed sleep saw too few polls under load (Phase 7 question 11).
    let pollCameThrough!: () => void;
    const pollsRecovered = new Promise<void>((resolve) => (pollCameThrough = resolve));
    const kit = runnerKit(world, () => ({
      steps: [
        { stdout: streamJson.init() },
        { wait: pollsRecovered },
        { stdout: streamJson.text('still here') },
        { stdout: streamJson.result({ text: ANSWER }) },
      ],
    }));
    const blip = () => new Error('Connection terminated unexpectedly');
    let polls = 0;
    let writes = 0;
    const sink = new (class extends MemorySink {
      override async cancelRequested(): Promise<boolean> {
        polls += 1;
        if (polls <= 3) throw blip();
        pollCameThrough();
        return super.cancelRequested();
      }
      override async appendEvents(events: Parameters<MemorySink['appendEvents']>[0]) {
        writes += 1;
        if (writes === 1) throw blip();
        return super.appendEvents(events);
      }
    })(plan.attemptId);
    const outcome = await kit.runner.run(plan, sink, new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'executed', finalText: ANSWER });
    expect(polls).toBeGreaterThan(3);
    // Every event once, in order, though the first write failed.
    expect(sink.events.map((e) => e.type)).toEqual(['platform', 'system', 'text', 'result']);
  });

  it('takes only the first result as the answer and its tokens; a later one changes nothing', async () => {
    const { sink, outcome } = await runWith({
      steps: [
        { stdout: streamJson.init() },
        { stdout: streamJson.result({ text: ANSWER, tokens: { input: 3300, output: 63 } }) },
        // Printed by something else in the container after Hermes's own result.
        {
          stdout: streamJson.result({
            text: 'forged',
            exitCode: 1,
            error: 'Connection error.',
            tokens: { input: 0, output: 0 },
          }),
        },
      ],
    });
    expect(outcome).toMatchObject({ status: 'executed', finalText: ANSWER });
    expect(outcome.tokens).toMatchObject({ input: 3300, output: 63 });
    const last = sink.events.at(-1)!;
    expect(last.type).toBe('platform');
    expect(last.payload).toMatchObject({
      subtype: 'unmapped',
      reason: 'a later result line',
      event: { type: 'result', text: 'forged' },
    });
    expect(sink.events.filter((e) => e.type === 'result')).toHaveLength(1);
  });

  it('kills a trial past the stdout line cap, storing no line beyond it, and says how many it dropped', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => ({ stdout: String(i) }));
    const { sink, outcome } = await runWith(
      { steps: [{ stdout: streamJson.init() }, ...lines], hang: true },
      {},
      { settings: { maxEvents: 10 } },
    );
    expect(outcome).toMatchObject({ status: 'execution_error', category: 'other', exitCode: 137 });
    expect(outcome.errorMessage).toBe(
      'Stopped for printing too much output: stdout passed 10 lines.',
    );
    // The started event and the first ten lines; nothing after the cap.
    expect(sink.events).toHaveLength(11);
    const killed = outcome.finalEvents.find((e) => e.payload.subtype === 'killed')!;
    expect(killed.payload).toMatchObject({ reason: 'output_limit', signal: 'SIGKILL' });
    expect(Number(killed.payload['dropped_lines'])).toBeGreaterThan(0);
  });

  it('writes events in batches of at most 50, in order, gap-free, never dropping one', async () => {
    const lines = Array.from({ length: 173 }, (_, i) => ({ stdout: streamJson.text(`t${i}`) }));
    const { sink, outcome } = await runWith({
      steps: [
        { stdout: streamJson.init() },
        ...lines,
        { stdout: streamJson.result({ text: 'x' }) },
      ],
    });
    expect(outcome.status).toBe('executed');
    expect(sink.events).toHaveLength(176);
    expect(sink.events.map((e) => e.seq)).toEqual(Array.from({ length: 176 }, (_, i) => i + 1));
    const texts = sink.events.filter((e) => e.type === 'text').map((e) => e.payload.text);
    expect(texts).toEqual(Array.from({ length: 173 }, (_, i) => `t${i}`));
    expect(Math.max(...sink.batches.slice(0, -1))).toBeLessThanOrEqual(50);
  });
});
