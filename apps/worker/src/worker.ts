// The worker loop (#5): claim a job, run its handler while heartbeating, then
// record success or a failed attempt. One job at a time: a scan holds a
// Chromium page, and the Fly machine is sized for one.
import { setTimeout as sleep } from 'node:timers/promises';
import { PermanentError } from './errors';
import type { JobHandler } from './jobs/types';
import { LostJobError, type Job, type OnAttemptEnded, type Queue } from './queue';

export interface WorkerOptions {
  queue: Queue;
  handlers: Partial<Record<Job['type'], JobHandler>>;
  /** How long to wait before polling again when the queue is empty. */
  pollIntervalMs?: number;
  /** A running job whose lock is older than this is taken for abandoned. */
  lockTimeoutMs?: number;
  log?: (message: string) => void;
}

/** Longest error stored on a job or scan; the full error goes to the log. */
const MAX_ERROR_LENGTH = 500;

/**
 * The message to store for a failed attempt. Drizzle wraps database errors in
 * a "Failed query" message that includes every parameter, so use the cause.
 */
export function describeError(err: unknown): string {
  const root = err instanceof Error && err.cause instanceof Error ? err.cause : err;
  const message = (root instanceof Error ? root.message : String(root)) || 'Unknown error';
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 1)}…` : message;
}

export function createWorker({
  queue,
  handlers,
  pollIntervalMs = 1_000,
  lockTimeoutMs = 120_000,
  log = console.log,
}: WorkerOptions) {
  /** When the loop last reached the database, for the health check. */
  let lastBeat = Date.now();

  const onEnded: OnAttemptEnded = async (tx, job) => {
    if (job.status === 'failed') log(`job ${job.id} (${job.type}) failed: ${job.error}`);
    await handlers[job.type]?.onAttemptEnded?.(tx, job);
  };

  async function process(job: Job, shutdown: AbortSignal) {
    log(`job ${job.id} (${job.type}) attempt ${job.attempts}/${job.maxAttempts}`);
    const lost = new AbortController();
    const heartbeat = setInterval(() => {
      queue.heartbeat(job).then(
        (held) => {
          if (held) lastBeat = Date.now();
          else lost.abort(new LostJobError(`Lost the lock on job ${job.id}`));
        },
        (err: unknown) => log(`heartbeat failed: ${String(err)}`),
      );
    }, lockTimeoutMs / 4);
    try {
      const handler = handlers[job.type];
      if (!handler) throw new PermanentError(`No handler for ${job.type} jobs yet`);
      const commit = await handler.run(job, {
        signal: AbortSignal.any([lost.signal, shutdown]),
        write: (fn) => queue.update(job, fn),
      });
      await queue.complete(job, commit);
      log(`job ${job.id} succeeded`);
    } catch (err) {
      if (lost.signal.aborted || err instanceof LostJobError) {
        // Another attempt owns the job now; nothing here is ours to record.
        log(`job ${job.id}: lost the lock, dropping this attempt`);
        return;
      }
      if (shutdown.aborted) {
        // Stopping for a deploy isn't the job's fault, so it doesn't spend an attempt.
        if (await queue.release(job, onEnded)) log(`job ${job.id} released for another worker`);
        return;
      }
      const message = describeError(err);
      log(`job ${job.id} attempt ${job.attempts} failed: ${String(err)}`);
      await queue.fail(job, message, { permanent: err instanceof PermanentError, onEnded });
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** Runs one job if one is due. Returns whether it found one. */
  async function tick(shutdown: AbortSignal = new AbortController().signal): Promise<boolean> {
    await queue.requeueStale(lockTimeoutMs, onEnded);
    lastBeat = Date.now();
    // A stop signal that arrived while requeueing shouldn't start a new job.
    if (shutdown.aborted) return false;
    const job = await queue.claim();
    if (job) await process(job, shutdown);
    return job !== undefined;
  }

  return {
    tick,

    /** Polls until `signal` aborts, which also aborts the job in hand and releases it. */
    async run(signal: AbortSignal) {
      while (!signal.aborted) {
        let found = false;
        try {
          found = await tick(signal);
        } catch (err) {
          // A database blip shouldn't kill the worker; the health check reports a long outage.
          log(`poll failed: ${String(err)}`);
        }
        if (!found) await sleep(pollIntervalMs, undefined, { signal }).catch(() => undefined);
      }
    },

    /** Healthy if the loop reached the database recently, by polling or heartbeating. */
    healthy: () => Date.now() - lastBeat < lockTimeoutMs,
  };
}

export type Worker = ReturnType<typeof createWorker>;
