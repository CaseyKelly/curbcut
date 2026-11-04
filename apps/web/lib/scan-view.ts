import { Impact, IssueExplanation, WcagCriterion, groupIssues } from '@curbcut/core';
import { z } from 'zod';

/**
 * What the scan page shows (#8): built on the server from a scan's rows,
 * sent to the browser over SSE, and parsed there. These schemas are the
 * page's own, not a shared contract, so they live here and not in `core`.
 * No database imports, so the client can use this file.
 */

/** Elements sent per group. A rule can fail on thousands of elements, and every update resends them. */
export const MAX_ELEMENTS_PER_GROUP = 20;

export const ScanStage = z.enum(['queued', 'scanning', 'explaining', 'done', 'failed']);
export type ScanStage = z.infer<typeof ScanStage>;

export const ElementView = z.strictObject({
  pageUrl: z.string(),
  selector: z.string(),
  html: z.string(),
  failureSummary: z.string().nullable(),
});
export type ElementView = z.infer<typeof ElementView>;

export const GroupView = z.strictObject({
  groupKey: z.string(),
  ruleId: z.string(),
  impact: Impact,
  /** Every element in the group, though `elements` holds only the first few. */
  count: z.int().positive(),
  /** axe's one-line summary of the rule, shown when there's no explanation. */
  help: z.string(),
  helpUrl: z.string(),
  wcag: z.array(WcagCriterion),
  /** Null until the group is explained, or for good if it couldn't be (see `explainStatus`). */
  explanation: IssueExplanation.nullable(),
  elements: z.array(ElementView),
});
export type GroupView = z.infer<typeof GroupView>;

export const ScanView = z.strictObject({
  id: z.uuid(),
  targets: z.array(z.string()),
  stage: ScanStage,
  /** The scan's last error: why it failed, or why it's being retried. */
  error: z.string().nullable(),
  explainStatus: z.enum(['pending', 'running', 'completed', 'failed']).nullable(),
  /** Why explaining failed or is being retried, or which groups a finished run skipped. */
  explainError: z.string().nullable(),
  issueCount: z.int().nonnegative(),
  /** In `groupIssues` order: highest impact first. */
  groups: z.array(GroupView),
});
export type ScanView = z.infer<typeof ScanView>;

/**
 * The body of a `scan` event, or null if it isn't a scan this page can show.
 * Both handlers parse through here, so a bad payload from the server is
 * ignored the same way whichever event it arrives on.
 */
export function parseScanEvent(data: string): ScanView | null {
  try {
    const parsed = ScanView.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Why the server ended the stream: `final`, `gone` (the scan was deleted), or null if unreadable. */
export function parseDoneReason(data: string): 'final' | 'gone' | null {
  try {
    const reason = (JSON.parse(data) as { reason?: unknown } | null)?.reason;
    return reason === 'final' || reason === 'gone' ? reason : null;
  } catch {
    return null;
  }
}

/** Nothing more will change, so the page can stop listening. */
export function isFinal(view: Pick<ScanView, 'stage'>): boolean {
  return view.stage === 'done' || view.stage === 'failed';
}

export interface ScanRow {
  id: string;
  targets: string[];
  status: 'queued' | 'running' | 'completed' | 'failed';
  error: string | null;
  explainStatus: 'pending' | 'running' | 'completed' | 'failed' | null;
  explainError: string | null;
}

export interface IssueRow {
  ruleId: string;
  groupKey: string;
  impact: Impact;
  help: string;
  helpUrl: string;
  wcag: string[];
  pageUrl: string;
  selector: string;
  html: string;
  failureSummary: string | null;
  explanationId: string | null;
}

function stageOf(scan: ScanRow): ScanStage {
  switch (scan.status) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'scanning';
    case 'failed':
      return 'failed';
    case 'completed':
      // The scan is done before the explain job starts (#7), so the scan alone
      // can't say whether the page is finished.
      return scan.explainStatus === 'pending' || scan.explainStatus === 'running'
        ? 'explaining'
        : 'done';
  }
}

/**
 * Turns a scan's rows into the page's view (#8). `explanations` maps an
 * explanation id to its body; a group whose explanation is missing shows as
 * unexplained, the same as one the model couldn't answer.
 */
export function buildScanView(
  scan: ScanRow,
  issueRows: readonly IssueRow[],
  explanations: ReadonlyMap<string, IssueExplanation>,
): ScanView {
  const groups = groupIssues(issueRows).map((group): GroupView => {
    const first = group.issues[0]!;
    const explanationId = group.issues.find((i) => i.explanationId !== null)?.explanationId;
    return {
      groupKey: group.groupKey,
      ruleId: group.ruleId,
      impact: group.impact,
      count: group.count,
      help: first.help,
      helpUrl: first.helpUrl,
      wcag: first.wcag.filter((c) => WcagCriterion.safeParse(c).success),
      explanation: (explanationId && explanations.get(explanationId)) || null,
      elements: group.issues.slice(0, MAX_ELEMENTS_PER_GROUP).map((i) => ({
        pageUrl: i.pageUrl,
        selector: i.selector,
        html: i.html,
        failureSummary: i.failureSummary,
      })),
    };
  });

  return {
    id: scan.id,
    targets: scan.targets,
    stage: stageOf(scan),
    error: scan.error,
    explainStatus: scan.explainStatus,
    explainError: scan.explainError,
    issueCount: issueRows.length,
    groups,
  };
}
