'use server';

import { redirect } from 'next/navigation';
import { getDb } from '@/lib/db';
import { createScan } from '@/lib/scan-create';
import { allowPrivateFromEnv, validateScanUrl } from '@/lib/scan-url';
import { requireUser } from '@/lib/session';

export interface ScanFormState {
  /** What was typed, so the field keeps it when there's an error. */
  url: string;
  error: string | null;
}

/** The scan form's action (#8): checks the URL, queues a scan, and goes to its page. */
export async function startScan(
  _previous: ScanFormState,
  formData: FormData,
): Promise<ScanFormState> {
  // A server action is a public endpoint, so it checks the session itself.
  const user = await requireUser();

  const raw = formData.get('url');
  const url = typeof raw === 'string' ? raw : '';
  const checked = validateScanUrl(url, { allowPrivate: allowPrivateFromEnv() });
  if (!checked.ok) return { url, error: checked.error };

  let scanId: string;
  try {
    scanId = await createScan(getDb(), checked.url, user);
  } catch (err) {
    console.error('startScan: could not queue the scan', err);
    return { url, error: 'Couldn’t start the scan. Try again in a moment.' };
  }
  // Outside the try: redirect() works by throwing.
  redirect(`/scans/${scanId}`);
}
