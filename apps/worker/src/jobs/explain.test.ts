// Integration tests for the explain job against a migrated database, with a
// real provider and ledger over a stubbed API. Skipped without DATABASE_URL.
//
// These call the handler directly instead of ticking the worker: other test
// files share the queue, and a tick here could claim their jobs and the other
// way round. Rule ids are unique per run, because the explanation cache is
// shared and keyed on the rule.
import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import {
  createDbLedger,
  createProvider,
  explainGroup,
  MODELS,
  type SendMessage,
} from '@curbcut/agent';
import type { Impact } from '@curbcut/core';
import { agentRuns, createDb, explanations, issues, scans, type Db } from '@curbcut/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PermanentError } from '../errors';
import { LostJobError, type Job } from '../queue';
import { explainJob, explainUnavailableJob } from './explain';

const explanationJson = JSON.stringify({
  whatsWrong: 'The image has no text alternative.',
  whoItAffects: 'Screen reader users.',
  whyItMatters: 'They cannot tell what the image shows.',
  confidence: 0.9,
});

function reply(text: string): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: MODELS.haiku,
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    container: null,
    usage: { input_tokens: 1_000, output_tokens: 200 },
  } as Anthropic.Message;
}

// 1,000 input and 200 output tokens of Haiku 5.5.
const CALL_COST = 0.0002;

