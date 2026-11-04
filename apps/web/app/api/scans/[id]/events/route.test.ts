import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanView } from '@/lib/scan-view';

const mocks = vi.hoisted(() => ({
  currentLogin: vi.fn<() => Promise<string | null>>(),
  loadScanSignature: vi.fn<() => Promise<string | null>>(),
  loadScanView: vi.fn<() => Promise<ScanView | null>>(),
}));

vi.mock('@/lib/session', () => ({ currentLogin: mocks.currentLogin }));
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('@/lib/scan-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/scan-queries')>()),
  loadScanSignature: mocks.loadScanSignature,
  loadScanView: mocks.loadScanView,
}));

const { GET } = await import('./route');

const ID = '4b1f5f0e-6c0d-4a4e-9a58-3d5e6b0d6c11';
const get = (id: string, signal = new AbortController().signal) =>
  GET(new Request(`http://localhost/api/scans/${id}/events`, { signal }), {
    params: Promise.resolve({ id }),
  });

const finished: ScanView = {
  id: ID,
  targets: ['https://example.com/'],
  stage: 'done',
  error: null,
  explainStatus: null,
  explainError: null,
  issueCount: 0,
  groups: [],
};

describe('GET /api/scans/[id]/events', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.currentLogin.mockResolvedValue('casey');
    mocks.loadScanSignature.mockResolvedValue('v1');
    mocks.loadScanView.mockResolvedValue(finished);
  });

  it('answers 401 without a session, and reads nothing', async () => {
    mocks.currentLogin.mockResolvedValue(null);
    const res = await get(ID);
    expect(res.status).toBe(401);
    expect(mocks.loadScanSignature).not.toHaveBeenCalled();
  });

  it('answers 404 for an id that is not a UUID, without touching the database', async () => {
    const res = await get('not-a-uuid');
    expect(res.status).toBe(404);
    expect(mocks.loadScanSignature).not.toHaveBeenCalled();
  });

  it('answers 404 for a scan that does not exist', async () => {
    mocks.loadScanSignature.mockResolvedValue(null);
    const res = await get(ID);
    expect(res.status).toBe(404);
  });

  it('streams events with the headers an SSE client and proxies need', async () => {
    const res = await get(ID);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const body = await res.text();
    expect(body).toContain('event: scan\n');
    expect(body).toContain('event: done\ndata: {"reason":"final"}');
  });
});
