import { IssueExplanation } from '@curbcut/core';
import { explanations, issues, scans, type Db } from '@curbcut/db';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { buildScanView, type ScanView } from './scan-view';

const scanColumns = {
  id: scans.id,
  targets: scans.targets,
  status: scans.status,
  error: scans.error,
  explainStatus: scans.explainStatus,
  explainError: scans.explainError,
};

/** False for anything that isn't a UUID, so a bad URL is a 404 and not a Postgres error. */
export function isScanId(id: string): boolean {
  return z.uuid().safeParse(id).success;
}

/** The scan as the page shows it, or null if there's no such scan. */
export async function loadScanView(db: Db, id: string): Promise<ScanView | null> {
  if (!isScanId(id)) return null;
  const [scan] = await db.select(scanColumns).from(scans).where(eq(scans.id, id));
  if (!scan) return null;

  const issueRows = await db
    .select({
      ruleId: issues.ruleId,
      groupKey: issues.groupKey,
      impact: issues.impact,
      help: issues.help,
      helpUrl: issues.helpUrl,
      wcag: issues.wcag,
      pageUrl: issues.pageUrl,
      selector: issues.selector,
      html: issues.html,
      failureSummary: issues.failureSummary,
      explanationId: issues.explanationId,
    })
    .from(issues)
    .where(eq(issues.scanId, id))
    // Decides which elements make a group's capped list, so the worst show first.
    // The rest is a stable tie-break (unique per scan): linking explanations
    // rewrites rows, and without it the list could reshuffle between updates.
    .orderBy(desc(issues.impact), issues.pageUrl, issues.fingerprint);

  const ids = [...new Set(issueRows.flatMap((i) => (i.explanationId ? [i.explanationId] : [])))];
  const bodies = new Map<string, IssueExplanation>();
  if (ids.length > 0) {
    const rows = await db
      .select({ id: explanations.id, body: explanations.body })
      .from(explanations)
      .where(inArray(explanations.id, ids));
    for (const row of rows) {
      // A row that no longer parses reads as unexplained: axe's help text still shows.
      const body = IssueExplanation.safeParse(row.body);
      if (body.success) bodies.set(row.id, body.data);
    }
  }
  return buildScanView(scan, issueRows, bodies);
}

/**
 * A cheap summary of everything that changes what the page shows, so the
 * event stream can poll often without rebuilding the whole view (which
 * includes every issue) each time. Null if there's no such scan.
 */
export async function loadScanSignature(db: Db, id: string): Promise<string | null> {
  if (!isScanId(id)) return null;
  const [row] = await db
    .select({
      status: scans.status,
      error: scans.error,
      explainStatus: scans.explainStatus,
      explainError: scans.explainError,
      // Issues are linked to their explanation as each group finishes.
      // Written out with an alias: column references inside a subquery lose their table name.
      explained: sql<number>`(
        select count(*)::int from issues i
        where i.scan_id = ${id} and i.explanation_id is not null
      )`,
    })
    .from(scans)
    .where(eq(scans.id, id));
  return row ? JSON.stringify(row) : null;
}
