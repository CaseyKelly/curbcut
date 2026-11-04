import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Not found · Curbcut' };

export default function NotFound() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-semibold">Page not found</h1>
      <p className="mt-4 text-neutral-700">
        There’s nothing at this address. A scan that was deleted, or a mistyped link, looks like
        this.
      </p>
      <p className="mt-4">
        <Link href="/" className="text-blue-800 underline hover:no-underline">
          Scan a page
        </Link>
      </p>
    </main>
  );
}
