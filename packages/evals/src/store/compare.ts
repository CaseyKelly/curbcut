// Compares two eval runs, per metric and per case (#16). Pure, so the CI
// comment (#17) and the /evals page (#18) can reuse it on any two reports.
import type { PatchOutcome } from '@curbcut/core';
import { totals, type CaseRecord, type RunReport, type RunTotals } from '../runner/report.ts';

type Tally = { cases: number; passed: number };

export interface Metric {
  name: string;
  unit: 'rate' | 'count' | 'usd' | 'ms';
  base: number;
  head: number;
  /** For a rate, in percentage points. */
  delta: number;
}

export type CaseChange = 'regressed' | 'fixed' | 'changed';

export interface CaseDiff {
  caseId: string;
  change: CaseChange;
  /** What differs, e.g. `outcome: fix -> unsure`. */
  details: string[];
}

export interface RunComparison {
  datasetVersion: number;
  /** Metrics are computed over the cases both runs have, at the same case version. */
  sharedCases: number;
  onlyInBase: string[];
  onlyInHead: string[];
  metrics: Metric[];
  /** Per-category tallies over the shared cases. */
  categories: { category: string; base: Tally; head: Tally; delta: number }[];
  /** Shared cases whose result differs, regressions first. */
  cases: CaseDiff[];
}

const rate = (t: Tally | undefined) => (t && t.cases > 0 ? t.passed / t.cases : 0);
const points = (base: number, head: number) => Math.round((head - base) * 1000) / 10;

/** The headline numbers, in the order they're shown. */
function metrics(base: RunTotals, head: RunTotals): Metric[] {
  const m = (name: string, unit: Metric['unit'], pick: (t: RunTotals) => number): Metric => {
    const b = pick(base);
    const h = pick(head);
    return { name, unit, base: b, head: h, delta: unit === 'rate' ? points(b, h) : h - b };
  };
  const byExpected = (o: PatchOutcome) => (t: RunTotals) => rate(t.byExpected[o]);
  return [
    m('pass rate', 'rate', (t) => t.passRate),
    m('fix cases', 'rate', byExpected('fix')),
    m('no-change accuracy', 'rate', byExpected('no_change_needed')),
    m('unsure cases', 'rate', byExpected('unsure')),
    m('build breaks', 'count', (t) => t.buildBreaks),
    m('errors', 'count', (t) => t.errors),
    m('cost', 'usd', (t) => t.costUsd),
    m('p95 latency', 'ms', (t) => t.latencyMs.p95),
  ];
}

const show = (v: string | number | boolean | undefined) => (v === undefined ? '-' : String(v));

/** What differs between two results for the same case. */
function caseDetails(base: CaseRecord, head: CaseRecord): string[] {
  const out: string[] = [];
  type Value = string | number | boolean | undefined;
  const diff = (name: string, b: Value, h: Value) => {
    if (b !== h) out.push(`${name}: ${show(b)} -> ${show(h)}`);
  };
  const b = base.result;
  const h = head.result;
  diff('outcome', b.outcome, h.outcome);
  const bs = b.outcome === 'error' ? undefined : b.scores;
  const hs = h.outcome === 'error' ? undefined : h.scores;
  diff('(a) resolved', bs?.resolved, hs?.resolved);
  diff('(b) build safe', bs?.buildSafe, hs?.buildSafe);
  diff('(c) scoped', bs?.scoped, hs?.scoped);
  diff('(d) judge', bs?.judge?.score, hs?.judge?.score);
  diff('mapping', bs?.mappingCorrect, hs?.mappingCorrect);
  return out;
}

/**
 * Compares `head` against `base`. Throws if their dataset versions differ:
 * results from different dataset versions aren't compared.
 */
