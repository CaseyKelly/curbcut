import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECONNECT_NOTICE_MS, trackConnection } from './scan-connection';
import type { Connection } from './scan-messages';

describe('trackConnection', () => {
  let states: Connection[];
  let tracker: ReturnType<typeof trackConnection>;

  beforeEach(() => {
    vi.useFakeTimers();
    states = [];
    tracker = trackConnection((connection) => states.push(connection));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says it is reconnecting during an outage with an error every 3 s', () => {
    for (let elapsed = 0; elapsed < RECONNECT_NOTICE_MS + 3_000; elapsed += 3_000) {
      tracker.error(false);
      vi.advanceTimersByTime(3_000);
    }
    expect(states).toEqual(['reconnecting']);
  });

  it('says nothing when the browser reconnects before the notice is due', () => {
    tracker.error(false);
    vi.advanceTimersByTime(3_000);
    tracker.live();
    vi.advanceTimersByTime(RECONNECT_NOTICE_MS);
    expect(states).toEqual(['live']);
  });

  it('starts a fresh wait for the next outage after reconnecting', () => {
    tracker.error(false);
    vi.advanceTimersByTime(RECONNECT_NOTICE_MS);
    tracker.live();
    tracker.error(false);
    vi.advanceTimersByTime(RECONNECT_NOTICE_MS - 1);
    expect(states).toEqual(['reconnecting', 'live']);
    vi.advanceTimersByTime(1);
    expect(states).toEqual(['reconnecting', 'live', 'reconnecting']);
  });

  it('says the connection is lost when the browser gives up, with no notice after', () => {
    tracker.error(false);
    tracker.error(true);
    vi.advanceTimersByTime(RECONNECT_NOTICE_MS);
    expect(states).toEqual(['lost']);
  });

  it('shows no notice after the page stops listening', () => {
    tracker.error(false);
    tracker.stop();
    vi.advanceTimersByTime(RECONNECT_NOTICE_MS);
    expect(states).toEqual([]);
  });
});
