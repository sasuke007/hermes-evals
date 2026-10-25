import { describe, expect, it, vi } from 'vitest';
import { isPublicAddress } from '../src/addresses.js';
import { checkDestination, resolvePublic } from '../src/policy.js';
import type { Registration } from '../src/registry.js';

const registration = (overrides: Partial<Registration> = {}): Registration => ({
  attemptId: '01K8ZQ7M3V5X9C2B4N6P8R0T1W',
  token: 'x'.repeat(48),
  mode: 'public',
  allowHosts: [],
  allowPorts: [443],
  provider: 'mock',
  models: [],
  expiresAt: Date.now() + 60_000,
  mcp: [],
  ...overrides,
});

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.17.0.1',
    '172.31.255.255',
    '192.168.5.2', // Colima host
    '192.168.65.254', // Docker Desktop host.docker.internal
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '64:ff9b::7f00:1', // NAT64 of 127.0.0.1
    '2002:7f00:1::', // 6to4 of 127.0.0.1
    '2001:0:7f00:1::', // Teredo
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    'not-an-ip',
  ])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['93.184.216.34', '1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])(
    'allows %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});

describe('checkDestination', () => {
  it('in allowlist mode allows only listed hosts and ports', () => {
    const reg = registration({
      mode: 'allowlist',
      allowHosts: ['mcp.example.com'],
      allowPorts: [443],
    });
    expect(checkDestination('mcp.example.com', 443, reg).allow).toBe(true);
    expect(checkDestination('MCP.Example.com.', 443, reg).allow).toBe(true);
    expect(checkDestination('example.com', 443, reg).allow).toBe(false);
    expect(checkDestination('mcp.example.com', 22, reg).allow).toBe(false);
    expect(checkDestination('1.1.1.1', 443, reg).allow).toBe(false);
  });

  it('in public mode refuses internal names, IP literals that are private, and odd ports', () => {
    const reg = registration();
    for (const host of [
      'postgres',
      'api',
      'localhost',
      'host.docker.internal',
      'host.lima.internal',
      'printer.local',
      'nas.lan',
      'router.home.arpa',
      '127.0.0.1',
      '[::1]',
      '169.254.169.254',
    ]) {
      expect(checkDestination(host, 443, reg).allow, host).toBe(false);
    }
    expect(checkDestination('example.com', 22, reg).allow).toBe(false);
    expect(checkDestination('example.com', 443, reg).allow).toBe(true);
    expect(checkDestination('1.1.1.1', 443, reg).allow).toBe(true);
  });

  it('refuses malformed names', () => {
    for (const host of ['exa mple.com', 'a..b', '-x.com', 'user@host.com', '']) {
      expect(checkDestination(host, 443, registration()).allow, host).toBe(false);
    }
  });
});

describe('resolvePublic', () => {
  // What getaddrinfo answers for the usual bypass tricks.
  const answers: Record<string, string[]> = {
    '2130706433': ['127.0.0.1'],
    '0x7f000001': ['127.0.0.1'],
    'localtest.me': ['127.0.0.1'],
    '7f000001.5db8d822.rbndr.us': ['93.184.216.34', '127.0.0.1'],
    'metadata.example': ['169.254.169.254'],
    'example.com': ['93.184.216.34'],
  };
  const resolve = async (host: string) => {
    const result = answers[host];
    if (!result) throw new Error('ENOTFOUND');
    return result;
  };

  it.each([
    '2130706433',
    '0x7f000001',
    'localtest.me',
    '7f000001.5db8d822.rbndr.us',
    'metadata.example',
    'nowhere.invalid',
  ])('refuses %s', async (host) => {
    expect((await resolvePublic(host, resolve)).ok).toBe(false);
  });

  it('returns the vetted address for a public name', async () => {
    expect(await resolvePublic('example.com', resolve)).toEqual({
      ok: true,
      address: '93.184.216.34',
    });
  });

  it('never resolves a name that allowlist mode refuses', async () => {
    const spy = vi.fn(resolve);
    const reg = registration({ mode: 'allowlist', allowHosts: [] });
    const verdict = checkDestination('secret-data.attacker.example', 443, reg);
    if (verdict.allow) await resolvePublic('secret-data.attacker.example', spy);
    expect(verdict.allow).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
