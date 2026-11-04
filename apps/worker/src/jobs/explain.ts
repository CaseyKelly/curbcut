// The `explain` job (#7): groups a scan's issues by rule, explains each group
// with one cheap LLM call (or the cache), and links the group's issues to its
// explanation. The scan job enqueues it, so a scan never holds a browser open
// while the model works, and a retry here never scans again.
import {
  BudgetExceededError,
  EXPLAIN_MODEL,
  EXPLAIN_PROMPT_VERSION,
  explainGroup,
  findCachedExplanation,
  OutputTruncatedError,
  RefusalError,
  ReplayMissError,
  StructuredOutputError,
  type LLMProvider,
} from '@curbcut/agent';
import { ExplainJobPayload, groupIssues } from '@curbcut/core';
import { agentRuns, issues, scans, type Db } from '@curbcut/db';
import { and, eq, sql } from 'drizzle-orm';
import { PermanentError } from '../errors';
import { LostJobError, type Job, type Tx } from '../queue';
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

/**
 * What an error from explaining one group says about the rest of the job:
 * - `output`: the model answered but its output was unusable (invalid after a
 *   repair, cut off, a refusal). The group's problem: skip it.
 * - `rejected`: the API refused this request as bad (400, 413, 422). Usually
 *   the group's input, so skip it, but a spend limit or an empty credit
 *   balance is also a 400, and then every call fails the same way (see
 *   `MAX_CONSECUTIVE_REJECTIONS`).
 * - `permanent`: a bad key or model (401, 402, 403, 404), a spent budget, or a
 *   missing recording. A retry can't fix it.
 * - `transient`: a dropped connection, a timeout, 429, 5xx. It may pass, so
 *   the queue retries the job.
 */
type Failure = 'output' | 'rejected' | 'permanent' | 'transient';

function classify(err: unknown): Failure {
  if (
    err instanceof StructuredOutputError ||
    err instanceof OutputTruncatedError ||
    err instanceof RefusalError
  ) {
    return 'output';
  }
  if (err instanceof BudgetExceededError || err instanceof ReplayMissError) return 'permanent';
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 400 || status === 413 || status === 422) return 'rejected';
  if (status === 401 || status === 402 || status === 403 || status === 404) return 'permanent';
  return 'transient';
}

/**
 * Rejections in a row, with no call answered in between, after which the job
 * fails instead of skipping group after group. The account hitting its spend
 * limit looks like this, whether it happens at the first call or partway
 * through, and skipping would report a failed job as a pile of bad groups.
 */
const MAX_CONSECUTIVE_REJECTIONS = 3;

/**
 * Transient errors in one attempt before new calls stop. One group that
 * always fails shouldn't strand the others, but a down API shouldn't get a
 * call per group either, and a hung call can take 10 minutes.
 */
const MAX_TRANSIENT_ERRORS = 3;

/**
 * Runs `fn` over `items`, `limit` at a time. Stops starting new items once
 * `stop()` is true; those in flight finish, since they're already paid for.
 */