describe.skipIf(!process.env.DATABASE_URL)('explain job', () => {
  let db: Db;
  const scanIds: string[] = [];
  const ruleIds: string[] = [];

  beforeAll(() => {
    db = createDb();
  });

  afterAll(async () => {
    if (!db) return;
    if (scanIds.length) await db.delete(scans).where(inArray(scans.id, scanIds));
    if (ruleIds.length) await db.delete(explanations).where(inArray(explanations.ruleId, ruleIds));
    await db.$client.end();
  });

  const newRule = (name = 'rule') => {
    const ruleId = `${name}-${randomUUID()}`;
    ruleIds.push(ruleId);
    return ruleId;
  };

  /** A completed scan with `count` issues per rule; `html` is the same for all of a rule's. */
  async function newScan(
    rules: { ruleId: string; count: number; impact?: Impact; html?: string }[],
  ) {
    const [scan] = await db
      .insert(scans)
      .values({
        targets: ['https://example.com/'],
        status: 'completed',
        explainStatus: 'pending',
        createdByGithubId: 1,
        createdByLogin: 'test',
      })
      .returning();
    scanIds.push(scan!.id);
    await db.insert(issues).values(
      rules.flatMap(({ ruleId, count, impact = 'serious', html = `<img data-r="${ruleId}">` }) =>
        Array.from({ length: count }, (_, i) => ({
          scanId: scan!.id,
          ruleId,
          groupKey: ruleId,
          impact,
          help: 'Images must have alternative text',
          helpUrl: 'https://dequeuniversity.com/rules/axe/4.11/image-alt',
          wcag: ['1.1.1'],
          pageUrl: 'https://example.com/',
          selector: `img:nth-of-type(${i})`,
          html,
          fingerprint: `${ruleId}-${i}`,
        })),
      ),
    );
    return scan!.id;
  }

  const jobFor = (scanId: string, extra: Partial<Job> = {}) =>
    ({ id: randomUUID(), payload: { scanId }, ...extra }) as Job;

  const scanOf = async (scanId: string) =>
    (await db.select().from(scans).where(eq(scans.id, scanId)))[0]!;

  /** Provider over a stubbed API, with the real database ledger. */
  function setup(
    send: SendMessage,
    {
      monthlyBudgetUsd = 1e9,
      concurrency,
    }: { monthlyBudgetUsd?: number; concurrency?: number } = {},
  ) {
    const sent = vi.fn(send);
    const provider = createProvider({
      ledger: createDbLedger(db),
      mode: 'live',
      monthlyBudgetUsd,
      send: sent,
    });
    const handler = explainJob(db, provider, { concurrency, log: () => undefined });
    return { sent, handler };
  }

  const answers: SendMessage = () => Promise.resolve(reply(explanationJson));

  /** Runs the handler the way the worker does: its writes, then its commit. */
  async function run(handler: ReturnType<typeof explainJob>, scanId: string) {
    const commit = await handler.run(jobFor(scanId), {
      signal: new AbortController().signal,
      write: (fn) => db.transaction(fn),
    });
    await db.transaction(commit);
  }

  const issuesOf = (scanId: string) => db.select().from(issues).where(eq(issues.scanId, scanId));
  const runsOf = (scanId: string) =>
    db.select().from(agentRuns).where(eq(agentRuns.scanId, scanId));

  it('explains each rule group once and links all its issues', async () => {
    const [a, b] = [newRule('a'), newRule('b')];
    const scanId = await newScan([
      { ruleId: a, count: 3 },
      { ruleId: b, count: 1 },
    ]);
    const { sent, handler } = setup(answers);
    await run(handler, scanId);

    expect(sent).toHaveBeenCalledTimes(2);
    const rows = await issuesOf(scanId);
    expect(rows.every((r) => r.explanationId !== null)).toBe(true);
    expect(new Set(rows.filter((r) => r.ruleId === a).map((r) => r.explanationId)).size).toBe(1);
    expect(new Set(rows.map((r) => r.explanationId)).size).toBe(2);

    const stored = await db
      .select()
      .from(explanations)
      .where(inArray(explanations.ruleId, [a, b]));
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      model: MODELS.haiku,
      promptVersion: 'explain-v1',
      inputTokens: 1_000,
      outputTokens: 200,
      body: JSON.parse(explanationJson) as unknown,
    });
    expect(stored[0]!.costUsd).toBeCloseTo(CALL_COST, 6);

    const [agentRun] = await runsOf(scanId);
    expect(agentRun).toMatchObject({
      kind: 'pipeline',
      model: MODELS.haiku,
      promptVersion: 'explain-v1',
      status: 'ended',
      endReason: 'completed',
    });
    expect(agentRun!.costUsd).toBeCloseTo(2 * CALL_COST, 6);
    expect(await scanOf(scanId)).toMatchObject({ explainStatus: 'completed', explainError: null });
  });

  it('serves a repeat from the cache: no call, no cost', async () => {
    const ruleId = newRule();
    const html = '<img src="same.png">';
    const first = await newScan([{ ruleId, count: 2, html }]);
    const second = await newScan([{ ruleId, count: 5, html }]);
    const { sent, handler } = setup(answers);

    await run(handler, first);
    expect(sent).toHaveBeenCalledTimes(1);
    await run(handler, second);
    expect(sent).toHaveBeenCalledTimes(1);

    const [firstRow] = await issuesOf(first);
    const rows = await issuesOf(second);
    expect(rows.every((r) => r.explanationId === firstRow!.explanationId)).toBe(true);
    expect(
      await db.select().from(explanations).where(eq(explanations.ruleId, ruleId)),
    ).toHaveLength(1);
    const [agentRun] = await runsOf(second);
    expect(agentRun).toMatchObject({ status: 'ended', endReason: 'completed', costUsd: 0 });
    const [scan] = await db.select().from(scans).where(eq(scans.id, second));
    expect(scan!.costUsd).toBe(0);
  });

  it('asks again when the HTML differs', async () => {
    const ruleId = newRule();
    const first = await newScan([{ ruleId, count: 1, html: '<img src="one.png">' }]);
    const second = await newScan([{ ruleId, count: 1, html: '<img src="two.png">' }]);
    const { sent, handler } = setup(answers);
    await run(handler, first);
    await run(handler, second);
    expect(sent).toHaveBeenCalledTimes(2);
    expect(
      await db.select().from(explanations).where(eq(explanations.ruleId, ruleId)),
    ).toHaveLength(2);
  });

  it('stores one explanation when two scans of the same rule are explained at once', async () => {
    const ruleId = newRule();
    const html = '<img src="race.png">';
    const first = await newScan([{ ruleId, count: 1, html }]);
    const second = await newScan([{ ruleId, count: 1, html }]);
    const { handler } = setup(answers);
    await Promise.all([run(handler, first), run(handler, second)]);

    const stored = await db.select().from(explanations).where(eq(explanations.ruleId, ruleId));
    expect(stored).toHaveLength(1);
    const linked = [...(await issuesOf(first)), ...(await issuesOf(second))];
    expect(linked.map((r) => r.explanationId)).toEqual([stored[0]!.id, stored[0]!.id]);
  });

  it('never puts a password from the page in the request', async () => {
    const ruleId = newRule();
    const scanId = await newScan([
      { ruleId, count: 1, html: '<input type="password" value="hunter2-planted">' },
    ]);
    const { sent, handler } = setup(answers);
    await run(handler, scanId);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sent.mock.calls[0]![0])).not.toContain('hunter2-planted');
  });

  it('skips a group the model cannot answer and explains the rest', async () => {
    const [bad, good] = [newRule('bad'), newRule('good')];
    const scanId = await newScan([
      { ruleId: bad, count: 1 },
      { ruleId: good, count: 1 },
    ]);
    const { handler } = setup((params) =>
      Promise.resolve(
        JSON.stringify(params.messages).includes(bad) ? reply('not json') : reply(explanationJson),
      ),
    );
    await run(handler, scanId);

    const rows = await issuesOf(scanId);
    expect(rows.find((r) => r.ruleId === bad)!.explanationId).toBeNull();
    expect(rows.find((r) => r.ruleId === good)!.explanationId).not.toBeNull();
    const [agentRun] = await runsOf(scanId);
    expect(agentRun).toMatchObject({ status: 'ended', endReason: 'completed' });
    // The failed group's two attempts are still charged.
    expect(agentRun!.costUsd).toBeCloseTo(3 * CALL_COST, 6);
    const scan = await scanOf(scanId);
    expect(scan).toMatchObject({ explainStatus: 'completed' });
    expect(scan.explainError).toContain("1 of 2 groups couldn't be explained. First reason:");
    expect(scan.explainError).toContain(`Groups: ${bad}`);
  });

  it('marks the scan failed when no group could be explained', async () => {
    const scanId = await newScan([
      { ruleId: newRule(), count: 1 },
      { ruleId: newRule(), count: 1 },
    ]);
    const { handler } = setup(() => Promise.resolve(reply('not json')));
    await run(handler, scanId);
    expect((await issuesOf(scanId)).every((r) => r.explanationId === null)).toBe(true);
    expect(await scanOf(scanId)).toMatchObject({ explainStatus: 'failed' });
    expect((await runsOf(scanId))[0]).toMatchObject({ status: 'ended', endReason: 'error' });
  });

  it('fails permanently once the monthly budget is spent', async () => {
    const scanId = await newScan([{ ruleId: newRule(), count: 1 }]);
    const { sent, handler } = setup(answers, { monthlyBudgetUsd: 0 });
    await expect(run(handler, scanId)).rejects.toBeInstanceOf(PermanentError);
    expect(sent).not.toHaveBeenCalled();
    expect((await issuesOf(scanId))[0]!.explanationId).toBeNull();
  });

  it('still links the groups the cache can serve when the budget is spent', async () => {
    const [big, small] = [newRule('big'), newRule('small')];
    const html = '<img src="cached.png">';
    // `small` is explained already; `big` sorts first and has to ask.
    await run(setup(answers).handler, await newScan([{ ruleId: small, count: 1, html }]));
    const scanId = await newScan([
      { ruleId: big, count: 2, html },
      { ruleId: small, count: 1, html },
    ]);

    const { sent, handler } = setup(answers, { monthlyBudgetUsd: 0, concurrency: 1 });
    await expect(run(handler, scanId)).rejects.toBeInstanceOf(PermanentError);
    expect(sent).not.toHaveBeenCalled();
    const rows = await issuesOf(scanId);
    expect(rows.find((r) => r.ruleId === big)!.explanationId).toBeNull();
    expect(rows.find((r) => r.ruleId === small)!.explanationId).not.toBeNull();
  });

  /** An HTTP error from the API, as the SDK throws it. */
  const apiError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

  /** Three uncached groups, biggest first, so one at a time they're asked in a known order. */
  async function threeGroups() {
    const [a, b, c] = [newRule('a'), newRule('b'), newRule('c')];
    const scanId = await newScan([
      { ruleId: a, count: 3 },
      { ruleId: b, count: 2 },
      { ruleId: c, count: 1 },
    ]);
    return { a, b, c, scanId };
  }

  it('links the cached groups even when the calls then fail', async () => {
    const [cachedRule, a, b] = [newRule('cached'), newRule('a'), newRule('b')];
    const html = '<img src="cached2.png">';
    await run(setup(answers).handler, await newScan([{ ruleId: cachedRule, count: 1, html }]));
    const scanId = await newScan([
      { ruleId: a, count: 3 },
      { ruleId: b, count: 2 },
      { ruleId: cachedRule, count: 1, html },
    ]);
    const { sent, handler } = setup(() => Promise.reject(new Error('socket hang up')), {
      concurrency: 1,
    });
    await expect(run(handler, scanId)).rejects.toThrow('socket hang up');
    expect(sent).toHaveBeenCalledTimes(2);
    const rows = await issuesOf(scanId);
    expect(rows.find((r) => r.ruleId === cachedRule)!.explanationId).not.toBeNull();
    expect(rows.find((r) => r.ruleId === a)!.explanationId).toBeNull();
  });

  it('fails permanently on the first auth error, without calling for every group', async () => {
    const { scanId } = await threeGroups();
    const { sent, handler } = setup(() => Promise.reject(apiError(401)), { concurrency: 1 });
    await expect(run(handler, scanId)).rejects.toBeInstanceOf(PermanentError);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('fails permanently when the model or endpoint is not found', async () => {
    const { scanId } = await threeGroups();
    const { handler } = setup(() => Promise.reject(apiError(404)), { concurrency: 1 });
    await expect(run(handler, scanId)).rejects.toBeInstanceOf(PermanentError);
  });

  it('skips a group the API rejects as bad input, and explains the rest', async () => {
    const { a, b, c, scanId } = await threeGroups();
    const { sent, handler } = setup(
      (params) =>
        JSON.stringify(params.messages).includes(a)
          ? Promise.reject(apiError(400))
          : Promise.resolve(reply(explanationJson)),
      { concurrency: 1 },
    );
    await run(handler, scanId);
    expect(sent).toHaveBeenCalledTimes(3);
    const rows = await issuesOf(scanId);
    expect(rows.find((r) => r.ruleId === a)!.explanationId).toBeNull();
    expect(rows.find((r) => r.ruleId === b)!.explanationId).not.toBeNull();
    expect(rows.find((r) => r.ruleId === c)!.explanationId).not.toBeNull();
    expect((await scanOf(scanId)).explainError).toContain(`1 of 3 groups couldn't be explained`);
  });

  it('retries on a rate limit or server error instead of failing for good', async () => {
    for (const status of [429, 500, 529]) {
      const { scanId } = await threeGroups();
      const { handler } = setup(() => Promise.reject(apiError(status)), { concurrency: 1 });
      await expect(run(handler, scanId)).rejects.not.toBeInstanceOf(PermanentError);
    }
  });

  /** `count` uncached groups, biggest first. */
  async function manyGroups(count: number) {
    const rules = Array.from({ length: count }, (_, i) => newRule(`g${i}`));
    const scanId = await newScan(rules.map((ruleId, i) => ({ ruleId, count: count - i })));
    return { rules, scanId };
  }

  it('stops calling the model after a few transient errors', async () => {
    const { scanId } = await manyGroups(8);
    const { sent, handler } = setup(() => Promise.reject(apiError(529)), { concurrency: 1 });
    await expect(run(handler, scanId)).rejects.toThrow('HTTP 529');
    expect(sent).toHaveBeenCalledTimes(3);
  });

  it('explains every other group when one group always fails', async () => {
    const { rules, scanId } = await manyGroups(6);
    const bad = rules[1]!;
    const { sent, handler } = setup(
      (params) =>
        JSON.stringify(params.messages).includes(bad)
          ? Promise.reject(apiError(500))
          : Promise.resolve(reply(explanationJson)),
      { concurrency: 1 },
    );
    await expect(run(handler, scanId)).rejects.toThrow('HTTP 500');
    // Each group was asked once, and only the bad one is left.
    expect(sent).toHaveBeenCalledTimes(6);
    const rows = await issuesOf(scanId);
    expect(rows.filter((r) => r.explanationId === null).map((r) => r.ruleId)).toEqual(
      rows.filter((r) => r.ruleId === bad).map((r) => r.ruleId),
    );
    // A retry asks only for the one that failed.
    await expect(run(handler, scanId)).rejects.toThrow('HTTP 500');
    expect(sent).toHaveBeenCalledTimes(7);
  });

  it('treats a payment error as permanent', async () => {
    const { scanId } = await threeGroups();
    const { handler } = setup(() => Promise.reject(apiError(402)), { concurrency: 1 });
    await expect(run(handler, scanId)).rejects.toBeInstanceOf(PermanentError);
  });

  describe('when the API rejects requests with a 400', () => {
    // A spend limit set in the console, or an empty credit balance, is a 400
    // on every call, and says nothing about the groups.
    const spendLimit = () => Promise.reject(apiError(400));

    it('fails the job instead of skipping every group', async () => {
      const { scanId } = await manyGroups(8);
      const { sent, handler } = setup(spendLimit, { concurrency: 1 });
      await expect(run(handler, scanId)).rejects.toThrow(/rejected 3 requests in a row: HTTP 400/);
      expect(sent).toHaveBeenCalledTimes(3);
    });

    it('fails the job when there are too few groups to tell, and all are rejected', async () => {
      const { scanId } = await manyGroups(2);
      const { handler } = setup(spendLimit, { concurrency: 1 });
      await expect(run(handler, scanId)).rejects.toBeInstanceOf(PermanentError);
    });

    it('still links the cached groups', async () => {
      const [cachedRule, a, b, c] = [newRule('cached'), newRule('a'), newRule('b'), newRule('c')];
      const html = '<img src="cached3.png">';
      await run(setup(answers).handler, await newScan([{ ruleId: cachedRule, count: 1, html }]));
      const scanId = await newScan([
        { ruleId: a, count: 4 },
        { ruleId: b, count: 3 },
        { ruleId: c, count: 2 },
        { ruleId: cachedRule, count: 1, html },
      ]);
      const { handler } = setup(spendLimit, { concurrency: 1 });
      await expect(run(handler, scanId)).rejects.toBeInstanceOf(PermanentError);
      const rows = await issuesOf(scanId);
      expect(rows.find((r) => r.ruleId === cachedRule)!.explanationId).not.toBeNull();
    });

    it('skips bad groups as before while the API keeps answering in between', async () => {
      const { rules, scanId } = await manyGroups(6);
      // Groups are asked biggest first: g0 and g3 succeed, so no 3 rejections come in a row.
      const answers = new Set([rules[0], rules[3]]);
      const { sent, handler } = setup(
        (params) =>
          [...answers].some((r) => JSON.stringify(params.messages).includes(r!))
            ? Promise.resolve(reply(explanationJson))
            : Promise.reject(apiError(400)),
        { concurrency: 1 },
      );
      await run(handler, scanId);
      expect(sent).toHaveBeenCalledTimes(6);
      const scan = await scanOf(scanId);
      expect(scan.explainStatus).toBe('completed');
      expect(scan.explainError).toContain("4 of 6 groups couldn't be explained");
      expect(scan.explainError).toContain('First reason: HTTP 400');
    });

    it('fails the job when a spend limit is reached partway through', async () => {
      const { scanId } = await manyGroups(20);
      let calls = 0;
      const { sent, handler } = setup(
        () =>
          ++calls <= 5 ? Promise.resolve(reply(explanationJson)) : Promise.reject(apiError(400)),
        { concurrency: 1 },
      );
      await expect(run(handler, scanId)).rejects.toThrow(/rejected 3 requests in a row/);
      // 5 answered, then 3 rejected and no more.
      expect(sent).toHaveBeenCalledTimes(8);
      const rows = await issuesOf(scanId);
      expect(new Set(rows.filter((r) => r.explanationId).map((r) => r.ruleId)).size).toBe(5);
    });

    it('does not fail a rescan because one group is always rejected', async () => {
      const rules = Array.from({ length: 6 }, (_, i) => newRule(`r${i}`));
      const bad = rules[2]!;
      const stub: SendMessage = (params) =>
        JSON.stringify(params.messages).includes(bad)
          ? Promise.reject(apiError(413))
          : Promise.resolve(reply(explanationJson));
      const scanOf6 = () => newScan(rules.map((ruleId, i) => ({ ruleId, count: 6 - i })));

      const first = await scanOf6();
      await run(setup(stub, { concurrency: 1 }).handler, first);
      expect(await scanOf(first)).toMatchObject({ explainStatus: 'completed' });

      // Five groups now come from the cache; the sixth is rejected again.
      const second = await scanOf6();
      const { sent, handler } = setup(stub, { concurrency: 1 });
      await run(handler, second);
      expect(sent).toHaveBeenCalledTimes(1);
      const scan = await scanOf(second);
      expect(scan).toMatchObject({ explainStatus: 'completed' });
      expect(scan.explainError).toContain("1 of 6 groups couldn't be explained");
    });
  });

  it('stops calling the model once the job has lost its lock', async () => {
    const { scanId } = await threeGroups();
    const { sent, handler } = setup(answers, { concurrency: 1 });
    // The first write (the run's start) works; every write after it finds the lock gone.
    let writes = 0;
    await expect(
      handler.run(jobFor(scanId), {
        signal: new AbortController().signal,
        write: (fn) => {
          if (++writes > 1) return Promise.reject(new LostJobError('lost'));
          return db.transaction(fn);
        },
      }),
    ).rejects.toBeInstanceOf(LostJobError);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('puts the reason before the list of groups in the note, so a long list cannot cut it off', async () => {
    const scanId = await newScan(
      Array.from({ length: 40 }, () => ({
        ruleId: newRule('a-long-rule-name-for-the-note'),
        count: 1,
      })),
    );
    const { handler } = setup(() => Promise.resolve(reply('not json')));
    await run(handler, scanId);
    const scan = await scanOf(scanId);
    expect(scan.explainStatus).toBe('failed');
    expect(scan.explainError).toMatch(/^40 of 40 groups couldn't be explained\. First reason: /);
    expect(scan.explainError!.length).toBeLessThanOrEqual(500);
  });

  it('lets a transient error through for the queue to retry, and ends the attempt’s run', async () => {
    const scanId = await newScan([{ ruleId: newRule(), count: 1 }]);
    const { handler } = setup(() => Promise.reject(new Error('socket hang up')));
    await expect(run(handler, scanId)).rejects.toThrow('socket hang up');
    expect((await runsOf(scanId))[0]).toMatchObject({ status: 'running' });

    // What the queue does when it requeues the job: the scan waits, with the reason.
    const requeued = jobFor(scanId, { status: 'queued', error: 'socket hang up' });
    await db.transaction((tx) => handler.onAttemptEnded!(tx, requeued));
    expect((await runsOf(scanId))[0]).toMatchObject({ status: 'ended', endReason: 'error' });
    expect(await scanOf(scanId)).toMatchObject({
      explainStatus: 'pending',
      explainError: 'socket hang up',
    });

    // And when it's out of attempts: the scan stops waiting.
    const failed = jobFor(scanId, { status: 'failed', error: 'socket hang up' });
    await db.transaction((tx) => handler.onAttemptEnded!(tx, failed));
    expect(await scanOf(scanId)).toMatchObject({
      explainStatus: 'failed',
      explainError: 'socket hang up',
    });
  });

  it('does not count a call that lost the race to store its answer as a cache hit', async () => {
    const ruleId = newRule();
    const issue = { ruleId, help: 'h', wcag: ['1.1.1'], html: '<img src="race2.png">' };
    // Both calls miss the cache, and neither answers until both have asked.
    let asked = 0;
    let release!: () => void;
    const bothAsked = new Promise<void>((resolve) => (release = resolve));
    const { sent } = setup(async () => {
      if (++asked === 2) release();
      await bothAsked;
      return reply(explanationJson);
    });
    const provider = createProvider({
      ledger: createDbLedger(db),
      mode: 'live',
      monthlyBudgetUsd: 1e9,
      send: sent,
    });
    const scanId = await newScan([{ ruleId, count: 1 }]);
    const [run] = await db
      .insert(agentRuns)
      .values({ scanId, kind: 'pipeline', model: MODELS.haiku, promptVersion: 'explain-v1' })
      .returning();
    const ctx = { runId: run!.id };
    const [x, y] = await Promise.all([
      explainGroup({ db, provider }, [issue], ctx),
      explainGroup({ db, provider }, [issue], ctx),
    ]);
    expect(sent).toHaveBeenCalledTimes(2);
    expect([x.cached, y.cached]).toEqual([false, false]);
    expect(x.explanationId).toBe(y.explanationId);
  });

  it('stands in when the LLM is not configured: fails at once, and the scan says why', async () => {
    const scanId = await newScan([{ ruleId: newRule(), count: 1 }]);
    const handler = explainUnavailableJob('LLM_MODE=replay needs a recordings directory');
    await expect(run(handler, scanId)).rejects.toBeInstanceOf(PermanentError);
    const failed = jobFor(scanId, {
      status: 'failed',
      error: 'LLM_MODE=replay needs a recordings directory',
    });
    await db.transaction((tx) => handler.onAttemptEnded!(tx, failed));
    expect(await scanOf(scanId)).toMatchObject({
      explainStatus: 'failed',
      explainError: 'LLM_MODE=replay needs a recordings directory',
    });
  });

  it('on a retry, reuses what the failed attempt already explained', async () => {
    const [a, b] = [newRule('a'), newRule('b')];
    const scanId = await newScan([
      { ruleId: a, count: 2 },
      { ruleId: b, count: 1 },
    ]);
    // One group at a time, biggest first: `a` succeeds, then `b` fails once.
    let calls = 0;
    const { sent, handler } = setup(
      () =>
        ++calls === 2
          ? Promise.reject(new Error('socket hang up'))
          : Promise.resolve(reply(explanationJson)),
      { concurrency: 1 },
    );
    await expect(run(handler, scanId)).rejects.toThrow('socket hang up');
    const afterFirst = await issuesOf(scanId);
    expect(afterFirst.find((r) => r.ruleId === a)!.explanationId).not.toBeNull();
    expect(afterFirst.find((r) => r.ruleId === b)!.explanationId).toBeNull();

    await db.transaction((tx) => handler.onAttemptEnded!(tx, jobFor(scanId)));
    await run(handler, scanId);

    // Two calls in the first attempt, and only `b` again in the second.
    expect(sent).toHaveBeenCalledTimes(3);
    expect((await issuesOf(scanId)).every((r) => r.explanationId !== null)).toBe(true);
    const runs = await runsOf(scanId);
    expect(runs.map((r) => r.endReason).sort()).toEqual(['completed', 'error']);
  });

  it('fails permanently for a scan that does not exist or a bad payload', async () => {
    const { handler } = setup(answers);
    await expect(run(handler, randomUUID())).rejects.toBeInstanceOf(PermanentError);
    await expect(
      handler.run({ id: 'x', payload: { scanId: 'nope' } } as Job, {
        signal: new AbortController().signal,
        write: (fn) => db.transaction(fn),
      }),
    ).rejects.toThrow(/Invalid explain job payload/);
  });
});
