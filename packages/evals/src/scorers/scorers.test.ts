// Scorers (a), (b) and (c), without the browser: scanPages needs Chromium and
// is covered by `npm run evals -- --reference`.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvalCase } from '@curbcut/core';
import { afterAll, describe, expect, it } from 'vitest';
import { scoreBuilds } from './build';
import { scoreResolved } from './resolved';
import { scoreScoped } from './scoped';

const INPUT = `export default function Tile() {
  return (
    <div>
      <img src="/fern.jpg" />
    </div>
  );
}
`;
const FIXED = INPUT.replace('<img src="/fern.jpg" />', '<img src="/fern.jpg" alt="Fern" />');

describe('scoreScoped', () => {
  const fixCase = { allowedLines: [{ start: 4, end: 4 }] } as EvalCase;

  it('passes a change inside allowedLines', () => {
    expect(scoreScoped(fixCase, INPUT, FIXED)).toEqual({ pass: true, notes: [] });
  });

  it('fails a change outside allowedLines', () => {
    const wider = FIXED.replace('<div>', '<section>');
    expect(scoreScoped(fixCase, INPUT, wider)).toEqual({
      pass: false,
      notes: ['scoped: changes line 3, outside allowedLines'],
    });
  });

  it('fails any change when the case allows none', () => {
    expect(scoreScoped({} as EvalCase, INPUT, FIXED).pass).toBe(false);
  });
});

describe('scoreResolved', () => {
  const scan = (counts: Record<string, number>) => ({ counts: new Map(Object.entries(counts)) });

  it('passes when the target rule is gone and nothing is new', () => {
    expect(scoreResolved('image-alt', 'fix', scan({ 'image-alt': 1 }), scan({}))).toEqual({
      pass: true,
      notes: [],
    });
  });

  it('fails when the target is still reported', () => {
    expect(
      scoreResolved('image-alt', 'fix', scan({ 'image-alt': 1 }), scan({ 'image-alt': 1 })).notes,
    ).toEqual(['resolved: image-alt is still reported']);
  });

  it('fails when only some of the target nodes are fixed', () => {
    expect(
      scoreResolved('image-alt', 'fix', scan({ 'image-alt': 2 }), scan({ 'image-alt': 1 })).notes,
    ).toEqual(['resolved: image-alt is still reported']);
  });

  it.each(['fix', 'unsure'] as const)(
    'fails a %s case whose input no longer reproduces the rule',
    (expected) => {
      expect(scoreResolved('image-alt', expected, scan({}), scan({}))).toEqual({
        pass: false,
        notes: ['resolved: input no longer reproduces image-alt'],
      });
    },
  );

  it('passes a no-change case whose input has no target', () => {
    expect(scoreResolved('image-alt', 'no_change_needed', scan({}), scan({})).pass).toBe(true);
  });

  it('fails a new violation, even on a no-change case with no target', () => {
    expect(
      scoreResolved('image-alt', 'no_change_needed', scan({}), scan({ label: 1 })).notes,
    ).toEqual(['resolved: new label violation (0 -> 1 nodes)']);
  });

  it('fails when a page could not be rendered', () => {
    const r = scoreResolved('image-alt', 'fix', scan({ 'image-alt': 1 }), {
      error: 'render failed: boom',
    });
    expect(r).toEqual({ pass: false, notes: ['resolved: patched file render failed: boom'] });
  });
});

describe('scoreBuilds', () => {
  // Under the package, so react's types resolve as they do in a real run.
  const parent = fileURLToPath(new URL('../../.eval-tmp/', import.meta.url));
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('flags type errors and new lint errors, not the lint errors the input already had', async () => {
    const check = (key: string, patched: string) => ({
      key,
      filePath: 'Tile.tsx',
      input: INPUT,
      patched,
    });
    const scores = await scoreBuilds(dir, [
      check('clean', FIXED),
      check('unchanged', INPUT),
      check(
        'types',
        FIXED.replace('return (', 'const n: number = "x";\n  console.log(n);\n  return ('),
      ),
      check('lint', FIXED.replace('<div>', '<div onClick={() => {}}>')),
    ]);
    expect(scores.get('clean')).toEqual({ pass: true, notes: [] });
    expect(scores.get('unchanged')).toEqual({ pass: true, notes: [] });
    expect(scores.get('types')?.notes).toEqual([
      "buildSafe: tsc line 2: Type 'string' is not assignable to type 'number'.",
    ]);
    expect(scores.get('lint')?.notes).toEqual([
      'buildSafe: ESLint jsx-a11y/click-events-have-key-events (0 -> 1 errors)',
      'buildSafe: ESLint jsx-a11y/no-static-element-interactions (0 -> 1 errors)',
    ]);
  }, 30_000);
});
