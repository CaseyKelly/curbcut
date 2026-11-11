// Small run reports for the store and compare tests.
import type { EvalScores, PatchOutcome } from '@curbcut/core';
import { totals, type CaseRecord, type RunReport } from '../runner/report.ts';

export const ok: EvalScores = { resolved: true, buildSafe: true, scoped: true };

export function record(
  caseId: string,
  opts: {
    expected?: PatchOutcome;
    outcome?: PatchOutcome | 'error';
    scores?: EvalScores;
    pass?: boolean;
    category?: string;
    caseVersion?: number;
    costUsd?: number;
    latencyMs?: number;
  } = {},
): CaseRecord {
  const expected = opts.expected ?? 'fix';
  const outcome = opts.outcome ?? expected;
  const base = {
    caseId,
    datasetVersion: 1,
    caseVersion: opts.caseVersion ?? 1,
    costUsd: opts.costUsd ?? 0.01,
    latencyMs: opts.latencyMs ?? 1000,
    model: 'claude-test',
    promptVersion: 'fix-v1',
  };
  return {
    result:
      outcome === 'error'
        ? { ...base, outcome, error: 'boom' }
        : {
            ...base,
            outcome,
            outcomeCorrect: outcome === expected,
            scores: opts.scores ?? (outcome === 'fix' ? ok : { scoped: true }),
          },
    expectedOutcome: expected,
    category: opts.category ?? 'images',
    pass: opts.pass ?? true,
    notes: [],
  };
}

export function report(cases: CaseRecord[], overrides: Partial<RunReport> = {}): RunReport {
  return {
    createdAt: '2026-11-01T12:00:00.000Z',
    mode: 'live',
    datasetVersion: 1,
    model: 'claude-test',
    promptVersion: 'fix-v1',
    axeVersion: '4.11.0',
    totals: totals(cases),
    cases,
    ...overrides,
  };
}
