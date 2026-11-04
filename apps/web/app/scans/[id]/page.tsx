import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ScanLive } from '@/components/scan-live';
import { getDb } from '@/lib/db';
import { loadScanView } from '@/lib/scan-queries';
import { requireUser } from '@/lib/session';

export const metadata: Metadata = { title: 'Scan · Curbcut' };

type Props = { params: Promise<{ id: string }> };

/** One scan (#8): its progress, then its issues grouped by rule. */
export default async function ScanPage({ params }: Props) {
  await requireUser();
  const { id } = await params;
  const view = await loadScanView(getDb(), id);
  if (!view) notFound();

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <p>
        <Link href="/" className="text-blue-800 underline hover:no-underline">
          Scan another page
        </Link>
      </p>
      <h1 className="mt-4 text-3xl font-semibold">Scan results</h1>
      <p className="mt-2 text-neutral-700">
        {view.targets.length === 1 ? 'Page: ' : 'Pages: '}
        <span className="break-all">{view.targets.join(', ')}</span>
      </p>
      <ScanLive initial={view} />
    </main>
  );
}
