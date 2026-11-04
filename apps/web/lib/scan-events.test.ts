import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scanEventStream, type ScanEventSource } from './scan-events';
import type { ScanView } from './scan-view';

const view = (stage: ScanView['stage'], explained = 0): ScanView => ({
  id: '4b1f5f0e-6c0d-4a4e-9a58-3d5e6b0d6c11',
  targets: ['https://example.com/'],
  stage,
  error: null,
  explainStatus: stage === 'done' ? 'completed' : null,
  explainError: null,
  issueCount: explained,
  groups: [],
});

/** Collects a stream's text as it arrives. */
function collect(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  const state = { text: '', ended: false };
  const reader = stream.getReader();
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      state.text += decoder.decode(value);
    }
    state.ended = true;
  })();
  return state;
}

/** The `scan` events' views, in order. */
function scanViews(text: string): ScanView[] {
  return [...text.matchAll(/event: scan\ndata: (.*)\n\n/g)].map(
    (m) => JSON.parse(m[1]!) as ScanView,
  );
}

describe('scanEventStream', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A scan whose state the test moves along. */
  function fakeScan(initial: ScanView | null) {
    const current = { view: initial, version: 0 };
    const source: ScanEventSource = {
      signature: vi.fn(() => Promise.resolve(current.view ? `v${current.version}` : null)),
      load: vi.fn(() => Promise.resolve(current.view)),
    };
    return {
      source,
      set(next: ScanView | null) {
        current.view = next;
        current.version++;
      },
    };
  }

  it('sends the current state first, then only changes', async () => {
    const scan = fakeScan(view('queued'));
    const ctrl = new AbortController();
    const out = collect(scanEventStream(scan.source, { signal: ctrl.signal, pollMs: 500 }));

    await vi.advanceTimersByTimeAsync(0);
    expect(out.text).toContain('retry: 3000');
    expect(scanViews(out.text).map((v) => v.stage)).toEqual(['queued']);

    // Nothing changed: nothing is sent, and the view isn't rebuilt.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(scanViews(out.text)).toHaveLength(1);
    expect(scan.source.load).toHaveBeenCalledTimes(1);

    scan.set(view('scanning'));
    await vi.advanceTimersByTimeAsync(500);
    scan.set(view('explaining', 3));
    await vi.advanceTimersByTimeAsync(500);
    expect(scanViews(out.text).map((v) => v.stage)).toEqual(['queued', 'scanning', 'explaining']);
    expect(out.ended).toBe(false);
    ctrl.abort();
  });

  it('sends done and closes when the scan reaches a final state', async () => {
    const scan = fakeScan(view('explaining', 2));
    const out = collect(
      scanEventStream(scan.source, { signal: new AbortController().signal, pollMs: 500 }),
    );
    await vi.advanceTimersByTimeAsync(0);
    scan.set(view('done', 2));
    await vi.advanceTimersByTimeAsync(500);

    expect(out.ended).toBe(true);
    expect(scanViews(out.text).map((v) => v.stage)).toEqual(['explaining', 'done']);
    expect(out.text.endsWith('event: done\ndata: {"reason":"final"}\n\n')).toBe(true);

    // And it has stopped polling.
    const calls = vi.mocked(scan.source.signature).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(scan.source.signature).toHaveBeenCalledTimes(calls);
  });

  it('closes right away, with the final view, for a scan that is already finished', async () => {
    const scan = fakeScan(view('failed'));
    const out = collect(
      scanEventStream(scan.source, { signal: new AbortController().signal, pollMs: 500 }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(out.ended).toBe(true);
    expect(scanViews(out.text).map((v) => v.stage)).toEqual(['failed']);
  });

  it('says so and closes if the scan disappears', async () => {
    const scan = fakeScan(view('scanning'));
    const out = collect(
      scanEventStream(scan.source, { signal: new AbortController().signal, pollMs: 500 }),
    );
    await vi.advanceTimersByTimeAsync(0);
    scan.set(null);
    await vi.advanceTimersByTimeAsync(500);
    expect(out.ended).toBe(true);
    expect(out.text).toContain('event: done\ndata: {"reason":"gone"}');
  });

  it('stops polling when the browser disconnects', async () => {
    const scan = fakeScan(view('scanning'));
    const ctrl = new AbortController();
    const out = collect(scanEventStream(scan.source, { signal: ctrl.signal, pollMs: 500 }));
    await vi.advanceTimersByTimeAsync(500);
    ctrl.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(out.ended).toBe(true);

    const calls = vi.mocked(scan.source.signature).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(scan.source.signature).toHaveBeenCalledTimes(calls);
  });

  it('stops polling when the reader cancels the stream', async () => {
    const scan = fakeScan(view('scanning'));
    const stream = scanEventStream(scan.source, {
      signal: new AbortController().signal,
      pollMs: 500,
    });
    const reader = stream.getReader();
    await reader.read();
    await vi.advanceTimersByTimeAsync(500);
    await reader.cancel();

    const calls = vi.mocked(scan.source.signature).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(scan.source.signature).toHaveBeenCalledTimes(calls);
  });

  it('sends a comment now and then on a quiet connection', async () => {
    const scan = fakeScan(view('queued'));
    const ctrl = new AbortController();
    const out = collect(
      scanEventStream(scan.source, { signal: ctrl.signal, pollMs: 500, keepAliveMs: 5_000 }),
    );
    await vi.advanceTimersByTimeAsync(4_000);
    expect(out.text).not.toContain(': keep-alive');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(out.text).toContain(': keep-alive');
    expect(scanViews(out.text)).toHaveLength(1);
    ctrl.abort();
  });

  it('keeps going through failed polls, and only gives up after maxFailures in a row', async () => {
    const scan = fakeScan(view('queued'));
    const log = vi.fn();
    let failing = true;
    const source: ScanEventSource = {
      signature: () => (failing ? Promise.reject(new Error('db down')) : scan.source.signature()),
      load: scan.source.load,
    };
    const out = collect(
      scanEventStream(source, {
        signal: new AbortController().signal,
        pollMs: 500,
        maxFailures: 3,
        log,
      }),
    );
    // Two failures: one short of giving up.
    await vi.advanceTimersByTimeAsync(500);
    expect(out.ended).toBe(false);
    expect(log).toHaveBeenCalledTimes(2);

    // A success resets the count.
    failing = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(scanViews(out.text).map((v) => v.stage)).toEqual(['queued']);

    // Two more failures would make three in total, which must not end the
    // stream now that a poll succeeded in between.
    failing = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(out.ended).toBe(false);
    expect(log).toHaveBeenCalledTimes(3);

    // The third in a row does.
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);
    expect(out.ended).toBe(true);
  });

  it('ends after maxMs without done, so the browser reconnects', async () => {
    const scan = fakeScan(view('scanning'));
    const out = collect(
      scanEventStream(scan.source, {
        signal: new AbortController().signal,
        pollMs: 500,
        maxMs: 3_000,
      }),
    );
    await vi.advanceTimersByTimeAsync(3_500);
    expect(out.ended).toBe(true);
    expect(out.text).not.toContain('event: done');
  });

  it('ends at maxMs even when a read never settles', async () => {
    const out = collect(
      scanEventStream(
        {
          signature: () => new Promise<string | null>(() => {}),
          load: () => new Promise<ScanView | null>(() => {}),
        },
        { signal: new AbortController().signal, pollMs: 500, maxMs: 3_000 },
      ),
    );
    await vi.advanceTimersByTimeAsync(2_900);
    expect(out.ended).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(out.ended).toBe(true);
    expect(out.text).not.toContain('event: done');
  });

  it('does not send a late answer after the stream has ended', async () => {
    let answer: (value: string | null) => void = () => {};
    const source: ScanEventSource = {
      signature: () => new Promise<string | null>((resolve) => (answer = resolve)),
      load: vi.fn(() => Promise.resolve(view('scanning'))),
    };
    const out = collect(
      scanEventStream(source, { signal: new AbortController().signal, maxMs: 1_000 }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(out.ended).toBe(true);
    answer('v1');
    await vi.advanceTimersByTimeAsync(0);
    expect(source.load).not.toHaveBeenCalled();
    expect(scanViews(out.text)).toHaveLength(0);
  });

  it('sends nothing for a request that is already aborted', async () => {
    const scan = fakeScan(view('queued'));
    const ctrl = new AbortController();
    ctrl.abort();
    const out = collect(scanEventStream(scan.source, { signal: ctrl.signal }));
    await vi.advanceTimersByTimeAsync(0);
    expect(out.ended).toBe(true);
    expect(scan.source.signature).not.toHaveBeenCalled();
  });
});
