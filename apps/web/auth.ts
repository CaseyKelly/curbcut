import NextAuth, { type DefaultSession } from 'next-auth';
import GitHub from 'next-auth/providers/github';
import { NextResponse } from 'next/server';
import {
  NOT_AUTHORIZED_PATH,
  SIGN_IN_PATH,
  allowlistFromEnv,
  decideAccess,
  isAllowedLogin,
} from './lib/access';

declare module 'next-auth' {
  interface Session {
    /** The GitHub login, which is what the allowlist and `created_by` use. */
    user: { login?: string; githubId?: number } & DefaultSession['user'];
  }
}

declare module '@auth/core/jwt' {
  interface JWT {
    login?: string;
    githubId?: number;
  }
}

/**
 * GitHub sign-in limited to `ALLOWED_GITHUB_LOGINS` (#4). Sessions are JWTs:
 * there's no users table yet (see the plan's Access decision). The provider
 * reads AUTH_GITHUB_ID and AUTH_GITHUB_SECRET, and Auth.js reads AUTH_SECRET.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub],
  pages: { signIn: SIGN_IN_PATH, error: SIGN_IN_PATH },
  callbacks: {
    // Turn strangers away before a session exists.
    signIn({ profile }) {
      const login = typeof profile?.login === 'string' ? profile.login : undefined;
      return isAllowedLogin(login, allowlistFromEnv()) ? true : NOT_AUTHORIZED_PATH;
    },
    jwt({ token, profile }) {
      if (typeof profile?.login === 'string') token.login = profile.login;
      // The numeric id is stable across renames; scans record it as their author (#8).
      if (typeof profile?.id === 'number') token.githubId = profile.id;
      return token;
    },
    session({ session, token }) {
      session.user.login = token.login;
      session.user.githubId = token.githubId;
      return session;
    },
    // Runs in proxy.ts for every matched request.
    authorized({ request, auth }) {
      const decision = decideAccess(
        request.nextUrl.pathname,
        auth?.user?.login,
        allowlistFromEnv(),
      );
      switch (decision.kind) {
        case 'allow':
          return true;
        case 'deny':
          return NextResponse.json(
            { error: decision.status === 401 ? 'Sign in required' : 'Not authorized' },
            { status: decision.status },
          );
        case 'redirect':
          // `false` makes Auth.js redirect to the sign-in page with a callbackUrl.
          return decision.to === SIGN_IN_PATH
            ? false
            : NextResponse.redirect(new URL(decision.to, request.nextUrl));
      }
    },
  },
});
