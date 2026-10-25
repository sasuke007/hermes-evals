import { createServer } from 'node:net';
import { NousLoginSchema } from '@hermes-evals/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_USER_CODE, FakeNousLogin } from './fake-nous-login.support-spec.js';
import {
  NousLoginClient,
  NousLoginServiceError,
  NousLoginStatusSchema,
  NousLoginUnavailableError,
  NousLoginUnreachableError,
} from './nous-login.client.js';

const FAST = { statusMs: 300, startMs: 300, changeMs: 300 };

/** A port nothing listens on: bound, read, released. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('NousLoginClient', () => {
  let fake: FakeNousLogin;
  let client: NousLoginClient;

  beforeEach(async () => {
    fake = await new FakeNousLogin().listen();
    client = new NousLoginClient(`${fake.url}/`, FAST);
  });

  afterEach(() => fake.close());

  it('reads the status, and the login while one waits', async () => {
    expect(await client.status()).toMatchObject({ state: 'not_connected', login: null });
    const started = await client.startLogin();
    expect(NousLoginSchema.parse(started)).toMatchObject({
      state: 'waiting_for_approval',
      userCode: FAKE_USER_CODE,
    });
    const status = NousLoginStatusSchema.parse(await client.status());
    expect(status.login?.state).toBe('waiting_for_approval');
    fake.approve();
    expect(await client.status()).toMatchObject({ state: 'connected', scope: 'inference:invoke' });
    expect(await client.getLogin()).toMatchObject({ state: 'connected', userCode: null });
    // The base URL's trailing slash is dropped.
    expect(fake.calls).toContain('GET /status');
  });

  it('cancels and logs out', async () => {
    await client.startLogin();
    expect((await client.cancelLogin()).state).toBe('not_connected');
    fake.approve();
    expect((await client.logout()).state).toBe('not_connected');
    expect(fake.volume).toBe('not_connected');
  });

  it('reports a failed startup check as unavailable, with its reason, and refuses logins', async () => {
    fake.unavailable = 'hermes_cli.auth._nous_device_code_login is missing';
    expect(await client.status()).toMatchObject({
      state: 'unavailable',
      reason: 'hermes_cli.auth._nous_device_code_login is missing',
    });
    await expect(client.startLogin()).rejects.toBeInstanceOf(NousLoginUnavailableError);
    await expect(client.startLogin()).rejects.toMatchObject({
      reason: 'hermes_cli.auth._nous_device_code_login is missing',
    });
  });

  it('turns an unreachable service into unavailable rather than throwing', async () => {
    const down = new NousLoginClient(`http://127.0.0.1:${await closedPort()}`, FAST);
    const status = await down.status();
    expect(status.state).toBe('unavailable');
    expect(status.reason).toMatch(/^nous-login is not reachable at http:\/\/127\.0\.0\.1:\d+$/);
    await expect(down.getLogin()).rejects.toBeInstanceOf(NousLoginUnavailableError);
  });

  it('throws, for the provider checks, when there is no answer to read', async () => {
    const down = new NousLoginClient(`http://127.0.0.1:${await closedPort()}`, FAST);
    await expect(down.checkedStatus()).rejects.toBeInstanceOf(NousLoginUnreachableError);
    fake.brokenStatus = 500;
    await expect(client.checkedStatus()).rejects.toThrow(
      new NousLoginUnreachableError('nous-login answered HTTP 500 to a status check'),
    );
    fake.brokenStatus = 200;
    await expect(client.checkedStatus()).rejects.toBeInstanceOf(NousLoginUnreachableError);
    fake.brokenStatus = null;
    // What nous-login itself answered is never an error, `unavailable` included.
    fake.unavailable = 'contract changed';
    expect((await client.checkedStatus()).state).toBe('unavailable');
  });

  it('gives up after the deadline', async () => {
    fake.hang = true;
    const started = Date.now();
    const status = await client.status();
    expect(status).toMatchObject({ state: 'unavailable' });
    expect(status.reason).toMatch(/did not answer within 0.3 s/);
    expect(Date.now() - started).toBeLessThan(2_000);
    await expect(client.logout()).rejects.toBeInstanceOf(NousLoginUnavailableError);
  });

  it('refuses answers outside the contract', async () => {
    fake.brokenStatus = 500;
    expect(await client.status()).toMatchObject({
      state: 'unavailable',
      reason: 'nous-login answered HTTP 500 to a status check',
    });
    await expect(client.startLogin()).rejects.toThrow(
      new NousLoginServiceError('nous-login answered HTTP 500 to POST /login: Boom: broken'),
    );
    fake.brokenStatus = 200;
    expect((await client.status()).reason).toBe(
      'nous-login answered a status check in an unknown shape',
    );
    await expect(client.getLogin()).rejects.toBeInstanceOf(NousLoginServiceError);
  });
});
