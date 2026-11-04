import type { ScanJobPayload } from '@curbcut/core';
import { jobs, scans, type Db } from '@curbcut/db';

/**
 * Starts a scan (#8): the `scans` row and its `scan` job are written in one
 * transaction, so a scan is never queued without a job to run it, or the
 * reverse. `url` must already have passed `validateScanUrl`.
 */
export async function createScan(
  db: Db,
  url: string,
  by: { githubId: number; login: string },
): Promise<string> {
  return db.transaction(async (tx) => {
    const [scan] = await tx
      .insert(scans)
      .values({ targets: [url], createdByGithubId: by.githubId, createdByLogin: by.login })
      .returning({ id: scans.id });
    const payload: ScanJobPayload = { scanId: scan!.id };
    await tx.insert(jobs).values({ type: 'scan', payload });
    return scan!.id;
  });
}
