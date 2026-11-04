'use client';

import { useEffect, useState } from 'react';
import {
  connectionMessage,
  explainedCount,
  failureDetail,
  missingExplanation,
  retryNote,
  skippedNote,
  stageMessage,
  type Connection,
} from '@/lib/scan-messages';
import { isFinal, parseDoneReason, parseScanEvent, type ScanView } from '@/lib/scan-view';
import { plural } from '@/lib/ui';
import { IssueGroup } from './issue-group';

/**
 * How long the stream may be down before the page says so. The server ends a
 * stream every few minutes on purpose and the browser reconnects after 3 s, so
 * a shorter wait would announce a problem that isn't one.
 */
const RECONNECT_NOTICE_MS = 6_000;

/**
 * The scan page's live part (#8): shows the scan, and while it's still going
 * listens for changes over SSE. One status region, always rendered, holds the
 * stage and the connection state, so a screen reader hears each change once and
 * isn't interrupted as explanations arrive. Error details are plain text.
 */
export function ScanLive({ initial }: { initial: ScanView }) {
  const [view, setView] = useState(initial);
  const [connection, setConnection] = useState<Connection>('live');
  const [gone, setGone] = useState(false);

  useEffect(() => {
    if (isFinal(initial)) return;
    const events = new EventSource(`/api/scans/${initial.id}/events`);
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    const live = () => {
      clearTimeout(noticeTimer);
      setConnection('live');
    };
    events.addEventListener('open', live);
    events.addEventListener('scan', (event: MessageEvent<string>) => {
      const next = parseScanEvent(event.data);
      if (next === null) {
        console.error('Ignoring an unreadable scan update');
        return;
      }
      setView(next);
      live();
    });
    events.addEventListener('done', (event: MessageEvent<string>) => {
      // The server closes after `done`, and EventSource would reconnect if we didn't.
      events.close();
      clearTimeout(noticeTimer);
      if (parseDoneReason(event.data) === 'gone') setGone(true);
    });
    events.addEventListener('error', () => {
      clearTimeout(noticeTimer);
      // CLOSED means the browser gave up (a 401 after the session ended, or a
      // 404 for a scan deleted in the meantime); reloading shows which.
      // Otherwise it's retrying by itself.
      if (events.readyState === EventSource.CLOSED) {
        setConnection('lost');
        return;
      }
      noticeTimer = setTimeout(() => setConnection('reconnecting'), RECONNECT_NOTICE_MS);
    });
    return () => {
      clearTimeout(noticeTimer);
      events.close();
    };
  }, [initial]);

  const explained = explainedCount(view);
  const total = view.groups.length;
  const waiting = view.stage === 'queued' || view.stage === 'scanning';
  const connectionNote = connectionMessage(connection);
  const retry = retryNote(view);
  const failure = failureDetail(view);
  const skipped = skippedNote(view);

  return (
    <div className="mt-6">
      <div role="status" className="text-lg font-medium">
        <p>{gone ? 'This scan no longer exists.' : stageMessage(view)}</p>
        {connectionNote && !gone ? (
          <p className="mt-1 text-base font-normal text-neutral-700">{connectionNote}</p>
        ) : null}
      </div>

      {gone ? (
        <p className="mt-3 font-medium text-red-800">
          Error: this scan was deleted. Start a new scan to see results.
        </p>
      ) : (
        <>
          {!isFinal(view) && connection === 'live' ? (
            <div className="mt-3">
              {waiting ? (
                <progress aria-label="Scan progress" className="block w-full max-w-md" />
              ) : (
                <>
                  <progress
                    aria-label="Explanations written"
                    max={total}
                    value={explained}
                    className="block w-full max-w-md"
                  />
                  <p className="mt-1 text-neutral-700">
                    {explained} of {plural(total, 'rule', 'rules')} explained
                  </p>
                </>
              )}
            </div>
          ) : null}

          {retry ? <p className="mt-3 text-neutral-700">{retry}</p> : null}
          {failure ? <p className="mt-3 font-medium text-red-800">{failure}</p> : null}
          {skipped ? <p className="mt-3 text-neutral-700">{skipped}</p> : null}

          {view.stage === 'done' && view.issueCount === 0 && view.explainStatus === null ? (
            <p className="mt-6">
              axe found no issues on this page. That doesn’t mean the page is fully accessible:
              automated checks catch only some problems.
            </p>
          ) : null}

          {view.groups.length > 0 ? (
            <section aria-labelledby="issues-heading" className="mt-8">
              <h2 id="issues-heading" className="text-xl font-semibold">
                Issues by rule
              </h2>
              <ol className="mt-4 space-y-4">
                {view.groups.map((group) => (
                  <li key={group.groupKey}>
                    <IssueGroup
                      group={group}
                      missingExplanation={missingExplanation(view)}
                      showPage={view.targets.length > 1}
                    />
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
