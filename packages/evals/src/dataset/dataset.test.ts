import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CATEGORY_TARGETS, countBy, validateDataset } from './dataset';

const INPUT = `export default function Tile() {
  return (
    <div>
      <img src="/fern.jpg" />
    </div>
  );
}
`;
const FIXED = INPUT.replace('<img src="/fern.jpg" />', '<img src="/fern.jpg" alt="Fern" />');

const issue = {
  ruleId: 'image-alt',
  impact: 'critical',
  help: 'Images must have alternative text',
  helpUrl: 'https://dequeuniversity.com/rules/axe/4.14/image-alt',
  wcag: ['1.1.1'],
  pageUrl: 'http://localhost/',
  selector: 'img',
  html: '<img src="/fern.jpg">',
  fingerprint: 'image-alt:img',
};

let root: string;
const write = (path: string, content: string) => {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
};
const writeCase = (id: string, overrides: Record<string, unknown> = {}) =>
  write(
    `cases/${id}/case.json`,
    JSON.stringify({
      id,
      version: 1,
      framework: 'react',
      description: 'An image with no alt.',
      category: 'text-alternatives',
      filePath: 'Tile.tsx',
      issue,
      expectedOutcome: 'fix',
      allowedLines: [{ start: 4, end: 4 }],
      ...overrides,
    }),
  );
const writeManifest = (cases: string[]) =>
  write('manifest.json', JSON.stringify({ datasetVersion: 1, cases }));
