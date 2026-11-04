// The run report: one record per case, run totals, and the printed summary.
// The JSON report is also what `--rescore` reads back.
import { EvalResult, PatchOutcome, PatchProposal } from '@curbcut/core';
import { z } from 'zod';

export const RunMode = z.enum(['live', 'reference', 'rescore']);
export type RunMode = z.infer<typeof RunMode>;

export const CaseRecord = z.strictObject({
  result: EvalResult,
  expectedOutcome: PatchOutcome,
  category: z.string().min(1),
  pass: z.boolean(),
  /** What the fixer proposed, so the run can be rescored and inspected. */
  proposal: PatchProposal.optional(),
  /** Why a scorer failed, or what a crashed case threw. */
  notes: z.array(z.string()),
});
export type CaseRecord = z.infer<typeof CaseRecord>;

const Tally = z.strictObject({ cases: z.int().nonnegative(), passed: z.int().nonnegative() });

export const RunTotals = z.strictObject({
  cases: z.int().nonnegative(),
  passed: z.int().nonnegative(),
  passRate: z.number().min(0).max(1),
  byExpected: z.partialRecord(PatchOutcome, Tally),
  byCategory: z.record(z.string(), Tally),
  /** Cases whose patch broke tsc, ESLint, or the case's test: a merge-blocking gate (#17). */
  buildBreaks: z.int().nonnegative(),
  /** Cases where the fixer crashed or its proposal could not be read. */
  errors: z.int().nonnegative(),
  costUsd: z.number().nonnegative(),
  latencyMs: z.strictObject({
    p50: z.int().nonnegative(),
    p95: z.int().nonnegative(),
    max: z.int().nonnegative(),
  }),
});
export type RunTotals = z.infer<typeof RunTotals>;

export const RunReport = z.strictObject({
  createdAt: z.iso.datetime(),
  mode: RunMode,
  datasetVersion: z.int().positive(),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  axeVersion: z.string().optional(),
  totals: RunTotals,
  cases: z.array(CaseRecord),
});
export type RunReport = z.infer<typeof RunReport>;

/**
 * Whether a case passes (plan, "Eval design"). A fix case needs (a), (b) and
 * (c); the judge (d) joins in #15. A no-change case passes with any outcome
 * but a fix: answering `unsure` is a safe miss, not a wrong edit. An unsure
 * case passes only by asking.
 */
export function passed(expected: PatchOutcome, r: EvalResult): boolean {
  if (r.outcome === 'error') return false;
  switch (expected) {
    case 'fix':
      return (
        r.outcome === 'fix' &&
        r.scores.resolved === true &&
        r.scores.buildSafe === true &&
        r.scores.scoped === true
      );
    case 'no_change_needed':
      return r.outcome !== 'fix';
    case 'unsure':
      return r.outcome === 'unsure';
  }
}

/** Nearest-rank percentile of `values`; 0 when empty. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

export function totals(records: CaseRecord[]): RunTotals {
  const tally = (key: (r: CaseRecord) => string) => {
    const out: Record<string, { cases: number; passed: number }> = {};
    for (const r of records) {
      const t = (out[key(r)] ??= { cases: 0, passed: 0 });
      t.cases++;
      if (r.pass) t.passed++;
    }
    return out;
  };
  const latencies = records.map((r) => r.result.latencyMs);
  const passedCount = records.filter((r) => r.pass).length;
  return {
    cases: records.length,
    passed: passedCount,
    passRate: records.length === 0 ? 0 : passedCount / records.length,
    byExpected: tally((r) => r.expectedOutcome),
    byCategory: tally((r) => r.category),
    buildBreaks: records.filter(
      (r) => r.result.outcome !== 'error' && r.result.scores.buildSafe === false,
    ).length,
    errors: records.filter((r) => r.result.outcome === 'error').length,
    costUsd: records.reduce((sum, r) => sum + r.result.costUsd, 0),
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: Math.max(0, ...latencies),
    },
  };
}

const mark = (v: boolean | undefined) => (v === undefined ? '-' : v ? 'ok' : 'FAIL');
const pct = (t: { cases: number; passed: number }) =>
  `${t.passed}/${t.cases} (${t.cases === 0 ? 0 : Math.round((100 * t.passed) / t.cases)}%)`;
const usd = (n: number) => `$${n.toFixed(4)}`;

/** The summary table and totals, as lines to print. */
export function summaryLines(report: RunReport): string[] {
  const rows = report.cases.map((r) => {
    const s = r.result.outcome === 'error' ? undefined : r.result.scores;
    return [
      r.result.caseId,
      r.expectedOutcome,
      r.result.outcome,
      mark(s?.resolved),
      mark(s?.buildSafe),
      mark(s?.scoped),
      usd(r.result.costUsd),
      `${r.result.latencyMs}ms`,
      r.pass ? 'PASS' : 'FAIL',
    ];
  });
  const header = ['case', 'expected', 'outcome', '(a)', '(b)', '(c)', 'cost', 'latency', 'result'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');

  const t = report.totals;
  const out = [
    `Eval run (${report.mode}): dataset v${report.datasetVersion}, model ${report.model}, prompt ${report.promptVersion}` +
      (report.axeVersion ? `, axe ${report.axeVersion}` : ''),
    '',
    line(header),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map(line),
    '',
    `Passed       ${pct(t)}`,
    ...Object.entries(t.byExpected).map(([k, v]) => `  ${k.padEnd(18)} ${pct(v)}`),
    `Build breaks ${t.buildBreaks}`,
    `Errors       ${t.errors}`,
    `Cost         ${usd(t.costUsd)} total`,
    `Latency      p50 ${t.latencyMs.p50}ms, p95 ${t.latencyMs.p95}ms, max ${t.latencyMs.max}ms`,
  ];
  const failures = report.cases.filter((r) => !r.pass && r.notes.length > 0);
  if (failures.length > 0) {
    out.push('', 'Failures:');
    for (const r of failures) {
      out.push(`  ${r.result.caseId}`);
      for (const n of r.notes) out.push(`    - ${n.replaceAll('\n', '\n      ')}`);
    }
  }
  return out;
}
