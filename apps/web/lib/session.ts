import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { NOT_AUTHORIZED_PATH, allowlistFromEnv, isAllowedLogin, signInPath } from './access';

/**
 * Session checks for pages and route handlers (#4). proxy.ts gates requests
 * too, but every non-public page and route handler calls one of these as
 * well, so the check doesn't depend on the proxy matcher. `routes.test.ts`
 * enforces that.
 */

/** The signed-in, allowlisted GitHub login, or null. For route handlers: answer 401 on null. */
export async function currentLogin(): Promise<string | null> {
  const session = await auth();
  const login = session?.user?.login;
  return isAllowedLogin(login, allowlistFromEnv()) ? login : null;
}

export interface SignedInUser {
  login: string;
  /** Numeric GitHub user id, recorded on scans (#8). */
  githubId: number;
}

/**
 * For pages and server actions: returns the allowlisted user or redirects to
 * sign in or away. A session from before the id was stored has none, so it
 * signs in again once; pass `returnTo` (a path of ours) so they land back where
 * they were.
 */
export async function requireUser(returnTo?: string): Promise<SignedInUser> {
  const session = await auth();
  const login = session?.user?.login;
  const githubId = session?.user?.githubId;
  if (!login || githubId === undefined) redirect(signInPath(returnTo));
  if (!isAllowedLogin(login, allowlistFromEnv())) redirect(NOT_AUTHORIZED_PATH);
  return { login, githubId };
}
