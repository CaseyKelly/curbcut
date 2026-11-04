// The Postgres job queue (#5). Workers claim with `FOR UPDATE SKIP LOCKED`, so
// two workers never get the same job and neither waits on the other's lock.
// A claim counts as an attempt. A failed attempt, or a job whose worker
// stopped heartbeating, goes back in the queue with exponential backoff until
// it has used `max_attempts`. Whenever an attempt ends without succeeding,
// `onEnded` runs in the same transaction as the job's new status, so the row
// the job works on (a scan) can't be left disagreeing with it.
import { jobs, type Db } from '@curbcut/db';
import { and, eq, sql } from 'drizzle-orm';

export type Job = typeof jobs.$inferSelect;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Called with the job as it now stands (`queued` or `failed`) after an attempt ends badly. */
export type OnAttemptEnded = (tx: Tx, job: Job) => Promise<void>;

export interface QueueOptions {
  workerId: string;
  /** Backoff before attempt n+1 is `backoffMs * 2^(n-1)`: 30 s, then 60 s by default. */
  backoffMs?: number;
}

/** The job was requeued or claimed elsewhere after this worker lost its lock. */
export class LostJobError extends Error {
  override name = 'LostJobError';
}

const backoffSql = (backoffMs: number) =>
  sql`now() + make_interval(secs => ${backoffMs / 1000}::float8 * power(2, ${jobs.attempts} - 1))`;

/** Only the attempt this worker claimed may change the row. */
const owned = (job: Job, workerId: string) =>
  and(
    eq(jobs.id, job.id),
    eq(jobs.status, 'running'),
    eq(jobs.lockedBy, workerId),
    eq(jobs.attempts, job.attempts),
  );

export function createQueue(db: Db, { workerId, backoffMs = 30_000 }: QueueOptions) {
  async function lockOwned(tx: Tx, job: Job) {
    const rows = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(owned(job, workerId))
      .for('update');
    if (rows.length === 0) throw new LostJobError(`Lost the lock on job ${job.id}`);
  }

  return {
    /** Claims the oldest due job, or returns undefined if there is none. */
    async claim(): Promise<Job | undefined> {
      const [job] = await db
        .update(jobs)
        .set({
          status: 'running',
          attempts: sql`${jobs.attempts} + 1`,
          lockedAt: sql`now()`,
          lockedBy: workerId,
        })
        .where(
          eq(
            jobs.id,
            sql`(
              SELECT ${jobs.id} FROM ${jobs}
              WHERE ${jobs.status} = 'queued' AND ${jobs.runAt} <= now()
              ORDER BY ${jobs.runAt}, ${jobs.createdAt}
              LIMIT 1
              FOR UPDATE SKIP LOCKED
            )`,
          ),
        )
        .returning();
      return job;
    },

    /** Refreshes `locked_at` so a long job isn't taken for stale. False if the lock is gone. */
    async heartbeat(job: Job): Promise<boolean> {
      const rows = await db
        .update(jobs)
        .set({ lockedAt: sql`now()` })
        .where(owned(job, workerId))
        .returning({ id: jobs.id });
      return rows.length > 0;
    },

    /**
     * Runs `write` in a transaction after locking the job row and checking it's
     * still ours, for a job's own writes while it runs.
     */
    async update(job: Job, write: (tx: Tx) => Promise<void>): Promise<void> {
      await db.transaction(async (tx) => {
        await lockOwned(tx, job);
        await write(tx);
      });
    },

    /**
     * Marks the job succeeded. `commit` writes the job's results in the same
     * transaction, after the row is locked and checked to still be ours, so a
     * worker that lost its lock can't overwrite a retry's results.
     */
    async complete(job: Job, commit?: (tx: Tx) => Promise<void>): Promise<void> {
      await db.transaction(async (tx) => {
        await lockOwned(tx, job);
        await commit?.(tx);
        await tx
          .update(jobs)
          .set({ status: 'succeeded', lockedAt: null, error: null })
          .where(eq(jobs.id, job.id));
      });
    },

    /**
     * Records a failed attempt. The job is retried after a backoff unless
     * `permanent` or out of attempts. Returns the new status, or undefined if
     * the lock was lost.
     */
    async fail(
      job: Job,
      error: string,
      { permanent = false, onEnded }: { permanent?: boolean; onEnded?: OnAttemptEnded } = {},
    ) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(jobs)
          .set({
            status: sql`CASE WHEN ${permanent}::boolean OR ${jobs.attempts} >= ${jobs.maxAttempts}
              THEN 'failed' ELSE 'queued' END::job_status`,
            runAt: backoffSql(backoffMs),
            lockedAt: null,
            lockedBy: null,
            error,
          })
          .where(owned(job, workerId))
          .returning();
        if (row) await onEnded?.(tx, row);
        return row?.status;
      });
    },

    /**
     * Puts a job back without counting the attempt, for a worker shutting
     * down mid-job. False if the lock was already lost.
     */
    async release(job: Job, onEnded?: OnAttemptEnded): Promise<boolean> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(jobs)
          .set({
            status: 'queued',
            attempts: sql`${jobs.attempts} - 1`,
            runAt: sql`now()`,
            lockedAt: null,
            lockedBy: null,
          })
          .where(owned(job, workerId))
          .returning();
        if (row) await onEnded?.(tx, row);
        return row !== undefined;
      });
    },

    /**
     * Requeues jobs whose worker stopped heartbeating, or fails them if they're
     * out of attempts. Returns them as they now stand.
     */
    async requeueStale(lockTimeoutMs: number, onEnded?: OnAttemptEnded): Promise<Job[]> {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(jobs)
          .set({
            status: sql`CASE WHEN ${jobs.attempts} >= ${jobs.maxAttempts}
              THEN 'failed' ELSE 'queued' END::job_status`,
            runAt: backoffSql(backoffMs),
            lockedAt: null,
            lockedBy: null,
            error: 'Worker stopped responding (lock expired)',
          })
          .where(
            and(
              eq(jobs.status, 'running'),
              sql`${jobs.lockedAt} < now() - make_interval(secs => ${lockTimeoutMs / 1000}::float8)`,
            ),
          )
          .returning();
        for (const row of rows) await onEnded?.(tx, row);
        return rows;
      });
    },
  };
}

export type Queue = ReturnType<typeof createQueue>;
