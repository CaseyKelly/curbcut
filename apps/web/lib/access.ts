/**
 * Who may use the app (#4). Pure functions so the rules are unit-tested
 * without Auth.js or a request; `auth.ts` and `lib/session.ts` apply them.
 */

/** Paths anyone may reach: the sign-in flow and the page that turns people away. */
export const PUBLIC_PATHS = ['/sign-in', '/not-authorized', '/api/auth'] as const;

export const SIGN_IN_PATH = '/sign-in';
export const NOT_AUTHORIZED_PATH = '/not-authorized';

/**
 * The sign-in page, carrying where to land afterwards. Auth.js only follows a
 * same-origin `callbackUrl`, and the sign-in page passes it straight on, so
 * `returnTo` must be one of our own paths: anything else gets no callback.
 */
export function signInPath(returnTo?: string): string {
  if (!returnTo || !/^\/(?![/\\])/.test(returnTo)) return SIGN_IN_PATH;
  return `${SIGN_IN_PATH}?callbackUrl=${encodeURIComponent(returnTo)}`;
}

/**
 * Parses `ALLOWED_GITHUB_LOGINS` (comma-separated). GitHub logins are
 * case-insensitive, so they're compared lowercased. An unset or empty value
 * allows no one: a missing env var must not open the app.
 */
export function parseAllowlist(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((login) => login.trim().toLowerCase())
      .filter((login) => login.length > 0),
  );
}

/** Read per call, not at import, so a changed allowlist applies without a rebuild. */
export function allowlistFromEnv(): ReadonlySet<string> {
  return parseAllowlist(process.env.ALLOWED_GITHUB_LOGINS);
}

export function isAllowedLogin(
  login: string | null | undefined,
  allowlist: ReadonlySet<string>,
): login is string {
  return typeof login === 'string' && allowlist.has(login.trim().toLowerCase());
}

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export type AccessDecision =
  | { kind: 'allow' }
  /** Pages: send the browser somewhere it can act. */
  | { kind: 'redirect'; to: typeof SIGN_IN_PATH | typeof NOT_AUTHORIZED_PATH }
  /** Route handlers: a status code, since a redirect means nothing to `fetch`. */
  | { kind: 'deny'; status: 401 | 403 };

/**
 * Decides a request from its path and the signed-in GitHub login, if any.
 * The allowlist is checked on every request, not only at sign-in, so removing
 * a login locks out a session that's already open.
 */
export function decideAccess(
  pathname: string,
  login: string | null | undefined,
  allowlist: ReadonlySet<string>,
): AccessDecision {
  if (isPublicPath(pathname)) return { kind: 'allow' };
  const isApi = pathname === '/api' || pathname.startsWith('/api/');
  if (!login) {
    return isApi ? { kind: 'deny', status: 401 } : { kind: 'redirect', to: SIGN_IN_PATH };
  }
  if (!isAllowedLogin(login, allowlist)) {
    return isApi ? { kind: 'deny', status: 403 } : { kind: 'redirect', to: NOT_AUTHORIZED_PATH };
  }
  return { kind: 'allow' };
}
