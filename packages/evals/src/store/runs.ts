// Saving eval runs to `eval_runs` and `eval_results`, and reading them back
// as run reports, so a stored run compares like a JSON one (#16).
import { evalResults, evalRuns, evalTrigger, type Db } from '@curbcut/db';
import type { EvalScores } from '@curbcut/core';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { RunReport, RunTotals, type CaseRecord } from '../runner/report.ts';

export const EvalTrigger = z.enum(evalTrigger.enumValues);
export type EvalTrigger = z.infer<typeof EvalTrigger>;

/** Where and why a run happened; the report itself doesn't know. */
export interface RunSource {
  gitSha: string;
  branch: string;
  trigger: EvalTrigger;
}

export interface StoredRun extends RunSource {
  id: string;
  report: RunReport;
}

type RunRow = typeof evalRuns.$inferInsert;
type ResultRow = Omit<typeof evalResults.$inferInsert, 'runId'>;

/**
 * The rows for a report. Only live runs are stored: a reference run is a
 * self-check, not the agent's score, and a rescore repeats a stored run's
 * cost, which would count it twice against the monthly budget.
 */
export function toRows(
  report: RunReport,
  source: RunSource,
): { run: RunRow; results: ResultRow[] } {
  if (report.mode !== 'live') {
    throw new Error(`only live runs are saved; this report is a ${report.mode} run`);
  }
  const results = report.cases.map((record): ResultRow => {
    const r = record.result;
    // The runner stamps each result with the run's versions; a mismatch means
    // a hand-edited or merged report, which can't be described by one run row.
    for (const key of ['datasetVersion', 'model', 'promptVersion'] as const) {
      if (r[key] !== report[key]) {
        throw new Error(`${r.caseId}: ${key} ${r[key]} differs from the run's ${report[key]}`);
      }
    }
    const common = {
      caseId: r.caseId,
      caseVersion: r.caseVersion,
      category: record.category,
      expectedOutcome: record.expectedOutcome,
      proposal: record.proposal ?? null,
      notes: record.notes,
      costUsd: r.costUsd,
      latencyMs: r.latencyMs,
      pass: record.pass,
    };
    if (r.outcome === 'error') return { ...common, outcome: 'error', error: r.error };
    const s = r.scores;
    return {
      ...common,
      outcome: r.outcome,
      outcomeCorrect: r.outcomeCorrect,
      resolved: s.resolved ?? null,
      buildOk: s.buildSafe ?? null,
      scopeOk: s.scoped ?? null,
      mappingCorrect: s.mappingCorrect ?? null,
      judgeScore: s.judge?.score ?? null,
      judgeReason: s.judge?.reason ?? null,
      judgeModel: s.judge?.model ?? null,
      judgePromptVersion: s.judge?.promptVersion ?? null,
    };
  });
  return {
    run: {
      ...source,
      datasetVersion: report.datasetVersion,
      model: report.model,
      promptVersion: report.promptVersion,
      axeVersion: report.axeVersion ?? null,
      totals: report.totals,
      costUsd: report.totals.costUsd,
      createdAt: new Date(report.createdAt),
    },
    results,
  };
}

/** The report a run's rows came from. Parsed, so a bad row fails here. */
export function fromRows(
  run: typeof evalRuns.$inferSelect,
  results: (typeof evalResults.$inferSelect)[],
): StoredRun {
  const cases = results.map((row): CaseRecord => {
    const base = {
      caseId: row.caseId,
      datasetVersion: run.datasetVersion,
      caseVersion: row.caseVersion,
      costUsd: row.costUsd,
      latencyMs: row.latencyMs,
      model: run.model,
      promptVersion: run.promptVersion,
    };
    const judge =
      row.judgeScore === null
        ? undefined
        : {
            score: row.judgeScore,
            reason: row.judgeReason!,
            model: row.judgeModel!,
            promptVersion: row.judgePromptVersion!,
          };
    // Null columns are scorers that didn't run, which the schema leaves out.
    const scores: EvalScores = {};
    if (row.resolved !== null) scores.resolved = row.resolved;
    if (row.buildOk !== null) scores.buildSafe = row.buildOk;
    if (row.scopeOk !== null) scores.scoped = row.scopeOk;
    if (row.mappingCorrect !== null) scores.mappingCorrect = row.mappingCorrect;
    if (judge) scores.judge = judge;
    return {
      result:
        row.outcome === 'error'
          ? { ...base, outcome: 'error', error: row.error! }
          : { ...base, outcome: row.outcome, outcomeCorrect: row.outcomeCorrect!, scores },
      expectedOutcome: row.expectedOutcome,
      category: row.category,
      pass: row.pass,
      ...(row.proposal === null ? {} : { proposal: row.proposal as CaseRecord['proposal'] }),
      notes: row.notes,
    };
  });
  const report = RunReport.parse({
    createdAt: run.createdAt.toISOString(),
    mode: 'live',
    datasetVersion: run.datasetVersion,
    model: run.model,
    promptVersion: run.promptVersion,
    ...(run.axeVersion === null ? {} : { axeVersion: run.axeVersion }),
    totals: RunTotals.parse(run.totals),
    cases,
  });
  return {
    id: run.id,
    gitSha: run.gitSha,
    branch: run.branch,
    trigger: run.trigger,
    report,
  };
}

/** Saves a live run and its results in one transaction. Returns the run's id. */
export async function saveRun(db: Db, report: RunReport, source: RunSource): Promise<string> {
  const { run, results } = toRows(report, source);
  return db.transaction(async (tx) => {
    const [saved] = await tx.insert(evalRuns).values(run).returning({ id: evalRuns.id });
    const runId = saved!.id;
    if (results.length > 0) {
      await tx.insert(evalResults).values(results.map((r) => ({ ...r, runId })));
    }
    return runId;
  });
}

/** A stored run by id, or undefined if there's none. */
export async function loadRun(db: Db, id: string): Promise<StoredRun | undefined> {
  if (!z.uuid().safeParse(id).success) return undefined;
  const [run] = await db.select().from(evalRuns).where(eq(evalRuns.id, id));
  if (!run) return undefined;
  const results = await db
    .select()
    .from(evalResults)
    .where(eq(evalResults.runId, id))
    .orderBy(asc(evalResults.caseId));
  return fromRows(run, results);
}

/**
 * The baseline a run is compared against (#17): the latest run on `branch`
 * (by default `main`) for the same dataset version, since results from
 * different dataset versions aren't compared.
 */
export async function latestRun(
  db: Db,
  datasetVersion: number,
  branch = 'main',
): Promise<StoredRun | undefined> {
  const [run] = await db
    .select({ id: evalRuns.id })
    .from(evalRuns)
    .where(and(eq(evalRuns.branch, branch), eq(evalRuns.datasetVersion, datasetVersion)))
    .orderBy(desc(evalRuns.createdAt))
    .limit(1);
  return run ? loadRun(db, run.id) : undefined;
}
