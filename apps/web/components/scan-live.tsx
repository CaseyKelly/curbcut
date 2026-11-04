'use client';

import { useEffect, useState } from 'react';
import { isFinal, ScanView } from '@/lib/scan-view';
import { IssueGroup } from './issue-group';

type Connection = 'live' | 'reconnecting' | 'lost';

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** The one line a screen reader hears when the scan moves to its next stage. */
function stageMessage(view: ScanView): string {
  const rules = plural(view.groups.length, 'rule', 'rules');
  switch (view.stage) {
    case 'queued':
      return 'Waiting for the scan to start.';
    case 'scanning':
      return 'Scanning the page.';
    case 'explaining':
      return `Scan finished: ${plural(view.issueCount, 'issue', 'issues')} across ${rules}. Writing explanations.`;
    case 'failed':
      return 'The scan failed.';
    case 'done':
      return view.issueCount === 0
        ? 'Scan finished: no accessibility issues found.'
        : `Scan finished: ${plural(view.issueCount, 'issue', 'issues')} across ${rules}.`;
  }
}

/**
 * The scan page's live part (#8): shows the scan, and while it's still going
 * listens for changes over SSE. The stage is the only live region, so a screen
 * reader hears each stage once and isn't interrupted as explanations arrive.
 */
export function ScanLive({ initial }: { initial: ScanView }) {
  const [view, setView] = useState(initial);
  const [connection, setConnection] = useState<Connection>('live');
  const [gone, setGone] = useState(false);

  useEffect(() => {
    if (isFinal(initial)) return;
    const events = new EventSource(`/api/scans/${initial.id}/events`);
    events.addEventListener('open', () => setConnection('live'));
    events.addEventListener('scan', (event: MessageEvent<string>) => {
      try {
        setView(ScanView.parse(JSON.parse(event.data)));
        setConnection('live');
      } catch (err) {
        console.error('Ignoring an unreadable scan update', err);
      }
    });
    events.addEventListener('done', (event: MessageEvent<string>) => {
      // The server closes after `done`, and EventSource would reconnect if we didn't.
      events.close();
      const reason = (JSON.parse(event.data) as { reason?: unknown } | null)?.reason;
      if (reason === 'gone') setGone(true);
    });
    events.addEventListener('error', () => {
      // CLOSED means the browser gave up (a 401 after the session ended, say);
      // otherwise it's retrying by itself.
      setConnection(events.readyState === EventSource.CLOSED ? 'lost' : 'reconnecting');
    });
    return () => events.close();
  }, [initial]);

  const explained = view.groups.filter((g) => g.explanation !== null).length;
  const total = view.groups.length;
  const waiting = view.stage === 'queued' || view.stage === 'scanning';
  const stillGoing = !isFinal(view);

  return (
    <div className="mt-6">
      <div role="status" className="text-lg font-medium">
        {stageMessage(view)}
      </div>

      {stillGoing && connection === 'live' ? (
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

      {view.stage === 'queued' && view.error ? (
        <p className="mt-3 text-neutral-700">
          The last attempt didn’t work, so it’s trying again. Reason: {view.error}
        </p>
      ) : null}
      {view.stage === 'explaining' && view.explainStatus === 'pending' && view.explainError ? (
        <p className="mt-3 text-neutral-700">
          Writing explanations didn’t work, so it’s trying again. Reason: {view.explainError}
        </p>
      ) : null}

      {view.stage === 'failed' ? (
        <p role="alert" className="mt-3 font-medium text-red-800">
          Error: {view.error ?? 'The scan failed.'}
        </p>
      ) : null}
      {view.stage === 'done' && view.explainStatus === 'failed' ? (
        <p role="alert" className="mt-3 font-medium text-red-800">
          Error: explanations couldn’t be written
          {view.explainError ? ` (${view.explainError})` : ''}. The issues below show axe’s own
          descriptions.
        </p>
      ) : null}
      {view.stage === 'done' && view.explainStatus === 'completed' && view.explainError ? (
        <p className="mt-3 text-neutral-700">Note: {view.explainError}</p>
      ) : null}

      {connection === 'reconnecting' ? (
        <p role="status" className="mt-3 text-neutral-700">
          Lost the live connection. Trying to reconnect.
        </p>
      ) : null}
      {connection === 'lost' ? (
        <p role="alert" className="mt-3 font-medium text-red-800">
          Error: the live connection ended, so this page may be out of date. Reload the page to see
          the latest.
        </p>
      ) : null}
      {gone ? (
        <p role="alert" className="mt-3 font-medium text-red-800">
          Error: this scan no longer exists.
        </p>
      ) : null}

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
                <IssueGroup group={group} stage={view.stage} explainStatus={view.explainStatus} />
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
