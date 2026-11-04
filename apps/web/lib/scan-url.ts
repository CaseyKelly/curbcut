import { isPrivateAddress } from '@curbcut/core/net';
import { isIP } from 'node:net';

/**
 * Quick checks on a URL typed into the scan form (#8), so an obvious mistake
 * gets an answer on the spot. The worker's scan proxy (#5) is the real guard:
 * it resolves DNS and checks every request, which catches names that point at
 * private addresses. These checks never replace it.
 */

const MAX_LENGTH = 2_048;
const TOO_LONG = `That address is too long. Use one of at most ${MAX_LENGTH.toLocaleString('en-US')} characters.`;

/**
 * `localhost` and `*.localhost`, or a literal address on the shared blocklist.
 * The URL parser has already turned `2130706433` and `0x7f.1` into `127.0.0.1`
 * and `[::ffff:7f00:1]` is checked as IPv4. A trailing dot (`localhost.`) names
 * the same host, and the parser keeps it, so it's dropped before comparing.
 */
function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[(.*)\]$/, '$1').replace(/\.+$/, '');
  if (isIP(host) !== 0) return isPrivateAddress(host);
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
  if (text.length > MAX_LENGTH) return { ok: false, error: TOO_LONG };

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
  // What gets stored and resent is the parsed form, which percent-encodes
  // non-ASCII characters and can be several times longer than what was typed.
  if (url.href.length > MAX_LENGTH) return { ok: false, error: TOO_LONG };
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
