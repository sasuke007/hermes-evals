/**
 * The decision for one outbound connection, in two steps: the name and port
 * are checked before any DNS lookup (so the resolver cannot be used to leak
 * data, and allowlist mode never resolves names it would refuse), then every
 * address the name resolves to must be public. The connection is made to that
 * vetted address, never to the name, so there is no second lookup to rebind.
 */
import { isIP } from 'node:net';
import { isPublicAddress } from './addresses.js';
import type { Registration } from './registry.js';

export type Verdict = { allow: true } | { allow: false; reason: string };

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const PRIVATE_SUFFIXES = [
  '.internal',
  '.local',
  '.localhost',
  '.localdomain',
  '.lan',
  '.home.arpa',
  '.docker',
  '.intranet',
  '.corp',
];
const PUBLIC_PORTS = [80, 443];

export function normaliseHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

/** Checks a destination before resolving it. */
export function checkDestination(
  rawHost: string,
  port: number,
  registration: Registration,
): Verdict {
  const host = normaliseHost(rawHost.replace(/^\[|\]$/g, ''));
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    return { allow: false, reason: 'bad port' };

  const literal = isIP(host) !== 0;
  if (!literal && !HOSTNAME.test(host)) return { allow: false, reason: 'malformed host name' };

  if (registration.mode === 'allowlist') {
    if (!registration.allowHosts.map(normaliseHost).includes(host)) {
      return { allow: false, reason: 'host is not on the allowlist' };
    }
    if (!registration.allowPorts.includes(port))
      return { allow: false, reason: 'port is not allowed' };
    return literal && !isPublicAddress(host)
      ? { allow: false, reason: 'address is not public' }
      : { allow: true };
  }

  // public mode: any public host on the web ports
  if (!PUBLIC_PORTS.includes(port) && !registration.allowPorts.includes(port)) {
    return { allow: false, reason: 'port is not allowed' };
  }
  if (literal)
    return isPublicAddress(host)
      ? { allow: true }
      : { allow: false, reason: 'address is not public' };
  if (host === 'localhost' || !host.includes('.'))
    return { allow: false, reason: 'single-label names are not public' };
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { allow: false, reason: 'private name suffix' };
  }
  return { allow: true };
}

export type Resolver = (host: string) => Promise<string[]>;

/** Resolves a checked name and returns the address to connect to, if every answer is public. */
export async function resolvePublic(
  rawHost: string,
  resolve: Resolver,
): Promise<{ ok: true; address: string } | { ok: false; reason: string }> {
  const host = normaliseHost(rawHost.replace(/^\[|\]$/g, ''));
  if (isIP(host) !== 0) {
    return isPublicAddress(host)
      ? { ok: true, address: host }
      : { ok: false, reason: 'address is not public' };
  }
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    return { ok: false, reason: 'name does not resolve' };
  }
  if (addresses.length === 0) return { ok: false, reason: 'name does not resolve' };
  // One private answer refuses the whole name: a rebinding name can list both.
  const privateAnswer = addresses.find((address) => !isPublicAddress(address));
  if (privateAnswer)
    return { ok: false, reason: `resolves to a non-public address (${privateAnswer})` };
  return { ok: true, address: addresses[0]! };
}
