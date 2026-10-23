/**
 * Which destinations a trial may reach. Anything that is not a public unicast
 * address is refused: loopback, RFC 1918, link-local and cloud metadata,
 * CGNAT, documentation and benchmark ranges, multicast, the IPv6 equivalents,
 * and IPv6 forms that wrap an IPv4 address (mapped, NAT64, 6to4, Teredo).
 * Docker's own networks, Colima's 192.168.5.x and Docker Desktop's
 * 192.168.65.x all fall inside these ranges.
 */
import { BlockList, isIP } from 'node:net';

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const BLOCKED_V6: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];

// Two lists, each consulted only for its own family: Node's BlockList matches
// IPv4 addresses against an IPv4-mapped IPv6 rule, so one shared list holding
// ::ffff:0:0/96 would refuse every IPv4 address.
const blockedV4 = new BlockList();
for (const [network, prefix] of BLOCKED_V4) blockedV4.addSubnet(network, prefix, 'ipv4');
const blockedV6 = new BlockList();
for (const [network, prefix] of BLOCKED_V6) blockedV6.addSubnet(network, prefix, 'ipv6');

/** True only for a syntactically valid IP that is public unicast. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, 'ipv4');
  if (family === 6) return !blockedV6.check(address, 'ipv6');
  return false;
}
