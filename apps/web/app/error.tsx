'use client';

import { useEffect } from 'react';

/** Shown when a page fails to load, such as when the database is unreachable (#8). */
export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-semibold">Something went wrong</h1>
      <p role="alert" className="mt-4 text-neutral-700">
        This page couldn’t load. Try again, and if it keeps happening, check that the database is
        running.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-6 rounded-md border border-neutral-900 px-4 py-2 font-medium hover:bg-neutral-100"
      >
        Try again
      </button>
    </main>
  );
}
