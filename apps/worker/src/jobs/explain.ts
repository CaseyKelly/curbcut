// The `explain` job (#7): groups a scan's issues by rule, explains each group
// with one cheap LLM call (or the cache), and links the group's issues to its
// explanation. The scan job enqueues it, so a scan never holds a browser open
// while the model works, and a retry here never scans again.
import {
  BudgetExceededError,
  EXPLAIN_MODEL,
  EXPLAIN_PROMPT_VERSION,
  explainGroup,
  OutputTruncatedError,
  RefusalError,
  StructuredOutputError,
  type LLMProvider,
} from '@curbcut/agent';
import { ExplainJobPayload, groupIssues } from '@curbcut/core';
import { agentRuns, issues, scans, type Db } from '@curbcut/db';
import { and, eq, sql } from 'drizzle-orm';
import { PermanentError } from '../errors';
import type { Job } from '../queue';
import type { JobHandler } from './types';

export interface ExplainJobOptions {
  /** Groups explained at once. Each is one small Haiku call. */
  concurrency?: number;
  log?: (message: string) => void;
}

function scanIdOf(job: Job): string {
  const payload = ExplainJobPayload.safeParse(job.payload);
  if (!payload.success) {
    throw new PermanentError(`Invalid explain job payload: ${payload.error.message}`);
  }
  return payload.data.scanId;
}

/** Output the model got wrong for one group: skip the group, keep the rest. */
const isGroupFailure = (err: unknown) =>
  err instanceof StructuredOutputError ||
  err instanceof OutputTruncatedError ||
  err instanceof RefusalError;

/**
 * Runs `fn` over `items`, `limit` at a time. The first error stops new work
 * from starting, lets what's in flight finish (it's already paid for), then
 * is thrown.
 */
async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const lane = async () => {
    while (!failure && !signal.aborted && next < items.length) {
      const item = items[next++]!;
      try {
        await fn(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failure) throw failure.error;
  signal.throwIfAborted();
}

export function explainJob(
  db: Db,
  provider: LLMProvider,
  { concurrency = 4, log = console.log }: ExplainJobOptions = {},
): JobHandler {
  return {
    async run(job, { signal, write }) {
      const scanId = scanIdOf(job);
      const [scan] = await db.select().from(scans).where(eq(scans.id, scanId));
      if (!scan) throw new PermanentError(`Scan ${scanId} not found`);

      const groups = groupIssues(await db.select().from(issues).where(eq(issues.scanId, scanId)));

      let runId = '';
      await write(async (tx) => {
        const [run] = await tx
          .insert(agentRuns)
          .values({
            scanId,
            kind: 'pipeline',
            model: EXPLAIN_MODEL,
            promptVersion: EXPLAIN_PROMPT_VERSION,
          })
          .returning({ id: agentRuns.id });
        runId = run!.id;
      });

      let cachedGroups = 0;
      const skipped: string[] = [];
      await forEachLimited(groups, concurrency, signal, async (group) => {
        try {
          const result = await explainGroup({ db, provider }, group.issues, { runId, signal });
          if (result.cached) cachedGroups++;
          // Linked as each group finishes, so the UI fills in as results arrive
          // and a retry doesn't pay again for what already worked.
          await write(async (tx) => {
            await tx
              .update(issues)
              .set({ explanationId: result.explanationId })
              .where(and(eq(issues.scanId, scanId), eq(issues.groupKey, group.groupKey)));
          });
        } catch (err) {
          // Spending more can't work this month; retrying the job won't help.
          if (err instanceof BudgetExceededError) throw new PermanentError(err.message);
          if (!isGroupFailure(err)) throw err;
          skipped.push(group.groupKey);
          log(`explain: skipped ${group.groupKey} for scan ${scanId}: ${String(err)}`);
        }
      });
      log(
        `explain: scan ${scanId}: ${groups.length} groups, ${cachedGroups} from cache, ${skipped.length} skipped`,
      );

      return async (tx) => {
        await tx
          .update(agentRuns)
          .set({ status: 'ended', endReason: 'completed', endedAt: sql`now()` })
          .where(eq(agentRuns.id, runId));
      };
    },

    async onAttemptEnded(tx, job) {
      const payload = ExplainJobPayload.safeParse(job.payload);
      if (!payload.success) return;
      // Whether it's requeued or out of attempts, this attempt's run is over.
      // Its spend stays on the row, so the budget still counts it.
      await tx
        .update(agentRuns)
        .set({ status: 'ended', endReason: 'error', endedAt: sql`now()` })
        .where(
          and(
            eq(agentRuns.scanId, payload.data.scanId),
            eq(agentRuns.kind, 'pipeline'),
            eq(agentRuns.status, 'running'),
          ),
        );
    },
  };
}
