// The `scan` job (#5): scans each of a scan's targets and stores the issues.
import { ScanJobPayload, type A11yIssue } from '@curbcut/core';
import { issues, scans, type Db } from '@curbcut/db';
import { eq, sql } from 'drizzle-orm';
import { PermanentError } from '../errors';
import type { Job } from '../queue';
import type { Scanner } from '../scanner/scanner';
import type { JobHandler } from './types';

const INSERT_BATCH = 1_000;

function scanIdOf(job: Job): string {
  const payload = ScanJobPayload.safeParse(job.payload);
  if (!payload.success) {
    throw new PermanentError(`Invalid scan job payload: ${payload.error.message}`);
  }
  return payload.data.scanId;
}

export function scanJob(db: Db, scanner: Pick<Scanner, 'scan'>): JobHandler {
  return {
    async run(job, { signal, write }) {
      const scanId = scanIdOf(job);
      const [scan] = await db.select().from(scans).where(eq(scans.id, scanId));
      if (!scan) throw new PermanentError(`Scan ${scanId} not found`);

      await write(async (tx) => {
        await tx
          .update(scans)
          .set({
            status: 'running',
            error: null,
            startedAt: sql`coalesce(${scans.startedAt}, now())`,
          })
          .where(eq(scans.id, scanId));
      });

      const found: A11yIssue[] = [];
      let axeVersion: string | undefined;
      // A repeated target would store the same (page, fingerprint) twice.
      for (const target of new Set(scan.targets)) {
        const result = await scanner.scan(target, signal);
        found.push(...result.issues);
        axeVersion = result.axeVersion;
      }

      return async (tx) => {
        // A retry replaces whatever an earlier attempt stored.
        await tx.delete(issues).where(eq(issues.scanId, scanId));
        // Batched: one statement can bind at most 65,535 parameters, about 5,000 issues.
        for (let i = 0; i < found.length; i += INSERT_BATCH) {
          await tx.insert(issues).values(
            found.slice(i, i + INSERT_BATCH).map((issue) => ({
              ...issue,
              scanId,
              // Issues are grouped by rule for explanations (#7).
              groupKey: issue.ruleId,
            })),
          );
        }
        await tx
          .update(scans)
          .set({ status: 'completed', axeVersion, finishedAt: sql`now()` })
          .where(eq(scans.id, scanId));
      };
    },

    async onAttemptEnded(tx, job) {
      const payload = ScanJobPayload.safeParse(job.payload);
      if (!payload.success) return;
      // Requeued: back to `queued`, with the last error so the UI can say why it's retrying.
      const failed = job.status === 'failed';
      await tx
        .update(scans)
        .set({
          status: failed ? 'failed' : 'queued',
          error: job.error,
          finishedAt: failed ? sql`now()` : null,
        })
        .where(eq(scans.id, payload.data.scanId));
    },
  };
}
