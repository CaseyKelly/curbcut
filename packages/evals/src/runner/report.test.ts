import type { EvalResult, EvalScores, PatchOutcome } from '@curbcut/core';
import { describe, expect, it } from 'vitest';
import { passed, percentile, totals, type CaseRecord } from './report';

const base = {
  caseId: 'c',
  datasetVersion: 1,
  caseVersion: 1,
  costUsd: 0,
  latencyMs: 0,
  model: 'm',
  promptVersion: 'p',
};
const ok = { resolved: true, buildSafe: true, scoped: true };
const result = (outcome: PatchOutcome, scores: EvalScores = {}): EvalResult => ({
  ...base,
  outcome,
  outcomeCorrect: false,
  scores,
});

describe('passed', () => {
  it('needs (a), (b) and (c) for a fix case', () => {
    expect(passed('fix', result('fix', ok))).toBe(true);
    expect(passed('fix', result('fix', { ...ok, buildSafe: false }))).toBe(false);
    expect(passed('fix', result('fix', { resolved: true, scoped: true }))).toBe(false);
    expect(passed('fix', result('no_change_needed', { scoped: true }))).toBe(false);
  });

  it('accepts no_change_needed or unsure, never a fix, for a no-change case', () => {
    expect(passed('no_change_needed', result('no_change_needed'))).toBe(true);
    expect(passed('no_change_needed', result('unsure'))).toBe(true);
    expect(passed('no_change_needed', result('fix', ok))).toBe(false);
  });

  it('accepts only unsure for an unsure case', () => {
    expect(passed('unsure', result('unsure'))).toBe(true);
    expect(passed('unsure', result('no_change_needed'))).toBe(false);
  });

  it('fails a crashed case', () => {
    expect(passed('no_change_needed', { ...base, outcome: 'error', error: 'boom' })).toBe(false);
  });
});

describe('percentile', () => {
  it('uses nearest rank', () => {
    const ten = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];
    expect(percentile(ten, 50)).toBe(5);
    expect(percentile(ten, 95)).toBe(10);
    expect(percentile([], 95)).toBe(0);
  });
});

describe('totals', () => {
  const record = (
    r: EvalResult,
    pass: boolean,
    expectedOutcome: PatchOutcome = 'fix',
  ): CaseRecord => ({ result: r, pass, expectedOutcome, category: 'forms', notes: [] });

  it('counts passes, build breaks, errors, cost and latency', () => {
    const t = totals([
      record({ ...result('fix', ok), costUsd: 0.01, latencyMs: 100 }, true),
      record(
        { ...result('fix', { ...ok, buildSafe: false }), costUsd: 0.02, latencyMs: 300 },
        false,
      ),
      record({ ...base, outcome: 'error', error: 'x', latencyMs: 200 }, false, 'no_change_needed'),
    ]);
    expect(t).toMatchObject({
      cases: 3,
      passed: 1,
      buildBreaks: 1,
      errors: 1,
      byExpected: { fix: { cases: 2, passed: 1 }, no_change_needed: { cases: 1, passed: 0 } },
      byCategory: { forms: { cases: 3, passed: 1 } },
      latencyMs: { p50: 200, p95: 300, max: 300 },
    });
    expect(t.costUsd).toBeCloseTo(0.03);
    expect(t.passRate).toBeCloseTo(1 / 3);
  });
});
