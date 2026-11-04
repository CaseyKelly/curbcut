// Integration tests for the explain job against a migrated database, with a
// real provider and ledger over a stubbed API. Skipped without DATABASE_URL.
//
// These call the handler directly instead of ticking the worker: other test
// files share the queue, and a tick here could claim their jobs and the other
// way round. Rule ids are unique per run, because the explanation cache is
// shared and keyed on the rule.
import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { createDbLedger, createProvider, MODELS, type SendMessage } from '@curbcut/agent';
import type { Impact } from '@curbcut/core';
import { agentRuns, createDb, explanations, issues, scans, type Db } from '@curbcut/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PermanentError } from '../errors';
import type { Job } from '../queue';
import { explainJob } from './explain';

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

  const jobFor = (scanId: string) => ({ id: randomUUID(), payload: { scanId } }) as Job;

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
  });

  it('fails permanently once the monthly budget is spent', async () => {
    const scanId = await newScan([{ ruleId: newRule(), count: 1 }]);
    const { sent, handler } = setup(answers, { monthlyBudgetUsd: 0 });
    await expect(run(handler, scanId)).rejects.toBeInstanceOf(PermanentError);
    expect(sent).not.toHaveBeenCalled();
    expect((await issuesOf(scanId))[0]!.explanationId).toBeNull();
  });

  it('lets a transient error through for the queue to retry, and ends the attempt’s run', async () => {
    const scanId = await newScan([{ ruleId: newRule(), count: 1 }]);
    const { handler } = setup(() => Promise.reject(new Error('socket hang up')));
    await expect(run(handler, scanId)).rejects.toThrow('socket hang up');
    expect((await runsOf(scanId))[0]).toMatchObject({ status: 'running' });

    // What the queue does when it requeues or fails the job.
    await db.transaction((tx) => handler.onAttemptEnded!(tx, jobFor(scanId)));
    expect((await runsOf(scanId))[0]).toMatchObject({ status: 'ended', endReason: 'error' });
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