const errors = () => validateDataset(root).errors;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'evals-dataset-'));
  writeManifest(['image-alt']);
  writeCase('image-alt');
  write('cases/image-alt/input/Tile.tsx', INPUT);
  write('cases/image-alt/expected/Tile.tsx', FIXED);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('validateDataset', () => {
  it('passes a valid dataset and loads its cases', () => {
    const report = validateDataset(root);
    expect(report.errors).toEqual([]);
    expect(report.manifest?.datasetVersion).toBe(1);
    expect(report.cases.map((c) => c.case.id)).toEqual(['image-alt']);
  });

  it('passes a no-change case with no expected/', () => {
    writeManifest(['image-alt', 'already-fine']);
    writeCase('already-fine', {
      category: 'no-change',
      expectedOutcome: 'no_change_needed',
      allowedLines: undefined,
    });
    write('cases/already-fine/input/Tile.tsx', FIXED);
    expect(errors()).toEqual([]);
  });

  it('rejects a category outside the plan', () => {
    writeCase('image-alt', { category: 'images' });
    expect(errors()).toEqual(['image-alt: unknown category "images"']);
  });

  it.each([
    ['no-change', 'fix'],
    ['needs-human', 'fix'],
    ['text-alternatives', 'no_change_needed'],
    ['text-alternatives', 'unsure'],
    ['needs-human', 'no_change_needed'],
  ])('rejects category %s on a case expecting %s', (category, expectedOutcome) => {
    const isFix = expectedOutcome === 'fix';
    if (!isFix) rmSync(join(root, 'cases/image-alt/expected'), { recursive: true });
    writeCase('image-alt', {
      category,
      expectedOutcome,
      allowedLines: isFix ? [{ start: 4, end: 4 }] : undefined,
    });
    expect(errors()).toEqual([
      `image-alt: category "${category}" does not fit expectedOutcome "${expectedOutcome}"`,
    ]);
  });

  it('rejects a case.json that does not match EvalCase', () => {
    writeCase('image-alt', { allowedLines: undefined });
    expect(errors()).toEqual([expect.stringContaining('does not match EvalCase')]);
  });

  it('rejects invalid JSON', () => {
    write('cases/image-alt/case.json', '{');
    expect(errors()).toEqual([expect.stringContaining('not valid JSON')]);
  });

  it('rejects an id that does not match the folder', () => {
    writeCase('image-alt', { id: 'other-id' });
    expect(errors()).toEqual([expect.stringContaining('does not match its folder')]);
  });

  it('rejects a missing input file', () => {
    writeCase('image-alt', { filePath: 'Missing.tsx' });
    expect(errors()).toEqual(['image-alt: input/Missing.tsx does not exist']);
  });

  it('rejects allowedLines past the end of the file', () => {
    writeCase('image-alt', { allowedLines: [{ start: 4, end: 40 }] });
    expect(errors()).toEqual([expect.stringContaining('runs past the end of Tile.tsx (7 lines)')]);
  });

  it('leaves repo-mode sourceFiles to the repo-mode cases', () => {
    writeCase('image-alt', { sourceFiles: ['src/components/Tile.tsx'] });
    expect(errors()).toEqual([]);
  });

  it('rejects extra files in input/', () => {
    write('cases/image-alt/input/Old.tsx', INPUT);
    write('cases/image-alt/input/notes/answer.md', 'alt="Fern"');
    expect(errors()).toEqual([
      'image-alt: input/ must hold only Tile.tsx, also found: Old.tsx, notes/answer.md',
    ]);
  });

  it('reports a file where a folder belongs, and the reverse, without crashing', () => {
    rmSync(join(root, 'cases/image-alt/expected'), { recursive: true });
    write('cases/image-alt/expected', FIXED);
    write('cases/image-alt/test.tsx/index.tsx', '');
    expect(errors()).toEqual([
      'image-alt: expected must be a folder',
      'image-alt: test.tsx must be a file',
    ]);
  });

  it('rejects unexpected entries in a case folder', () => {
    write('cases/image-alt/notes.md', 'hi');
    expect(errors()).toEqual(['image-alt: unexpected entry "notes.md"']);
  });

  it('rejects expected/ on a case that is not a fix', () => {
    writeCase('image-alt', {
      category: 'needs-human',
      expectedOutcome: 'unsure',
      allowedLines: undefined,
    });
    expect(errors()).toEqual([expect.stringContaining('expected/ is only allowed')]);
  });

  it('rejects expected/ holding other files', () => {
    write('cases/image-alt/expected/Other.tsx', FIXED);
    expect(errors()).toEqual([
      'image-alt: expected/ must hold only Tile.tsx, found: Other.tsx, Tile.tsx',
    ]);
  });

  it('rejects a reference fix identical to the input, line endings aside', () => {
    write('cases/image-alt/expected/Tile.tsx', INPUT.replaceAll('\n', '\r\n'));
    expect(errors()).toEqual(['image-alt: expected/Tile.tsx is the same as the input']);
  });

  it('rejects a reference fix outside allowedLines', () => {
    write('cases/image-alt/expected/Tile.tsx', FIXED.replace('<div>', '<div className="tile">'));
    expect(errors()).toEqual(['image-alt: expected/Tile.tsx changes line 3, outside allowedLines']);
  });

  it('allows a reference fix that adds lines next to an allowed line', () => {
    write(
      'cases/image-alt/expected/Tile.tsx',
      INPUT.replace('      <img', '      <p>Fern</p>\n      <img'),
    );
    expect(errors()).toEqual([]);
  });

  it('rejects a manifest that does not match the case folders', () => {
    writeManifest(['image-alt', 'gone']);
    write('cases/unlisted/input/Tile.tsx', INPUT);
    writeCase('unlisted');
    expect(errors()).toEqual([
      'manifest.json: lists "gone", which has no folder in cases/',
      'manifest.json: does not list cases/unlisted',
    ]);
  });

  it('rejects a manifest with no version', () => {
    write('manifest.json', JSON.stringify({ cases: ['image-alt'] }));
    expect(errors()).toEqual([expect.stringContaining('at datasetVersion')]);
  });

  it('rejects a manifest that repeats a case', () => {
    writeManifest(['image-alt', 'image-alt']);
    expect(errors()).toEqual([expect.stringContaining('cases must not repeat')]);
  });
});

describe('the real dataset', () => {
  const real = resolve(import.meta.dirname, '../../dataset');

  it('is valid', () => {
    const report = validateDataset(real);
    expect(report.errors).toEqual([]);
    expect(report.cases).toHaveLength(report.manifest!.cases.length);
  });

  describe('against the plan (#14)', () => {
    const { manifest, cases } = validateDataset(real);

    it('meets every category target, with 50 or more cases', () => {
      expect(cases.length).toBeGreaterThanOrEqual(50);
      const counts = new Map(countBy(cases, 'category'));
      for (const [category, target] of Object.entries(CATEGORY_TARGETS)) {
        expect(counts.get(category) ?? 0, category).toBeGreaterThanOrEqual(target);
      }
    });

    it('tags about 15 cases smoke, in every category', () => {
      const smoke = cases.filter((c) => c.case.tags.includes('smoke'));
      expect(smoke.length).toBeGreaterThanOrEqual(13);
      expect(smoke.length).toBeLessThanOrEqual(17);
      expect(new Set(smoke.map((c) => c.case.category))).toEqual(
        new Set(Object.keys(CATEGORY_TARGETS)),
      );
    });

    it('has a changelog entry for the current dataset version', () => {
      const changelog = readFileSync(join(real, 'CHANGELOG.md'), 'utf8');
      expect(changelog).toContain(`## v${manifest!.datasetVersion}\n`);
    });
  });
});
