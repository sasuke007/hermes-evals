import { describe, expect, it } from 'vitest';
import { missingSecretsConflictMessage, type MissingMcpSecret } from '@hermes-evals/shared';
import { ApiError } from '@/api/client';
import type { ProviderInfo } from '@/api/types/system';
import {
  launchBlockers,
  launchFailure,
  providerReady,
  providerTag,
  secretsApplyCommand,
  unsetSecrets,
  type ProviderSnapshot,
} from '../launchReadiness';

function provider(id: ProviderInfo['id'], status: ProviderInfo['status']): ProviderInfo {
  const key = id !== 'nous';
  return {
    id,
    name: { nous: 'Nous Portal', openrouter: 'OpenRouter', custom: 'Custom' }[id as string] ?? id,
    authMethod: key ? 'env-key' : 'oauth-device',
    status,
    scope: null,
    envVar: key ? `${id.toUpperCase()}_API_KEY` : null,
    applyCommand: key ? 'docker compose up -d egress worker' : null,
    hostCommand: key ? null : 'hermes proxy start --provider nous',
    billingUrl: null,
    usedBy: [],
    pausedExperiments: 0,
    login: null,
  };
}

function snapshot(
  nous: ProviderInfo['status'],
  openrouter: ProviderInfo['status'],
): ProviderSnapshot {
  return {
    loaded: true,
    providers: [
      provider('nous', nous),
      provider('openrouter', openrouter),
      provider('custom', 'configured'),
    ],
    nousStatus: nous,
    nousConnected: nous === 'connected' || nous === 'host',
  };
}
const READY = { noWorker: false, sandboxProven: true };

