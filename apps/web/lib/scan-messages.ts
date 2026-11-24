import { plural } from './ui';
import type { ScanView } from './scan-view';

/**
 * What the scan page tells people (#8), as pure functions of the view so the
 * wording for each stage and explain status can be table-tested. A reader of
 * the page only gets what these say; the axe run can't check them.
 */

export type Connection = 'live' | 'reconnecting' | 'lost';

type Messages = Pick<
  ScanView,
  'stage' | 'issueCount' | 'groups' | 'error' | 'explainStatus' | 'explainError'
>;

export function explainedCount(view: Pick<ScanView, 'groups'>): number {
  return view.groups.filter((g) => g.explanation !== null).length;
}

/** True once explaining has failed for good, with some groups explained and some not. */
function partlyExplained(view: Messages): boolean {
  const explained = explainedCount(view);
  return explained > 0 && explained < view.groups.length;
}

/** The stage in one sentence: the line a screen reader hears when the scan moves on. */
export function stageMessage(view: Messages): string {
  const issues = plural(view.issueCount, 'issue', 'issues');
  const rules = plural(view.groups.length, 'rule', 'rules');
  switch (view.stage) {
    case 'queued':
      return 'Waiting for the scan to start.';
    case 'scanning':
      return 'Scanning the page.';
    case 'explaining':
      return `Scan finished: ${issues} across ${rules}. Writing explanations.`;
    case 'failed':
      return 'The scan failed.';
    case 'done':
      if (view.issueCount === 0) return 'Scan finished: no accessibility issues found.';
      if (view.explainStatus === 'failed') {
        return `Scan finished: ${issues} across ${rules}. ${
          partlyExplained(view)
            ? 'Some explanations couldn’t be written.'
            : 'Explanations couldn’t be written.'
        }`;
      }
      return `Scan finished: ${issues} across ${rules}.`;
  }
}

/** A line about the live connection, or null while it's fine. */
export function connectionMessage(connection: Connection): string | null {
  switch (connection) {
    case 'live':
      return null;
    case 'reconnecting':
      return 'Lost the live connection. Trying to reconnect.';
    case 'lost':
      return 'The live connection ended, so this page may be out of date. Reload the page to see the latest.';
  }
}

/** Why something is being retried, while the scan or the explain job is between attempts. */
export function retryNote(view: Messages): string | null {
  if (view.stage === 'queued' && view.error) {
    return `The last attempt didn’t work, so it’s trying again. Reason: ${view.error}`;
  }
  if (view.stage === 'explaining' && view.explainStatus === 'pending' && view.explainError) {
    return `Writing explanations didn’t work, so it’s trying again. Reason: ${view.explainError}`;
  }
  return null;
}

/** An error to show in full: the scan failed, or explaining ran out of attempts. */
export function failureDetail(view: Messages): string | null {
  if (view.stage === 'failed') return `Error: ${view.error ?? 'The scan failed.'}`;
  if (view.stage === 'done' && view.explainStatus === 'failed') {
    const why = view.explainError ? ` (${view.explainError})` : '';
    const total = view.groups.length;
    const explained = explainedCount(view);
    return partlyExplained(view)
      ? `Error: ${plural(total - explained, 'rule', 'rules')} of ${total} couldn’t be explained${why}. Those show axe’s own descriptions.`
      : `Error: explanations couldn’t be written${why}. The issues below show axe’s own descriptions.`;
  }
  return null;
}

/** A finished explain job's note on the groups it skipped. */
export function skippedNote(view: Messages): string | null {
  return view.stage === 'done' && view.explainStatus === 'completed' && view.explainError
    ? `Note: ${view.explainError}`
    : null;
}

/** What a card says in place of an explanation it doesn't have. */
export function missingExplanation(view: Messages): string {
  if (view.stage === 'explaining') return 'Writing an explanation…';
  if (view.explainStatus === 'failed') {
    return explainedCount(view) > 0
      ? 'Explaining stopped before this rule was reached, so this is axe’s own description.'
      : 'Explanations aren’t available for this scan, so this is axe’s own description.';
  }
  return 'No explanation could be written for this rule, so this is axe’s own description.';
}