export function compareRuns(base: RunReport, head: RunReport): RunComparison {
  if (base.datasetVersion !== head.datasetVersion) {
    throw new Error(
      `can't compare dataset v${base.datasetVersion} with v${head.datasetVersion}; ` +
        "results from different dataset versions aren't compared",
    );
  }
  // A case is shared only at the same version: a changed case is a new question.
  const key = (r: CaseRecord) => `${r.result.caseId}@${r.result.caseVersion}`;
  const headByKey = new Map(head.cases.map((r) => [key(r), r]));
  const baseKeys = new Set(base.cases.map(key));
  const pairs = base.cases.flatMap((b) => {
    const h = headByKey.get(key(b));
    return h ? [[b, h] as const] : [];
  });
  const baseTotals = totals(pairs.map(([b]) => b));
  const headTotals = totals(pairs.map(([, h]) => h));

  const cases: CaseDiff[] = [];
  for (const [b, h] of pairs) {
    const details = caseDetails(b, h);
    if (b.pass === h.pass && details.length === 0) continue;
    const change: CaseChange = b.pass === h.pass ? 'changed' : h.pass ? 'fixed' : 'regressed';
    cases.push({ caseId: b.result.caseId, change, details });
  }
  const order: Record<CaseChange, number> = { regressed: 0, fixed: 1, changed: 2 };
  cases.sort((x, y) => order[x.change] - order[y.change] || x.caseId.localeCompare(y.caseId));

  const categoryNames = [
    ...new Set([...Object.keys(baseTotals.byCategory), ...Object.keys(headTotals.byCategory)]),
  ].sort();
  const empty: Tally = { cases: 0, passed: 0 };
  const categories = categoryNames.map((category) => {
    const b = baseTotals.byCategory[category] ?? empty;
    const h = headTotals.byCategory[category] ?? empty;
    return { category, base: b, head: h, delta: points(rate(b), rate(h)) };
  });

  return {
    datasetVersion: base.datasetVersion,
    sharedCases: pairs.length,
    onlyInBase: base.cases.filter((r) => !headByKey.has(key(r))).map((r) => r.result.caseId),
    onlyInHead: head.cases.filter((r) => !baseKeys.has(key(r))).map((r) => r.result.caseId),
    metrics: metrics(baseTotals, headTotals),
    categories,
    cases,
  };
}

const signed = (n: number, digits = 0) => `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;

function formatValue(unit: Metric['unit'], v: number): string {
  switch (unit) {
    case 'rate':
      return `${(v * 100).toFixed(1)}%`;
    case 'usd':
      return `$${v.toFixed(4)}`;
    case 'ms':
      return `${v}ms`;
    case 'count':
      return String(v);
  }
}

function formatDelta(unit: Metric['unit'], d: number): string {
  if (d === 0) return '0';
  switch (unit) {
    case 'rate':
      return `${signed(d, 1)} pts`;
    case 'usd':
      return `${d > 0 ? '+' : '-'}$${Math.abs(d).toFixed(4)}`;
    case 'ms':
      return `${signed(d)}ms`;
    case 'count':
      return signed(d);
  }
}

/** Pads columns to line up; the first column is left-aligned, the rest right. */
function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) =>
    r
      .map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!)))
      .join('  ')
      .trimEnd(),
  );
}

/** The comparison as lines to print. `baseLabel` and `headLabel` name the runs. */
export function comparisonLines(c: RunComparison, baseLabel: string, headLabel: string): string[] {
  const out = [
    `Comparing ${headLabel} against ${baseLabel}: dataset v${c.datasetVersion}, ${c.sharedCases} shared cases`,
  ];
  if (c.onlyInBase.length > 0) out.push(`Only in ${baseLabel}: ${c.onlyInBase.join(', ')}`);
  if (c.onlyInHead.length > 0) out.push(`Only in ${headLabel}: ${c.onlyInHead.join(', ')}`);
  out.push(
    '',
    ...table([
      ['metric', 'base', 'head', 'change'],
      ...c.metrics.map((m) => [
        m.name,
        formatValue(m.unit, m.base),
        formatValue(m.unit, m.head),
        formatDelta(m.unit, m.delta),
      ]),
    ]),
    '',
    ...table([
      ['category', 'base', 'head', 'change'],
      ...c.categories.map((k) => [
        k.category,
        `${k.base.passed}/${k.base.cases}`,
        `${k.head.passed}/${k.head.cases}`,
        formatDelta('rate', k.delta),
      ]),
    ]),
  );
  out.push('');
  if (c.cases.length === 0) {
    out.push('No case changed.');
  } else {
    out.push('Cases:');
    for (const d of c.cases) {
      out.push(`  ${d.change.padEnd(9)} ${d.caseId}`);
      for (const line of d.details) out.push(`              ${line}`);
    }
  }
  return out;
}
