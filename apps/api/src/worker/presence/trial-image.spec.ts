import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HERMES_REVISION } from '@hermes-evals/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HERMES_REVISION_LABEL, inspectTrialImage } from './trial-image.js';

const IMAGE = 'hermes-evals/trial:v0.22.4-4d04303';
const ID = `sha256:${'9'.repeat(64)}`;

let reply: (req: http.IncomingMessage, res: http.ServerResponse) => void;
let server: http.Server;
let dir: string;
let socket: string;
const seen: string[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trial-image-'));
  socket = join(dir, 'guard.sock');
  seen.length = 0;
  server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    reply(req, res);
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

const answer =
  (status: number, body: unknown) => (_req: http.IncomingMessage, res: http.ServerResponse) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

describe('inspectTrialImage', () => {
  it('asks the guard for the trial image and returns its id and Hermes revision label', async () => {
    reply = answer(200, {
      Id: ID,
      RepoDigests: [`hermes-evals/trial@${ID}`],
      Config: { Labels: { [HERMES_REVISION_LABEL]: 'a'.repeat(40), other: 'x' } },
    });
    expect(await inspectTrialImage(socket, IMAGE)).toEqual({ id: ID, revision: 'a'.repeat(40) });
    // The guard compares the decoded name with TRIAL_IMAGE.
    expect(seen).toEqual([`GET /v1.45/images/${encodeURIComponent(IMAGE)}/json`]);
  });

  it('reports no revision for an image without the label', async () => {
    reply = answer(200, { Id: ID, Config: { Labels: null } });
    expect(await inspectTrialImage(socket, IMAGE)).toEqual({ id: ID, revision: null });
  });

  it('throws on a refusal or an answer it cannot read', async () => {
    reply = answer(403, { message: 'only the trial image may be inspected' });
    await expect(inspectTrialImage(socket, IMAGE)).rejects.toThrow(/403/);
    reply = answer(200, { Id: 'not-a-digest' });
    await expect(inspectTrialImage(socket, IMAGE)).rejects.toThrow(/unreadable answer/);
  });

  it('throws when the guard is not there', async () => {
    await expect(inspectTrialImage(join(dir, 'missing.sock'), IMAGE)).rejects.toThrow(/ENOENT/);
  });
});

/** The real guard and image; see the RUN_SANDBOX_TESTS note in sandbox/toolsets.spec.ts. */
describe.runIf(process.env.RUN_SANDBOX_TESTS === '1')(
  'inspectTrialImage through docker-guard',
  () => {
    it('reads the trial image id and its Hermes revision label', async () => {
      const facts = await inspectTrialImage(
        process.env.DOCKER_SOCKET ?? '/run/guard/docker.sock',
        process.env.TRIAL_IMAGE ?? IMAGE,
      );
      expect(facts.id).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(facts.revision).toBe(HERMES_REVISION);
    });
  },
);
