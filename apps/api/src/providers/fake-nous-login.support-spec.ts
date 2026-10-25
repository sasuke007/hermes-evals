/**
 * An in-process stand-in for nous-login (docker/nous-login.py) for the
 * providers tests: the same routes and bodies, with the volume and the login
 * as plain fields a test sets. The real service runs against a fake portal
 * in the gated docker test (test/fake-portal/nous-login.docker.spec.ts).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NousLogin } from '@hermes-evals/shared';
import type { NousLoginStatus, NousVolumeState } from './nous-login.client.js';

export const FAKE_USER_CODE = 'FAKE-0001';
export const FAKE_PORTAL = 'http://portal.test';

export const endedLogin = (state: NousLogin['state'], error: string | null = null): NousLogin => ({
  state,
  userCode: null,
  verifyUrl: null,
  expiresAt: null,
  error,
  billingUrl: state === 'needs_subscription' ? `${FAKE_PORTAL}/billing` : null,
});

export const waitingLogin = (): NousLogin => ({
  state: 'waiting_for_approval',
  userCode: FAKE_USER_CODE,
  verifyUrl: `${FAKE_PORTAL}/device?user_code=${FAKE_USER_CODE}`,
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  error: null,
  billingUrl: null,
});

export class FakeNousLogin {
  /** What the volume holds (never `unavailable`: set `unavailable` for that). */
  volume: Exclude<NousVolumeState, 'unavailable'> = 'not_connected';
  /** The startup check's reason; every login route answers 503 while set. */
  unavailable: string | null = null;
  /** The pending or last failed login. */
  login: NousLogin | null = null;
  /** Leave requests unanswered, to exercise the client's deadlines. */
  hang = false;
  /** Answer every request with this status and a non-contract body. */
  brokenStatus: number | null = null;
  readonly calls: string[] = [];
  url = '';
  private readonly server: Server;

  constructor() {
    this.server = createServer((req, res) => {
      const route = `${req.method} ${req.url}`;
      this.calls.push(route);
      req.resume();
      if (this.hang) return;
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (this.brokenStatus !== null) return send(this.brokenStatus, { error: 'Boom: broken' });
      if (route === 'GET /status') return send(200, this.status());
      if (this.unavailable) return send(503, { state: 'unavailable', reason: this.unavailable });
      switch (route) {
        case 'POST /login':
          this.login = waitingLogin();
          return send(200, this.login);
        case 'GET /login':
          return send(200, this.loginView());
        case 'DELETE /login':
          this.login = null;
          return send(200, this.loginView());
        case 'POST /logout':
          this.login = null;
          this.volume = 'not_connected';
          return send(200, this.loginView());
        default:
          return send(404, { error: 'not found' });
      }
    });
  }

  async listen(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** The user approved in the portal: the volume holds a login. */
  approve(): void {
    this.volume = 'connected';
    this.login = null;
  }

  status(): NousLoginStatus {
    const base = {
      source: 'volume' as const,
      portalUrl: FAKE_PORTAL,
      billingUrl: `${FAKE_PORTAL}/billing`,
    };
    if (this.unavailable) {
      return {
        ...base,
        state: 'unavailable',
        scope: null,
        relogin_required: false,
        reason: this.unavailable,
        login: null,
      };
    }
    return {
      ...base,
      state: this.volume,
      scope: this.volume === 'connected' ? 'inference:invoke' : null,
      relogin_required: this.volume === 'relogin_required',
      reason: null,
      login: this.login,
    };
  }

  private loginView(): NousLogin {
    return this.login ?? endedLogin(this.volume === 'connected' ? 'connected' : 'not_connected');
  }
}
