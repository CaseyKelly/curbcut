import { describe, expect, it } from 'vitest';
import { compareRuns, comparisonLines } from './compare';
import { ok, record, report } from './fixtures';

describe('compareRuns', () => {
  it('reports per-metric deltas, with rates in points', () => {
    const base = report([
      record('a'),
      record('b'),
      record('c', { expected: 'no_change_needed' }),
      record('d', { expected: 'no_change_needed' }),
    ]);
    const head = report([
      record('a'),
      record('b', { scores: { ...ok, buildSafe: false }, pass: false }),
      record('c', { expected: 'no_change_needed' }),
      record('d', { expected: 'no_change_needed', outcome: 'fix', pass: false }),
    ]);
    const c = compareRuns(base, head);
    const metric = (name: string) => c.metrics.find((m) => m.name === name)!;
    expect(metric('pass rate')).toMatchObject({ base: 1, head: 0.5, delta: -50 });
    expect(metric('no-change accuracy')).toMatchObject({ base: 1, head: 0.5, delta: -50 });
    expect(metric('build breaks')).toMatchObject({ base: 0, head: 1, delta: 1 });
  });

  it('lists changed cases, regressions first', () => {
    const base = report([
      record('a', { scores: { ...ok, resolved: false }, pass: false }),
      record('b'),
      record('c'),
      record('d'),
    ]);
    const head = report([
      record('a'),
      record('b', { outcome: 'unsure', pass: false }),
      record('c', { costUsd: 0.5 }),
      record('d', {
        scores: { ...ok, judge: { score: 4, reason: 'r', model: 'j', promptVersion: 'v' } },
      }),
    ]);
    expect(compareRuns(base, head).cases).toEqual([
      {
        caseId: 'b',
        change: 'regressed',
        details: ['outcome: fix -> unsure', '(a) resolved: true -> -', '(b) build safe: true -> -'],
      },
      { caseId: 'a', change: 'fixed', details: ['(a) resolved: false -> true'] },
      { caseId: 'd', change: 'changed', details: ['(d) judge: - -> 4'] },
    ]);
  });

  it('compares only cases both runs have at the same version', () => {
    const base = report([record('a'), record('b'), record('c')]);
    const head = report([
      record('a', { pass: false, scores: { ...ok, scoped: false } }),
      record('b', { caseVersion: 2 }),
      record('d'),
    ]);
    const c = compareRuns(base, head);
    expect(c.sharedCases).toBe(1);
    expect(c.onlyInBase).toEqual(['b', 'c']);
    expect(c.onlyInHead).toEqual(['b', 'd']);
    expect(c.metrics[0]).toMatchObject({ name: 'pass rate', base: 1, head: 0 });
  });

  it('breaks pass rates out by category', () => {
    const base = report([record('a', { category: 'forms' }), record('b', { category: 'images' })]);
    const head = report([
      record('a', { category: 'forms', pass: false }),
      record('b', { category: 'images' }),
    ]);
    expect(compareRuns(base, head).categories).toEqual([
      {
        category: 'forms',
        base: { cases: 1, passed: 1 },
        head: { cases: 1, passed: 0 },
        delta: -100,
      },
      {
        category: 'images',
        base: { cases: 1, passed: 1 },
        head: { cases: 1, passed: 1 },
        delta: 0,
      },
    ]);
  });

  it('refuses runs on different dataset versions', () => {
    expect(() => compareRuns(report([]), report([], { datasetVersion: 2 }))).toThrow(
      /dataset v1 with v2/,
    );
  });
});

describe('comparisonLines', () => {
  it('prints metrics, categories and case changes', () => {
    const base = report([record('a'), record('b')]);
    const head = report([record('a'), record('b', { pass: false, outcome: 'unsure' })]);
    const text = comparisonLines(compareRuns(base, head), 'main', 'this PR').join('\n');
    expect(text).toContain('Comparing this PR against main: dataset v1, 2 shared cases');
    expect(text).toMatch(/pass rate\s+100\.0%\s+50\.0%\s+-50\.0 pts/);
    expect(text).toMatch(/images\s+2\/2\s+1\/2\s+-50\.0 pts/);
    expect(text).toMatch(/regressed\s+b\n\s+outcome: fix -> unsure/);
  });

  it('says so when nothing changed', () => {
    const r = report([record('a')]);
    expect(comparisonLines(compareRuns(r, r), 'a', 'b')).toContain('No case changed.');
  });
});
