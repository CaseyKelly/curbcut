// SSRF guard (#5): the scanner only loads http/https pages on public addresses.
// `resolvePublic` is the single check; the scan proxy runs it on every request
// the browser makes, so redirects, subresources, and DNS that changes between
// checks are all covered, not just the URL a user typed.
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { UnsafeUrlError } from '../errors';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface GuardOptions {
  /** Defaults to `isPrivateAddress`. Local development can allow everything. */
  isBlockedAddress?: (address: string) => boolean;
  /** Defaults to the system resolver. Tests map hostnames to fixed addresses. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
}

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
  ['::', 128],
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

async function systemResolve(hostname: string): Promise<ResolvedAddress[]> {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
}

/**
 * Resolves `hostname` and returns an address to connect to. Throws
 * `UnsafeUrlError` if any answer is blocked, so a name that mixes public and
 * private records can't be used to slip through.
 */
export async function resolvePublic(
  hostname: string,
  { isBlockedAddress = isPrivateAddress, resolve = systemResolve }: GuardOptions = {},
): Promise<ResolvedAddress> {
  const host = hostname.replace(/^\[(.*)\]$/, '$1');
  const family = isIP(host);
  const answers = family ? [{ address: host, family: family as 4 | 6 }] : await resolve(host);
  if (answers.length === 0) throw new Error(`${host} did not resolve`);
  const bad = answers.find((a) => isBlockedAddress(a.address));
  if (bad) throw new UnsafeUrlError(`${host} resolves to a private address (${bad.address})`);
  return answers[0]!;
}

/** Checks a scan target before the browser loads it, for a clear error up front. */
export async function assertScanUrl(url: string, options?: GuardOptions): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeUrlError(`Not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeUrlError(`Only http and https URLs can be scanned, not ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new UnsafeUrlError('URLs with credentials in them are not scanned');
  }
  await resolvePublic(parsed.hostname, options);
  return parsed;
}
