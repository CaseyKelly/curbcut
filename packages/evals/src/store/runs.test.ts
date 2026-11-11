import { createDb, evalResults, evalRuns, type Db } from '@curbcut/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ok, record, report } from './fixtures';
import { fromRows, latestRun, loadRun, saveRun, toRows } from './runs';

const source = { gitSha: 'abc1234', branch: 'main', trigger: 'weekly' as const };

const sample = () =>
  report([
    record('fix-1', {
      scores: { ...ok, judge: { score: 4, reason: 'Minimal.', model: 'j', promptVersion: 'jv1' } },
      costUsd: 0.012345,
    }),
    record('fix-2', { scores: { ...ok, scoped: false }, pass: false, category: 'forms' }),
    record('no-change-1', { expected: 'no_change_needed', category: 'no-change' }),
    record('error-1', { outcome: 'error', pass: false }),
  ]);

describe('toRows', () => {
  it('saves only live runs', () => {
    expect(() => toRows(report([], { mode: 'reference' }), source)).toThrow(/reference run/);
    expect(() => toRows(report([], { mode: 'rescore' }), source)).toThrow(/rescore run/);
  });

  it("refuses a result stamped with another run's versions", () => {
    const r = record('a');
    r.result.promptVersion = 'other';
    expect(() => toRows(report([r]), source)).toThrow(/a: promptVersion other/);
  });

  it('maps scores to columns and back', () => {
    const { run, results } = toRows(sample(), source);
    expect(run).toMatchObject({ ...source, costUsd: sample().totals.costUsd });
    expect(results[0]).toMatchObject({ buildOk: true, judgeScore: 4, judgeModel: 'j' });
    expect(results[2]).toMatchObject({ resolved: null, scopeOk: true });
    expect(results[3]).toMatchObject({ outcome: 'error', error: 'boom' });

    // Rows as the database returns them.
    const id = '00000000-0000-4000-8000-000000000000';
    const stored = fromRows(
      {
        ...run,
        id,
        axeVersion: run.axeVersion ?? null,
        costUsd: run.costUsd ?? 0,
        createdAt: run.createdAt!,
      },
      results.map((r, i) => ({
        id: `${i}`,
        runId: id,
        outcomeCorrect: null,
        resolved: null,
        buildOk: null,
        scopeOk: null,
        mappingCorrect: null,
        judgeScore: null,
        judgeReason: null,
        judgeModel: null,
        judgePromptVersion: null,
        error: null,
        proposal: null,
        ...r,
        costUsd: r.costUsd ?? 0,
        notes: r.notes ?? [],
      })),
    );
    expect(stored).toEqual({ id, ...source, report: sample() });
  });
});

describe.skipIf(!process.env.DATABASE_URL)('stored runs', () => {
  let db: Db;
  const runIds: string[] = [];
  // Unique per test run, so the baseline lookup can't see other runs. Dated in
  // the past so they don't count towards this month's budget in other tests.
  const branch = `test-${crypto.randomUUID()}`;

  beforeAll(() => {
    db = createDb();
  });

  afterAll(async () => {
    if (!db) return;
    if (runIds.length > 0) await db.delete(evalRuns).where(inArray(evalRuns.id, runIds));
    await db.$client.end();
  });

  async function save(createdAt: string, overrides: Parameters<typeof report>[1] = {}) {
    const id = await saveRun(db, report(sample().cases, { createdAt, ...overrides }), {
      ...source,
      branch,
    });
    runIds.push(id);
    return id;
  }

  it('round-trips a run', async () => {
    const id = await save('2020-01-01T00:00:00.000Z');
    const loaded = await loadRun(db, id);
    expect(loaded).toEqual({
      id,
      ...source,
      branch,
      report: {
        ...sample(),
        createdAt: '2020-01-01T00:00:00.000Z',
        cases: sample().cases.sort((a, b) => a.result.caseId.localeCompare(b.result.caseId)),
      },
    });
  });

  it('returns undefined for an unknown or malformed id', async () => {
    expect(await loadRun(db, crypto.randomUUID())).toBeUndefined();
    expect(await loadRun(db, 'not-a-uuid')).toBeUndefined();
  });

  it('finds the latest run on a branch for a dataset version', async () => {
    const older = await save('2020-02-01T00:00:00.000Z');
    const newer = await save('2020-03-01T00:00:00.000Z');
    await save('2020-04-01T00:00:00.000Z', {
      datasetVersion: 2,
      cases: sample().cases.map((r) => ({ ...r, result: { ...r.result, datasetVersion: 2 } })),
    });
    expect((await latestRun(db, 1, branch))?.id).toBe(newer);
    expect((await latestRun(db, 1, branch))?.id).not.toBe(older);
    expect((await latestRun(db, 3, branch))?.id).toBeUndefined();
  });

  it('deletes results with their run', async () => {
    const id = await save('2020-05-01T00:00:00.000Z');
    await db.delete(evalRuns).where(eq(evalRuns.id, id));
    expect(await db.select().from(evalResults).where(eq(evalResults.runId, id))).toEqual([]);
  });

  it('rejects a judge score without its reason and versions', async () => {
    const id = await save('2020-06-01T00:00:00.000Z');
    const err: unknown = await db
      .insert(evalResults)
      .values({
        runId: id,
        caseId: 'x',
        caseVersion: 1,
        category: 'images',
        expectedOutcome: 'fix',
        outcome: 'fix',
        outcomeCorrect: true,
        judgeScore: 4,
        latencyMs: 1,
        pass: true,
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(((err as Error).cause as { constraint_name?: string }).constraint_name).toBe(
      'eval_results_judge_check',
    );
  });
});