async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  stop: () => boolean,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (!stop() && next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/** Longest reason in a scan's note, so the groups after it still fit. */
const MAX_REASON_LENGTH = 200;

const shorten = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Longest note stored on a scan. */
const MAX_NOTE_LENGTH = 500;

/**
 * Called in the queue's transaction when an attempt ends without success (#7).
 */
async function markAttemptEnded(tx: Tx, job: Job) {
  const payload = ExplainJobPayload.safeParse(job.payload);
  if (!payload.success) return;
  // agent_runs before scans, the same order as the ledger's `record`: this runs
  // while another worker may be charging a call to the run, and the opposite
  // order could deadlock the two.
  // This attempt's run is over either way. Its spend stays on the row, so the
  // budget still counts it.
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
  // Requeued: back to `pending` with the last error, so the UI can say why
  // it's retrying. Out of attempts: `failed`, so it stops waiting.
  await tx
    .update(scans)
    .set({
      explainStatus: job.status === 'failed' ? 'failed' : 'pending',
      explainError: job.error,
    })
    .where(eq(scans.id, payload.data.scanId));
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

      // Lock order is agent_runs, then scans, as in the ledger's `record`, so
      // this can't deadlock with a call being charged.
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
        await tx
          .update(scans)
          .set({ explainStatus: 'running', explainError: null })
          .where(eq(scans.id, scanId));
      });

      /** Linked as each group is explained, so the UI fills in as results arrive. */
      const link = (groupKey: string, explanationId: string) =>
        write(async (tx) => {
          await tx
            .update(issues)
            .set({ explanationId })
            .where(and(eq(issues.scanId, scanId), eq(issues.groupKey, groupKey)));
        });

      // Cached groups first: free, and they work with the budget spent or the
      // API down, so whatever happens next they're explained.
      const uncached: typeof groups = [];
      for (const group of groups) {
        signal.throwIfAborted();
        const explanationId = await findCachedExplanation({ db }, group.issues);
        if (explanationId) await link(group.groupKey, explanationId);
        else uncached.push(group);
      }
      const cachedGroups = groups.length - uncached.length;

      // Then the model. Errors that affect the whole job stop new calls; a few
      // transient ones do too (see `MAX_TRANSIENT_ERRORS`). Calls already in
      // flight finish, since they're already paid for.
      const skipped: { groupKey: string; reason: string }[] = [];
      const transient: Error[] = [];
      let consecutiveRejections = 0;
      /** Calls the API answered, with a usable output or not. */
      let answered = 0;
      let stopped: Error | undefined;
      await forEachLimited(
        uncached,
        concurrency,
        () => stopped !== undefined || signal.aborted,
        async (group) => {
          try {
            const result = await explainGroup({ db, provider }, group.issues, { runId, signal });
            answered++;
            consecutiveRejections = 0;
            await link(group.groupKey, result.explanationId);
          } catch (err) {
            // Without a lock the answer isn't ours to store, and more calls are waste.
            if (err instanceof LostJobError) {
              stopped ??= err;
              return;
            }
            const failure = classify(err);
            if (failure === 'output' || failure === 'rejected') {
              if (failure === 'output') {
                answered++;
                consecutiveRejections = 0;
              } else if (++consecutiveRejections >= MAX_CONSECUTIVE_REJECTIONS) {
                stopped ??= new PermanentError(
                  `The API rejected ${consecutiveRejections} requests in a row: ${describe(err)}`,
                );
              }
              skipped.push({ groupKey: group.groupKey, reason: describe(err) });
              log(`explain: skipped ${group.groupKey} for scan ${scanId}: ${String(err)}`);
            } else if (failure === 'permanent') {
              stopped ??= new PermanentError(describe(err));
            } else {
              transient.push(err instanceof Error ? err : new Error(describe(err)));
              if (transient.length >= MAX_TRANSIENT_ERRORS) stopped ??= transient[0];
            }
          }
        },
      );
      signal.throwIfAborted();
      if (stopped) throw stopped;
      // Every call was rejected and none came from the cache, so it wasn't the
      // groups. (With fewer than `MAX_CONSECUTIVE_REJECTIONS` groups the check
      // above never fires.) A rescan with some cached groups is a different
      // case: the one uncached group is just a bad one.
      if (
        cachedGroups === 0 &&
        answered === 0 &&
        skipped.length > 0 &&
        skipped.length === uncached.length
      ) {
        throw new PermanentError(`The API rejected every request: ${skipped[0]!.reason}`);
      }
      // Some groups hit transient errors: retry, and the cache makes the groups
      // that worked free.
      if (transient[0]) throw transient[0];

      log(
        `explain: scan ${scanId}: ${groups.length} groups, ${cachedGroups} from cache, ${skipped.length} skipped`,
      );

      // The job doesn't retry for skipped groups, since the model would likely
      // fail the same way. (If another group's error does retry it, they're
      // asked again until #55 remembers failures.) If nothing was explained, say so.
      const nothingExplained = groups.length > 0 && skipped.length === groups.length;
      // The reason first: the list of groups can fill the whole note.
      const note =
        skipped.length > 0
          ? `${skipped.length} of ${groups.length} groups couldn't be explained. First reason: ${shorten(
              skipped[0]!.reason,
              MAX_REASON_LENGTH,
            )}. Groups: ${skipped
              .map((g) => g.groupKey)
              .sort()
              .join(', ')}`.slice(0, MAX_NOTE_LENGTH)
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
