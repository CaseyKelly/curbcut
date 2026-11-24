import type { Metadata } from 'next';
import { signIn } from '@/auth';
import { safeReturnTo } from '@/lib/access';

export const metadata: Metadata = { title: 'Sign in · Curbcut' };

type Props = {
  searchParams: Promise<{ callbackUrl?: string | string[]; error?: string | string[] }>;
};

/**
 * Public (#4). `callbackUrl` comes from the address bar, so it's only passed on
 * if it's a path of ours. Auth.js checks the origin too.
 */
export default async function SignInPage({ searchParams }: Props) {
  const { callbackUrl, error } = await searchParams;
  const redirectTo = safeReturnTo(callbackUrl) ?? '/';

  async function signInWithGitHub() {
    'use server';
    await signIn('github', { redirectTo });
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-semibold">Sign in to Curbcut</h1>
      <p className="mt-4 text-neutral-700">Curbcut is private. Sign in with your GitHub account.</p>
      {error ? (
        <p role="alert" className="mt-4 text-red-800">
          Sign-in didn&apos;t work. Try again.
        </p>
      ) : null}
      <form action={signInWithGitHub} className="mt-8">
        <button
          type="submit"
          className="rounded-md bg-neutral-900 px-4 py-2 font-medium text-white hover:bg-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
        >
          Sign in with GitHub
        </button>
      </form>
    </main>
  );
}
