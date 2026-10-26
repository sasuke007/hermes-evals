/**
 * The isolation self-test's last check (Phase 5b question 3, settled for
 * Phase 7): one verifier container, started through docker-guard by the
 * runner that scoring and every load use (containerVerifierRunner), runs a
 * probe script that scores 1 only when it has no network, runs as uid 10000
 * and cannot write its own inputs. A guard that refuses the verifier spec,
 * a trial image without python3 or a trials volume the worker cannot fill
 * shows here, at worker start, rather than at the first load or score.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containerVerifierRunner, type VerifierRunner } from '../scoring/verifier-runner.js';
import type { EngineClient } from './engine-client.js';
import type { SelfTestCheck } from './self-test.js';

export const VERIFIER_CHECK_NAME = 'a verifier container starts through docker-guard';

/** Seconds the probe may take; it needs well under one. */
const PROBE_TIMEOUT_S = 30;

/** What it finds out, as the verifier contract's last stdout line: score 1 when confined. */
const PROBE = String.raw`
import json, os, socket
problems = []
if os.getuid() != 10000:
    problems.append("runs as uid %d" % os.getuid())
routes = [l.split() for l in open("/proc/net/route").read().splitlines()[1:]]
if any(len(r) > 1 for r in routes):
    problems.append("has a route")
try:
    socket.create_connection(("1.1.1.1", 443), timeout=2).close()
    problems.append("reached 1.1.1.1:443")
except OSError:
    pass
try:
    open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "probe-write"), "w").write("x")
    problems.append("wrote to its verify folder")
except OSError:
    pass
comment = "; ".join(problems) or "no network, uid 10000, inputs read-only"
print(json.dumps({"score": 0 if problems else 1, "comment": comment}))
`;

export interface VerifierCheckDeps {
  engine: EngineClient;
  image: string;
  volume: string;
  trialsDir: string;
  /** The runner to start it with; the worker's container runner, built from the above, by default. */
  verifier?: VerifierRunner;
}

/** Runs the probe in one verifier container; never throws. */
export async function checkVerifierContainer(deps: VerifierCheckDeps): Promise<SelfTestCheck> {
  const runner =
    deps.verifier ??
    containerVerifierRunner({
      engine: deps.engine,
      image: deps.image,
      volume: deps.volume,
      trialsDir: deps.trialsDir,
    });
  const fail = (detail: string): SelfTestCheck => ({
    name: VERIFIER_CHECK_NAME,
    ok: false,
    detail,
  });
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'hermes-evals-selftest-verify-'));
    const verifyDir = join(dir, 'verify');
    await mkdir(verifyDir);
    await mkdir(join(dir, 'workspace'));
    await mkdir(join(dir, 'scratch'));
    await writeFile(join(verifyDir, 'probe.py'), PROBE);
    const { outcome, evidence } = await runner.run({
      scriptPath: join(verifyDir, 'probe.py'),
      verifyDir,
      answer: null,
      workspaceDir: join(dir, 'workspace'),
      timeoutS: PROBE_TIMEOUT_S,
      scratchDir: join(dir, 'scratch'),
    });
    const took = `${(evidence.duration_ms / 1000).toFixed(1)} s`;
    if (!outcome.ok) return fail(`${outcome.error}${outcome.detail ? `: ${outcome.detail}` : ''}`);
    return {
      name: VERIFIER_CHECK_NAME,
      ok: outcome.score === 1,
      detail: `${outcome.comment ?? `score ${outcome.score}`} · ${took}`,
    };
  } catch (err) {
    return fail(`could not run: ${(err as Error).message}`);
  } finally {
    if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
