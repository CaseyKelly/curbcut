import { isFinal, type ScanView } from './scan-view';

/**
 * The scan page's live progress (#8), as Server-Sent Events. Every client gets
 * the scan's current state first, then a new `scan` event whenever it changes.
 * They're snapshots, not deltas, so a reconnecting browser needs no
 * `Last-Event-ID`. `done` means nothing more will change: the client must
 * close, or EventSource would reconnect when the stream ends.
 *
 * The plan has the worker's progress arrive through Postgres and the route
 * handler poll it every 500 ms. For M1 the progress is the scan's own state;
 * `agent_steps` streaming comes with the agent loop (#22).
 */

export interface ScanEventSource {
  /** A cheap value that differs whenever `load` would return something different; null if the scan is gone. */
  signature: () => Promise<string | null>;
  load: () => Promise<ScanView | null>;
}

export interface ScanEventOptions {
  /** Aborted when the browser goes away. */
  signal: AbortSignal;
  pollMs?: number;
  /** A comment line this often keeps proxies from closing a quiet connection. */
  keepAliveMs?: number;
  /**
   * Ends the stream after this long without `done`, so a scan that never
   * finishes doesn't hold a connection forever. The browser reconnects and
   * gets the current state again. A timer enforces it, so a database read
   * that never settles can't keep the stream open past it.
   */
  maxMs?: number;
  /** Consecutive failed polls before the stream gives up and lets the browser reconnect. */
  maxFailures?: number;
  log?: (message: string, err: unknown) => void;
}

const encoder = new TextEncoder();

function frame(event: string, data: unknown): Uint8Array {
  // JSON has no raw newlines, so one `data:` line is enough.
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function scanEventStream(
  source: ScanEventSource,
  {
    signal,
    pollMs = 500,
    keepAliveMs = 15_000,
    // Under the 300 s Vercel allows a function by default, so the stream ends
    // cleanly here rather than as a function timeout.
    maxMs = 270_000,
    maxFailures = 20,
    log = (message, err) => console.error(message, err),
  }: ScanEventOptions,
): ReadableStream<Uint8Array> {
  let stop = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let lastSignature: string | null | undefined;
      let failures = 0;
      const startedAt = Date.now();
      let lastSentAt = startedAt;

      const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        clearTimeout(deadline);
        signal.removeEventListener('abort', close);
        try {
          controller.close();
        } catch {
          // Already closed by the consumer cancelling.
        }
      };
      stop = close;
      // Not tied to the poll loop: see `maxMs`.
      const deadline = setTimeout(close, maxMs);
      const send = (chunk: Uint8Array) => {
        controller.enqueue(chunk);
        lastSentAt = Date.now();
      };

      const tick = async () => {
        try {
          // The signature is read before the view, so a change in between
          // shows up as one more event rather than being missed.
          const signature = await source.signature();
          if (closed) return;
          if (signature === null) {
            send(frame('done', { reason: 'gone' }));
            return close();
          }
          if (signature !== lastSignature) {
            const view = await source.load();
            if (closed) return;
            if (view === null) {
              send(frame('done', { reason: 'gone' }));
              return close();
            }
            lastSignature = signature;
            send(frame('scan', view));
            if (isFinal(view)) {
              send(frame('done', { reason: 'final' }));
              return close();
            }
          } else if (Date.now() - lastSentAt >= keepAliveMs) {
            send(encoder.encode(': keep-alive\n\n'));
          }
          failures = 0;
        } catch (err) {
          if (closed) return;
          log('scan events: poll failed', err);
          if (++failures >= maxFailures) return close();
        }
        timer = setTimeout(() => void tick(), pollMs);
      };

      if (signal.aborted) return close();
      signal.addEventListener('abort', close);
      // Tells the browser how long to wait before reconnecting.
      send(encoder.encode('retry: 3000\n\n'));
      void tick();
    },
    cancel() {
      stop();
    },
  });
}

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  // Stops nginx-style proxies from buffering the stream.
  'X-Accel-Buffering': 'no',
} as const;
