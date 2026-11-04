import { getDb } from '@/lib/db';
import { scanEventStream, SSE_HEADERS } from '@/lib/scan-events';
import { isScanId, loadScanSignature, loadScanView } from '@/lib/scan-queries';
import { currentLogin } from '@/lib/session';

/** Live progress for one scan (#8): the scan's state over Server-Sent Events. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // proxy.ts answers 401 and 403 first; this check doesn't depend on it.
  if ((await currentLogin()) === null) {
    return Response.json({ error: 'Sign in required' }, { status: 401 });
  }
  const { id } = await params;
  if (!isScanId(id)) return Response.json({ error: 'Scan not found' }, { status: 404 });

  const db = getDb();
  if ((await loadScanSignature(db, id)) === null) {
    return Response.json({ error: 'Scan not found' }, { status: 404 });
  }

  const stream = scanEventStream(
    { signature: () => loadScanSignature(db, id), load: () => loadScanView(db, id) },
    { signal: request.signal },
  );
  return new Response(stream, { headers: SSE_HEADERS });
}