describe('launchReadiness', () => {
  it('treats unknown as ready, custom always, Nous by its login and keys by presence', () => {
    expect(providerReady({ ...snapshot('not_connected', 'missing'), loaded: false }, 'nous')).toBe(
      true,
    );
    const s = snapshot('host', 'missing');
    expect(providerReady(s, 'nous')).toBe(true);
    expect(providerReady(s, 'custom')).toBe(true);
    expect(providerReady(s, 'openrouter')).toBe(false);
    expect(providerReady(s, 'openai')).toBe(true);
  });

  it('tags a configuration row by why its provider is not ready', () => {
    expect(providerTag(snapshot('not_connected', 'configured'), 'nous')).toBe(
      'Nous Portal not connected',
    );
    expect(providerTag(snapshot('relogin_required', 'configured'), 'nous')).toBe(
      'Nous Portal needs renewing',
    );
    expect(providerTag(snapshot('host_unreachable', 'configured'), 'nous')).toBe(
      'Nous Portal proxy not running',
    );
    expect(providerTag(snapshot('connected', 'missing'), 'openrouter')).toBe(
      'OpenRouter key missing',
    );
    expect(providerTag(snapshot('connected', 'missing'), 'nous')).toBeNull();
  });

  it('blocks per provider, in the order chosen, naming the configurations it blocks', () => {
    const blockers = launchBlockers(snapshot('not_connected', 'missing'), READY, [
      { name: 'or-baseline', provider: 'openrouter' },
      { name: 'baseline', provider: 'nous' },
      { name: 'with-skill', provider: 'nous' },
      { name: 'mock', provider: 'custom' },
    ]);
    expect(blockers.map((b) => [b.fix, b.reason, b.configurations])).toEqual([
      ['add-key', "Can't launch yet: OpenRouter has no API key.", ['or-baseline']],
      ['connect', "Can't launch yet: Nous Portal is not connected.", ['baseline', 'with-skill']],
    ]);
    expect(blockers[0]).toMatchObject({
      envVar: 'OPENROUTER_API_KEY',
      command: 'docker compose up -d egress worker',
    });
  });

  it("offers the host proxy's command instead of Connect in development", () => {
    const [blocker] = launchBlockers(snapshot('host_unreachable', 'configured'), READY, [
      { name: 'baseline', provider: 'nous' },
    ]);
    expect(blocker).toMatchObject({
      fix: 'command',
      reason: "Can't launch yet: this machine's Hermes proxy is not running.",
      command: 'hermes proxy start --provider nous',
    });
  });

  it('blocks on a missing worker, else on an unproven sandbox', () => {
    const s = snapshot('connected', 'configured');
    const chosen = [{ name: 'a', provider: 'nous' as const }];
    expect(launchBlockers(s, { noWorker: true, sandboxProven: false }, chosen)).toMatchObject([
      {
        reason: "Can't launch yet: no worker is connected.",
        command: 'docker compose up -d worker',
      },
    ]);
    expect(launchBlockers(s, { noWorker: false, sandboxProven: false }, chosen)).toMatchObject([
      { reason: "Can't launch yet: the sandbox self-test has not passed.", fix: 'system' },
    ]);
    expect(launchBlockers(s, READY, chosen)).toEqual([]);
  });

  it('reads each refused launch the way the panel words it', () => {
    const refused = (detail: string, status = 409) =>
      launchFailure(new ApiError(status, 'POST /api/experiments', detail));
    expect(
      refused('configuration with-skill changed since you opened this form (now v2)'),
    ).toMatchObject({
      kind: 'conflict',
      title: 'Launch failed',
      hint: 'Review the comparison above, then launch again.',
    });
    expect(refused('Nous Portal is not connected.')).toMatchObject({
      kind: 'provider',
      title: 'Launch refused: Nous Portal is not connected.',
      message: 'POST /api/experiments → 409 · Nous Portal is not connected.',
      action: 'connect',
    });
    expect(refused('Your Nous Portal login needs renewing. Reconnect Nous Portal.')).toMatchObject({
      kind: 'provider',
      action: 'reconnect',
    });
    expect(
      refused(
        'Launch needs a judge model for the late_fees.method judge: set JUDGE_MODEL in .env, then docker compose up -d api worker.',
      ),
    ).toMatchObject({ kind: 'judge', title: 'Launch refused: the LLM judge is not ready.' });
    expect(
      refused(
        'No worker is connected, so runs cannot start. Start one with: docker compose up -d worker',
      ),
    ).toMatchObject({ kind: 'refused', title: 'Launch refused', action: null });
    const invalid = launchFailure(
      new ApiError(400, 'POST /api/experiments', 'Validation failed', [
        { path: 'taskKeys.0', message: 'late_fees is invalid and cannot run: …' },
      ]),
    );
    expect(invalid).toMatchObject({ kind: 'invalid', title: 'Launch failed' });
    expect(invalid.hint).toContain('taskKeys.0: late_fees is invalid and cannot run');
    expect(launchFailure(new Error('boom'))).toMatchObject({ kind: 'other', message: 'boom' });
  });

  describe('MCP variables that are not set (Phase 6 S7)', () => {
    const dbUrl: MissingMcpSecret = {
      server: 'invoice-db',
      name: 'INVOICE_DB_URL',
      transport: 'stdio',
    };
    const token: MissingMcpSecret = {
      server: 'vendor-directory',
      name: 'VENDOR_DIRECTORY_TOKEN',
      transport: 'http',
    };
    const ok = snapshot('connected', 'configured');

    it('blocks each configuration that names one, after the providers, before the worker', () => {
      const blockers = launchBlockers(snapshot('connected', 'missing'), { ...READY }, [
        { name: 'baseline', provider: 'nous', missingSecrets: [] },
        { name: 'or-mcp', provider: 'openrouter', missingSecrets: [token] },
        { name: 'with-mcp', provider: 'nous', missingSecrets: [dbUrl, token] },
      ]);
      expect(blockers.map((b) => [b.fix, b.reason, b.configurations])).toEqual([
        ['add-key', "Can't launch yet: OpenRouter has no API key.", ['or-mcp']],
        [
          'secrets',
          'or-mcp: VENDOR_DIRECTORY_TOKEN (vendor-directory, added by egress) is not set.',
          ['or-mcp'],
        ],
        [
          'secrets',
          'with-mcp: INVOICE_DB_URL (invoice-db, read by the worker) and VENDOR_DIRECTORY_TOKEN (vendor-directory, added by egress) are not set.',
          ['with-mcp'],
        ],
      ]);
      expect(blockers[2]).toMatchObject({
        detail:
          'Set each in .env, then recreate the worker (stdio) or egress (http) so it reads them.',
        command: 'docker compose up -d egress worker',
        missing: [dbUrl, token],
      });
    });

    it('recreates the service that reads the variable', () => {
      expect(secretsApplyCommand([dbUrl])).toBe('docker compose up -d worker');
      expect(secretsApplyCommand([token])).toBe('docker compose up -d egress');
      expect(secretsApplyCommand([token, dbUrl])).toBe('docker compose up -d egress worker');
    });

    it('says nothing about variables while no worker is live: nothing vouches for any name', () => {
      const chosen = [{ name: 'with-mcp', provider: 'nous' as const, missingSecrets: [dbUrl] }];
      expect(unsetSecrets(chosen[0]!, { noWorker: true })).toEqual([]);
      expect(unsetSecrets(chosen[0]!, { noWorker: false })).toEqual([dbUrl]);
      expect(
        launchBlockers(ok, { noWorker: true, sandboxProven: true }, chosen).map((b) => b.reason),
      ).toEqual(["Can't launch yet: no worker is connected."]);
      expect(launchBlockers(ok, READY, [{ name: 'a', provider: 'nous' }])).toEqual([]);
    });

    it('reads the launch 409 for unset variables as its own refusal', () => {
      const detail = missingSecretsConflictMessage([
        { configuration: 'with-mcp', missing: [dbUrl] },
      ]);
      expect(launchFailure(new ApiError(409, 'POST /api/experiments', detail))).toMatchObject({
        kind: 'secrets',
        title: "Launch refused: an MCP server's variables are not set.",
        message: `POST /api/experiments → 409 · ${detail}`,
        action: null,
      });
    });
  });
});
