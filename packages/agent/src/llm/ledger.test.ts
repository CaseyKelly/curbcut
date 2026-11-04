// Integration tests for the database ledger. Skipped without DATABASE_URL,
// like the db package's tests.
import { agentRuns, createDb, scans, type Db } from '@curbcut/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbLedger, startOfMonthUtc } from './ledger';

describe('startOfMonthUtc', () => {
  it('is midnight UTC on the first of the month', () => {
    expect(startOfMonthUtc(new Date('2026-10-29T23:59:00-07:00')).toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });
});

describe.skipIf(!process.env.DATABASE_URL)('createDbLedger', () => {
  let db: Db;
  const scanIds: string[] = [];

  beforeAll(() => {
    db = createDb();
  });

  afterAll(async () => {
    if (!db) return;
    // Runs cascade.
    for (const id of scanIds) await db.delete(scans).where(eq(scans.id, id));
    await db.$client.end();
  });

  async function newRun(createdAt?: Date) {
    const [scan] = await db
      .insert(scans)
      .values({ targets: ['https://example.com/'], createdByGithubId: 1, createdByLogin: 'test' })
      .returning();
    scanIds.push(scan!.id);
    const [run] = await db
      .insert(agentRuns)
      .values({
        scanId: scan!.id,
        kind: 'pipeline',
        model: 'claude-haiku-5-5',
        promptVersion: 'test',
        ...(createdAt && { createdAt }),
      })
      .returning();
    return run!;
  }

  it('adds each call to the run and its scan', async () => {
    const ledger = createDbLedger(db);
    const run = await newRun();
    const call = { runId: run.id, model: 'claude-haiku-5-5', inputTokens: 100, outputTokens: 10 };
    await ledger.record({ ...call, costUsd: 0.000123 });
    await ledger.record({ ...call, costUsd: 0.000877 });

    const [updated] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
    expect(updated).toMatchObject({ inputTokens: 200, outputTokens: 20, costUsd: 0.001 });
    const [scan] = await db.select().from(scans).where(eq(scans.id, run.scanId));
    expect(scan).toMatchObject({ inputTokens: 200, outputTokens: 20, costUsd: 0.001 });
  });

  it('fails for a run that does not exist', async () => {
    await expect(
      createDbLedger(db).record({
        runId: '00000000-0000-0000-0000-000000000000',
        model: 'claude-haiku-5-5',
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.01,
      }),
    ).rejects.toThrow(/No agent run/);
  });

  it("sums this month's runs and skips earlier ones", async () => {
    // Other test files may add runs concurrently, so compare deltas.
    const ledger = createDbLedger(db);
    const before = await ledger.monthToDateSpendUsd();
    const old = await newRun(new Date(startOfMonthUtc().getTime() - 1));
    const current = await newRun();
    const call = { model: 'claude-haiku-5-5', inputTokens: 1, outputTokens: 1 };
    await ledger.record({ ...call, runId: old.id, costUsd: 5 });
    await ledger.record({ ...call, runId: current.id, costUsd: 0.25 });
    expect((await ledger.monthToDateSpendUsd()) - before).toBeCloseTo(0.25);
  });
});
