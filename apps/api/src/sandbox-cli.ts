/**
 * Sandbox commands, run inside the worker container:
 *
 *   node dist/sandbox-cli.js selftest   prove isolation on this machine
 *   node dist/sandbox-cli.js smoke [n]  one real Hermes run against the mock model, on slot n
 *   node dist/sandbox-cli.js lifecycle  deadline, cancel, orphans, hostile output and disk caps
 *   node dist/sandbox-cli.js task <dir> one suite task folder with a real model (TASK_PROVIDER, TASK_MODEL)
 *
 * Each prints a report and exits non-zero on failure.
 */
import { EgressClient } from './sandbox/egress-client.js';
import { EngineClient } from './sandbox/engine-client.js';
import { runHermesSmoke } from './sandbox/hermes-smoke.js';
import { runLifecycleChecks } from './sandbox/lifecycle-test.js';
import { runIsolationSelfTest } from './sandbox/self-test.js';
import { runTask } from './sandbox/task-run.js';
import { freeSlot } from './sandbox/trial-runner.js';

const env = process.env;
const engine = new EngineClient(env.DOCKER_SOCKET ?? '/run/guard/docker.sock');
const egress = new EgressClient(env.EGRESS_ADMIN_SOCKET ?? '/run/egress/admin.sock');
const slots = (env.TRIAL_SLOTS ?? 'hermes-evals-trial-0').split(',').map((s) => s.trim());

const base = {
  engine,
  egress,
  trialsDir: env.TRIALS_DIR ?? '/trials',
  image: env.TRIAL_IMAGE ?? 'hermes-evals/trial:v0.22.4-4d04303',
  volume: env.TRIAL_VOLUME ?? 'hermes-evals-trials',
};

const command = process.argv[2];
if (command === 'selftest') {
  const report = await runIsolationSelfTest({ ...base, slot: await freeSlot(engine, slots) });
  for (const check of report.checks) {
    process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}: ${check.detail}\n`);
  }
  process.stdout.write(`${JSON.stringify({ ok: report.ok, probe: report.probe }, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
} else if (command === 'smoke') {
  const report = await runHermesSmoke({
    ...base,
    // A given slot index is used only if no trial is live on it.
    slot: await freeSlot(
      engine,
      process.argv[3] === undefined ? slots : [slots[Number(process.argv[3])] ?? 'no such slot'],
    ),
    provider: env.SMOKE_PROVIDER ?? 'mock',
    model: env.SMOKE_MODEL ?? 'mock/scripted',
    hermesProvider: env.SMOKE_HERMES_PROVIDER ?? 'nous',
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const result = report.events.find((e) => e.type === 'result');
  process.exit(result && report.outcome.stopReason === 'exited' ? 0 : 1);
} else if (command === 'lifecycle') {
  const checks = await runLifecycleChecks(base);
  for (const check of checks) {
    process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}: ${check.detail}\n`);
  }
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
} else if (command === 'task' && process.argv[3]) {
  const report = await runTask(
    {
      ...base,
      slot: await freeSlot(engine, slots),
      provider: env.TASK_PROVIDER ?? 'nous',
      model: env.TASK_MODEL ?? 'openai/gpt-6.1-sol',
      hermesProvider: env.TASK_HERMES_PROVIDER ?? 'nous',
    },
    process.argv[3],
    Number(env.TASK_MAX_TOKENS ?? 300_000),
  );
  if (process.env.TASK_REPORT_JSON) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    const { trial, check } = report;
    const result = trial.events.findLast((e) => e.type === 'result');
    const tools = trial.events.filter(
      (e) => e.type === 'tool_use' || e.type === 'tool_call',
    ).length;
    process.stdout.write(
      [
        `task       ${report.task}: ${report.summary}`,
        `model      ${report.model}`,
        `trial      ${trial.outcome.stopReason}, exit ${trial.outcome.exitCode}, ${(trial.outcome.durationMs / 1000).toFixed(1)} s`,
        `events     ${trial.events.length} (${tools} tool calls), ${trial.nonJsonLines.length} non-JSON lines`,
        `tokens     result ${JSON.stringify(result?.tokens ?? null)}; gateway ${JSON.stringify(trial.usage)}`,
        `egress     ${trial.egressLog.map((e) => `${e.kind}:${e.decision}${'host' in e ? `:${String(e.host)}` : ''}`).join(' ')}`,
        `token      found in ${trial.tokenInHome.length} home files${trial.tokenUnchecked.length ? `; not searched: ${trial.tokenUnchecked.join(', ')}` : ''}`,
        `answer     ${report.answer.ok ? JSON.stringify(report.answer.value) : report.answer.reason}`,
        `check      ${check.status.toUpperCase()}: observed ${JSON.stringify(check.observed)}, expected ${JSON.stringify(check.expected)} (${check.comment})`,
        `final text ${JSON.stringify((trial.finalText ?? '').slice(-600))}`,
        '',
      ].join('\n'),
    );
  }
  process.exit(
    report.check.status === 'passed' && report.trial.outcome.stopReason === 'exited' ? 0 : 1,
  );
} else {
  process.stderr.write('usage: sandbox-cli selftest | smoke [slot] | lifecycle | task <dir>\n');
  process.exit(2);
}
