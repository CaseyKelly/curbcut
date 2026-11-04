// Integration tests for the queue and the scan job against a migrated
// database. Skipped without DATABASE_URL, like the db package's tests.
//
// Other test files share the database and may briefly queue jobs of their
// own, so test jobs are due long ago (claims take the oldest first) and the
// tests never assert that the queue is empty.
import type { A11yIssue } from '@curbcut/core';
import { createDb, issues, jobs, scans, type Db } from '@curbcut/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnsafeUrlError } from './errors';
import { scanJob } from './jobs/scan';
import { createQueue, LostJobError, type Job, type Queue } from './queue';
import { createWorker, describeError } from './worker';

describe('describeError', () => {
  it('stores the database error, not the wrapping query with every parameter', () => {
    const cause = new Error('duplicate key value violates unique constraint "issues_pk"');
    const wrapped = new Error(`Failed query: insert into "issues" ${'x'.repeat(40_000)}`, {
      cause,
    });
    expect(describeError(wrapped)).toBe(cause.message);
  });

  it('caps the length', () => {
    const message = describeError(new Error('y'.repeat(10_000)));
    expect(message).toHaveLength(500);
    expect(message.endsWith('…')).toBe(true);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('worker', () => {
  let db: Db;
  let queue: Queue;
  let other: Queue;
  const jobIds: string[] = [];
  const scanIds: string[] = [];

  beforeAll(() => {
    db = createDb();
    queue = createQueue(db, { workerId: 'test-a', backoffMs: 60_000 });
    other = createQueue(db, { workerId: 'test-b', backoffMs: 60_000 });
  });

  afterAll(async () => {
    if (!db) return;
    if (jobIds.length) await db.delete(jobs).where(inArray(jobs.id, jobIds));
    if (scanIds.length) await db.delete(scans).where(inArray(scans.id, scanIds));
    await db.$client.end();
  });

  async function newJob(values: Partial<typeof jobs.$inferInsert> = {}) {
    const [job] = await db
      .insert(jobs)
      .values({ type: 'scan', payload: {}, runAt: new Date('2000-01-01'), ...values })
      .returning();
    jobIds.push(job!.id);
    return job!;
  }

  /** Test jobs are the oldest due, so the next claim gets this one. */
  async function claim(q: Queue, id: string): Promise<Job> {
    const job = await q.claim();
    expect(job?.id).toBe(id);
    return job!;
  }

  async function reload(id: string) {
    const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
    return job!;
  }

  /** Makes a requeued job due again without waiting out its backoff. */
  const makeDue = (id: string) =>
    db
      .update(jobs)
      .set({ runAt: new Date('2000-01-01') })
      .where(eq(jobs.id, id));

  describe('queue', () => {
    it('never gives the same job to two workers', async () => {
      const a = await newJob();
      const b = await newJob();
      const [x, y] = await Promise.all([queue.claim(), other.claim()]);
      expect(new Set([x?.id, y?.id])).toEqual(new Set([a.id, b.id]));
      expect(x).toMatchObject({ status: 'running', attempts: 1, lockedBy: 'test-a' });
      expect(y).toMatchObject({ status: 'running', attempts: 1, lockedBy: 'test-b' });
      expect(x!.lockedAt).toBeInstanceOf(Date);
      await queue.complete(x!);
      await other.complete(y!);
    });

    it('retries a failed attempt with backoff, up to max_attempts', async () => {
      const { id } = await newJob();

      let job = await claim(queue, id);
      expect(await queue.fail(job, 'boom')).toBe('queued');
      const first = await reload(id);
      expect(first).toMatchObject({ status: 'queued', attempts: 1, error: 'boom', lockedBy: null });
      // 60 s backoff for the second attempt, 120 s for the third.
      const delay = (j: Job) => (j.runAt.getTime() - Date.now()) / 1000;
      expect(delay(first)).toBeGreaterThan(50);
      expect(delay(first)).toBeLessThan(70);

      await makeDue(id);
      job = await claim(queue, id);
      expect(await queue.fail(job, 'boom')).toBe('queued');
      const second = await reload(id);
      expect(delay(second)).toBeGreaterThan(110);

      await makeDue(id);
      job = await claim(queue, id);
      expect(job.attempts).toBe(3);
      expect(await queue.fail(job, 'boom')).toBe('failed');
      expect(await reload(id)).toMatchObject({ status: 'failed', attempts: 3 });
    });

    it('fails a permanent error on the first attempt', async () => {
      const { id } = await newJob();
      const job = await claim(queue, id);
      expect(await queue.fail(job, 'bad payload', { permanent: true })).toBe('failed');
      expect(await reload(id)).toMatchObject({ status: 'failed', attempts: 1 });
    });

    it('requeues a job whose lock went stale, and fails it once out of attempts', async () => {
      const { id } = await newJob();
      const job = await claim(queue, id);
      const stale = sql`now() - interval '10 minutes'`;
      await db.update(jobs).set({ lockedAt: stale }).where(eq(jobs.id, id));

      expect(await queue.heartbeat(job)).toBe(true);
      expect(await queue.requeueStale(60_000)).toEqual([]);
      expect((await reload(id)).status).toBe('running');

      await db.update(jobs).set({ lockedAt: stale }).where(eq(jobs.id, id));
      await queue.requeueStale(60_000);
      expect(await reload(id)).toMatchObject({ status: 'queued', attempts: 1, lockedAt: null });

      // The original worker lost its lock and can no longer touch the job.
      expect(await queue.heartbeat(job)).toBe(false);
      await expect(queue.complete(job)).rejects.toThrow(LostJobError);
      expect(await queue.fail(job, 'late')).toBeUndefined();

      await db
        .update(jobs)
        .set({ status: 'running', attempts: 3, lockedAt: stale })
        .where(eq(jobs.id, id));
      const failed = await queue.requeueStale(60_000);
      expect(failed.map((j) => j.id)).toContain(id);
      expect(await reload(id)).toMatchObject({ status: 'failed' });
    });

    it('rolls back the result writes and the success if committing fails', async () => {
      const { id } = await newJob();
      const job = await claim(queue, id);
      await expect(
        queue.complete(job, async (tx) => {
          await tx.update(jobs).set({ error: 'written' }).where(eq(jobs.id, id));
          throw new Error('commit failed');
        }),
      ).rejects.toThrow('commit failed');
      expect(await reload(id)).toMatchObject({ status: 'running', error: null });
    });
  });

  describe('scan job', () => {
    const issue = (ruleId: string, fingerprint: string): A11yIssue => ({
      ruleId,
      impact: 'critical',
      help: 'Help',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.11/x',
      wcag: ['1.1.1'],
      pageUrl: 'https://example.com/',
      selector: 'img',
      html: '<img>',
      fingerprint,
    });

    async function newScanJob(targets = ['https://example.com/']) {
      const [scan] = await db
        .insert(scans)
        .values({
          targets,
          createdByGithubId: 1,
          createdByLogin: 'test',
        })
        .returning();
      scanIds.push(scan!.id);
      const job = await newJob({ payload: { scanId: scan!.id } });
      return { scanId: scan!.id, jobId: job.id };
    }

    /** One tick runs the test's job, the oldest due. */
    async function runOnce(
      worker: ReturnType<typeof createWorker>,
      jobId: string,
      shutdown?: AbortSignal,
    ) {
      expect(await worker.tick(shutdown)).toBe(true);
      return reload(jobId);
    }

    const scanOf = async (scanId: string) =>
      (await db.select().from(scans).where(eq(scans.id, scanId)))[0]!;

    type FakeScan = (
      url: string,
      signal?: AbortSignal,
    ) => Promise<{ issues: A11yIssue[]; axeVersion: string }>;

    // A day by default, so these tests never requeue another test's running jobs.
    const workerWith = (scan: FakeScan, lockTimeoutMs = 86_400_000) =>
      createWorker({
        queue,
        handlers: { scan: scanJob(db, { scan }) },
        lockTimeoutMs,
        log: () => undefined,
      });

    /** A scan that only ends when its signal aborts. */
    const untilAborted: FakeScan = (_url, signal) =>
      new Promise((_, reject) => {
        signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });

    it('stores the issues and completes the scan', async () => {
      const { scanId, jobId } = await newScanJob();
      const worker = workerWith(() =>
        Promise.resolve({
          issues: [issue('image-alt', 'fp-1'), issue('button-name', 'fp-2')],
          axeVersion: '4.11.0',
        }),
      );
      expect(await runOnce(worker, jobId)).toMatchObject({ status: 'succeeded' });

      const [scan] = await db.select().from(scans).where(eq(scans.id, scanId));
      expect(scan).toMatchObject({ status: 'completed', axeVersion: '4.11.0', error: null });
      expect(scan!.startedAt).toBeInstanceOf(Date);
      expect(scan!.finishedAt).toBeInstanceOf(Date);
      const stored = await db.select().from(issues).where(eq(issues.scanId, scanId));
      expect(stored.map((i) => [i.ruleId, i.groupKey]).sort()).toEqual([
        ['button-name', 'button-name'],
        ['image-alt', 'image-alt'],
      ]);
    });

    it('fails the scan at once when the URL is unsafe', async () => {
      const { scanId, jobId } = await newScanJob();
      const worker = workerWith(() => Promise.reject(new UnsafeUrlError('private address')));
      expect(await runOnce(worker, jobId)).toMatchObject({
        status: 'failed',
        attempts: 1,
      });
      const [scan] = await db.select().from(scans).where(eq(scans.id, scanId));
      expect(scan).toMatchObject({ status: 'failed', error: 'private address' });
    });

    it('retries a transient failure, putting the scan back in the queue with the error', async () => {
      const { scanId, jobId } = await newScanJob();
      const worker = workerWith(() => Promise.reject(new Error('net::ERR_CONNECTION_RESET')));
      expect(await runOnce(worker, jobId)).toMatchObject({
        status: 'queued',
        attempts: 1,
      });
      expect(await scanOf(scanId)).toMatchObject({
        status: 'queued',
        error: 'net::ERR_CONNECTION_RESET',
        finishedAt: null,
      });
    });

    it('stores more issues than fit in one insert', async () => {
      const { scanId, jobId } = await newScanJob();
      const many = Array.from({ length: 2_500 }, (_, i) => issue('color-contrast', `fp-${i}`));
      const worker = workerWith(() => Promise.resolve({ issues: many, axeVersion: '4.11.0' }));
      expect(await runOnce(worker, jobId)).toMatchObject({ status: 'succeeded' });
      expect(await db.select().from(issues).where(eq(issues.scanId, scanId))).toHaveLength(2_500);
    });

    it('scans a repeated target once', async () => {
      const { scanId, jobId } = await newScanJob(['https://example.com/', 'https://example.com/']);
      const scanned: string[] = [];
      const worker = workerWith((url) => {
        scanned.push(url);
        return Promise.resolve({ issues: [issue('image-alt', 'fp-1')], axeVersion: '4.11.0' });
      });
      expect(await runOnce(worker, jobId)).toMatchObject({ status: 'succeeded' });
      expect(scanned).toEqual(['https://example.com/']);
      expect(await db.select().from(issues).where(eq(issues.scanId, scanId))).toHaveLength(1);
    });

    it('on shutdown, aborts the scan and releases the job without spending an attempt', async () => {
      const { scanId, jobId } = await newScanJob();
      const shutdown = new AbortController();
      const worker = workerWith((url, signal) => {
        setTimeout(() => shutdown.abort(), 50);
        return untilAborted(url, signal);
      });
      expect(await runOnce(worker, jobId, shutdown.signal)).toMatchObject({
        status: 'queued',
        attempts: 0,
        lockedBy: null,
      });
      expect((await scanOf(scanId)).status).toBe('queued');
    });

    it('does not claim a job once shutdown has started', async () => {
      const { jobId } = await newScanJob();
      const stopped = new AbortController();
      stopped.abort();
      const worker = workerWith(() => Promise.reject(new Error('should not scan')));
      expect(await worker.tick(stopped.signal)).toBe(false);
      expect(await reload(jobId)).toMatchObject({ status: 'queued', attempts: 0 });
      // Still queued and oldest, so it would be the next test's claim.
      await db.delete(jobs).where(eq(jobs.id, jobId));
    });

    it('aborts the scan when another worker has taken the job, and leaves it to them', async () => {
      const { jobId } = await newScanJob();
      const worker = workerWith(async (url, signal) => {
        await db.update(jobs).set({ lockedBy: 'someone-else' }).where(eq(jobs.id, jobId));
        return untilAborted(url, signal);
      }, 400);
      expect(await runOnce(worker, jobId)).toMatchObject({
        status: 'running',
        attempts: 1,
        lockedBy: 'someone-else',
      });
    });

    it('fails the scan with the job when a stale job runs out of attempts', async () => {
      const { scanId, jobId } = await newScanJob();
      const handler = scanJob(db, { scan: () => Promise.reject(new Error('unused')) });
      await db
        .update(jobs)
        .set({ status: 'running', attempts: 3, lockedAt: sql`now() - interval '10 minutes'` })
        .where(eq(jobs.id, jobId));
      await queue.requeueStale(60_000, (tx, job) => handler.onAttemptEnded!(tx, job));
      expect((await reload(jobId)).status).toBe('failed');
      expect(await scanOf(scanId)).toMatchObject({
        status: 'failed',
        error: 'Worker stopped responding (lock expired)',
      });
    });

    it('fails a job with a bad payload without retrying', async () => {
      const { id } = await newJob({ payload: { scanId: 'not-a-uuid' } });
      const worker = workerWith(() => Promise.reject(new Error('should not scan')));
      const job = await runOnce(worker, id);
      expect(job).toMatchObject({ status: 'failed', attempts: 1 });
      expect(job.error).toMatch(/^Invalid scan job payload/);
    });
  });
});
