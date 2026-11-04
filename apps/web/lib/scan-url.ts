import { BlockList, isIP } from 'node:net';

/**
 * Quick checks on a URL typed into the scan form (#8), so an obvious mistake
 * gets an answer on the spot. The worker's scan proxy (#5) is the real guard:
 * it resolves DNS and checks every request, which catches names that point at
 * private addresses. These checks never replace it.
 */

const MAX_LENGTH = 2_048;

// Literal addresses only. The URL parser has already turned `2130706433` and
// `0x7f.1` into `127.0.0.1`, and `[::ffff:7f00:1]` is checked as IPv4.
const privateAddresses = new BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  privateAddresses.addSubnet(prefix, bits, 'ipv4');
}
for (const [prefix, bits] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const) {
  privateAddresses.addSubnet(prefix, bits, 'ipv6');
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[(.*)\]$/, '$1');
  const family = isIP(host);
  if (family !== 0) return privateAddresses.check(host, family === 4 ? 'ipv4' : 'ipv6');
  return host === 'localhost' || host.endsWith('.localhost');
}

export type ScanUrlResult = { ok: true; url: string } | { ok: false; error: string };

export interface ScanUrlOptions {
  /** Local development only: lets the form accept localhost, like the worker's setting. */
  allowPrivate?: boolean;
}

/**
 * `ALLOW_PRIVATE_SCAN_TARGETS` as the worker reads it. Ignored in production,
 * where the worker refuses to start with it set.
 */
export function allowPrivateFromEnv(): boolean {
  return process.env.ALLOW_PRIVATE_SCAN_TARGETS === 'true' && process.env.NODE_ENV !== 'production';
}

/** Error messages say what to do, since they're shown next to the field. */
export function validateScanUrl(
  input: string,
  { allowPrivate = false }: ScanUrlOptions = {},
): ScanUrlResult {
  const text = input.trim();
  if (text === '') return { ok: false, error: 'Enter the address of the page to scan.' };
  if (text.length > MAX_LENGTH) {
    return {
      ok: false,
      error: `That address is too long. Use one under ${MAX_LENGTH} characters.`,
    };
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return {
      ok: false,
      error: 'That doesn’t look like a web address. Start it with https:// or http://.',
    };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only http:// and https:// addresses can be scanned.' };
  }
  if (url.hostname === '') {
    return { ok: false, error: 'That address has no website name. Check it and try again.' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'Remove the username and password from the address.' };
  }
  if (!allowPrivate && isLocalHost(url.hostname)) {
    return {
      ok: false,
      error: 'Curbcut can only scan public websites, not localhost or private network addresses.',
    };
  }
  return { ok: true, url: url.href };
}
