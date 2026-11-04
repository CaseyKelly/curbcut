import type { Job, Tx } from '../queue';

export interface JobContext {
  /** Aborts when the worker loses the job's lock or shuts down. Stop work promptly. */
  signal: AbortSignal;
  /** Writes while the job runs, only if it's still this worker's job. */
  write: (fn: (tx: Tx) => Promise<void>) => Promise<void>;
}

export interface JobHandler {
  /**
   * Does the slow work outside any transaction, then returns the writes that
   * record its result. The queue runs those in the transaction that marks the
   * job succeeded.
   */
  run(job: Job, ctx: JobContext): Promise<(tx: Tx) => Promise<void>>;
  /**
   * Called in the queue's transaction when an attempt ends without success,
   * with the job requeued (`queued`) or out of attempts (`failed`), so whatever
   * it works on can show the same state.
   */
  onAttemptEnded?(tx: Tx, job: Job): Promise<void>;
}
