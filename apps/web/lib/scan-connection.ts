import type { Connection } from './scan-messages';

/**
 * How long the stream may be down before the page says so. The server ends a
 * stream every few minutes on purpose and the browser reconnects after 3 s, so
 * a shorter wait would announce a problem that isn't one.
 */
export const RECONNECT_NOTICE_MS = 6_000;

export interface ConnectionTracker {
  /** The stream opened or delivered an update. */
  live(): void;
  /** EventSource fired `error`; `closed` is true when the browser gave up. */
  error(closed: boolean): void;
  /** The page stopped listening. */
  stop(): void;
}

/**
 * Turns EventSource's events into the page's connection state (#8). EventSource
 * fires `error` on every failed reconnect attempt, about 3 s apart, so the
 * notice timer starts on the first one and is left alone after that. Restarting
 * it on each error would keep it from ever firing during a sustained outage.
 */
export function trackConnection(set: (connection: Connection) => void): ConnectionTracker {
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    clearTimeout(noticeTimer);
    noticeTimer = undefined;
  };
  return {
    live() {
      clear();
      set('live');
    },
    error(closed) {
      if (closed) {
        clear();
        set('lost');
        return;
      }
      noticeTimer ??= setTimeout(() => set('reconnecting'), RECONNECT_NOTICE_MS);
    },
    stop: clear,
  };
}
