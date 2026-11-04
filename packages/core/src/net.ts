// One list of addresses the scanner must not reach (#5, #8). The worker's scan
// proxy is the real guard and the web form uses the same list for a quick
// answer, so the two can't disagree. Its own subpath, not part of the Zod
// contract in the package index, because it needs `node:net` and the index is
// imported by browser code.
import { BlockList, isIP } from 'node:net';

// Anything that isn't routable on the public internet: loopback, private,
// link-local (including cloud metadata at 169.254.169.254), carrier-grade NAT,
// documentation and benchmark ranges, multicast, and reserved space. IPv6
// prefixes that embed an IPv4 address (NAT64, 6to4, Teredo) are blocked whole,
// since the embedded address could be private. IPv4-mapped IPv6 addresses
// (`::ffff:a.b.c.d`) are checked against the IPv4 rules by BlockList itself.
const blocked = new BlockList();
for (const [prefix, bits] of [
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
] as const) {
  blocked.addSubnet(prefix, bits, 'ipv4');
}
for (const [prefix, bits] of [
  // `::` itself, and IPv4-compatible addresses (`::a.b.c.d`), which are deprecated
  // and never public. Whether they'd reach an IPv4 host is stack-dependent, so
  // they're blocked whole.
  ['::', 96],
  ['::1', 128],
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
] as const) {
  blocked.addSubnet(prefix, bits, 'ipv6');
}

/** True for any address that isn't public. Anything that isn't an IP address counts as private. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}
