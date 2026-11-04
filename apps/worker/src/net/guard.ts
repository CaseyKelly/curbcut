// SSRF guard (#5): the scanner only loads http/https pages on public addresses.
// `resolvePublic` is the single check; the scan proxy runs it on every request
// the browser makes, so redirects, subresources, and DNS that changes between
// checks are all covered, not just the URL a user typed.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPrivateAddress } from '@curbcut/core/net';
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

export { isPrivateAddress };

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
