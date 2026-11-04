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
import type { Job, Tx } from '../queue';
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
 * Runs `fn` over every item, `limit` at a time, and returns the errors rather
 * than stopping at the first: one group's failure shouldn't leave the rest
 * unexplained, least of all groups the cache can serve for free. Only an
 * abort stops it early.
 */
async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal,
  fn: (item: T) => Promise<void>,
): Promise<unknown[]> {
  let next = 0;
  const errors: unknown[] = [];
  const lane = async () => {
    while (!signal.aborted && next < items.length) {
      const item = items[next++]!;
      try {
        await fn(item);
      } catch (error) {
        errors.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return errors;
}

/** Longest note stored on a scan. */
const MAX_NOTE_LENGTH = 500;

/**
 * Called in the queue's transaction when an attempt ends without success (#7).
 */
async function markAttemptEnded(tx: Tx, job: Job) {
  const payload = ExplainJobPayload.safeParse(job.payload);
  if (!payload.success) return;
  // Requeued: back to `pending` with the last error, so the UI can say why
  // it's retrying. Out of attempts: `failed`, so it stops waiting.
  await tx
    .update(scans)
    .set({
      explainStatus: job.status === 'failed' ? 'failed' : 'pending',
      explainError: job.error,
    })
    .where(eq(scans.id, payload.data.scanId));
  // Either way this attempt's run is over. Its spend stays on the row, so
  // the budget still counts it.
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
        await tx
          .update(scans)
          .set({ explainStatus: 'running', explainError: null })
          .where(eq(scans.id, scanId));
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
      const errors = await forEachLimited(groups, concurrency, signal, async (group) => {
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
          // Collected by the pool and decided on once every group has run.
          if (!isGroupFailure(err)) throw err;
          skipped.push(group.groupKey);
          log(`explain: skipped ${group.groupKey} for scan ${scanId}: ${String(err)}`);
        }
      });
      signal.throwIfAborted();
      // Every group has had its turn by now. A spent budget can't be fixed by
      // retrying this month; anything else (a dropped connection) can.
      const budget = errors.find((e) => e instanceof BudgetExceededError);
      if (budget) throw new PermanentError(budget.message);
      if (errors.length > 0) throw errors[0];

      log(
        `explain: scan ${scanId}: ${groups.length} groups, ${cachedGroups} from cache, ${skipped.length} skipped`,
      );

      // Skipped groups aren't retried: the model would likely fail the same way,
      // and each try costs money. If nothing at all was explained, say so.
      const nothingExplained = groups.length > 0 && skipped.length === groups.length;
      const note =
        skipped.length > 0
          ? `${skipped.length} of ${groups.length} groups couldn't be explained: ${skipped.sort().join(', ')}`.slice(
              0,
              MAX_NOTE_LENGTH,
            )
          : null;
      return async (tx) => {
        await tx
          .update(agentRuns)
          .set({
            status: 'ended',
            endReason: nothingExplained ? 'error' : 'completed',
            endedAt: sql`now()`,
          })
          .where(eq(agentRuns.id, runId));
        await tx
          .update(scans)
          .set({ explainStatus: nothingExplained ? 'failed' : 'completed', explainError: note })
          .where(eq(scans.id, scanId));
      };
    },

    onAttemptEnded: markAttemptEnded,
  };
}

/**
 * Stands in for `explainJob` when the LLM isn't configured, so a local worker
 * still scans. Each explain job fails at once, and the scan says why.
 */
export function explainUnavailableJob(reason: string): JobHandler {
  return {
    run() {
      return Promise.reject(new PermanentError(reason));
    },
    onAttemptEnded: markAttemptEnded,
  };
}
