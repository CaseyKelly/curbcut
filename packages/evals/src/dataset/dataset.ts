// Loads and validates the eval dataset in ../../dataset. Each case is a
// folder under cases/<id>/ holding case.json (an EvalCase), input/ with the
// broken file, an optional expected/ with a reference fix, and an optional
// test.tsx. manifest.json lists every case and the dataset version.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EvalCase, Slug } from '@curbcut/core';
import { z } from 'zod';
import { changesOutside, sameLines, splitLines } from './lines.ts';

export const DatasetManifest = z
  .strictObject({
    /** Bump when cases are added, removed, or changed, so results stay comparable (#14, #16). */
    datasetVersion: z.int().positive(),
    cases: z.array(Slug).min(1),
  })
  .refine((m) => new Set(m.cases).size === m.cases.length, {
    message: 'cases must not repeat',
    path: ['cases'],
  });
export type DatasetManifest = z.infer<typeof DatasetManifest>;

/**
 * The plan's nine categories and the v1 case count for each. The PR comment
 * reports by category (#17), so a case can't invent its own (#14).
 */
export const CATEGORY_TARGETS = {
  'text-alternatives': 8,
  'form-labels': 7,
  aria: 7,
  keyboard: 6,
  'no-change': 6,
  contrast: 5,
  structure: 5,
  names: 4,
  'needs-human': 2,
} as const;

/** Two categories are outcomes rather than topics, so the outcome decides them. */
const OUTCOME_CATEGORIES: Partial<Record<EvalCase['expectedOutcome'], string>> = {
  no_change_needed: 'no-change',
  unsure: 'needs-human',
};

/** What a case folder may hold, and whether each entry is a file or a folder. */
const CASE_ENTRIES: Record<string, 'file' | 'folder'> = {
  'case.json': 'file',
  input: 'folder',
  expected: 'folder',
  'test.tsx': 'file',
};

export type LoadedCase = { dir: string; case: EvalCase };
export type DatasetReport = {
  manifest?: DatasetManifest;
  cases: LoadedCase[];
  /** Each error starts with the case id, or `manifest.json`. */
  errors: string[];
};

/** Every file under `dir`, as `/`-separated paths relative to it. */
function listFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? listFiles(join(dir, e.name), `${prefix}${e.name}/`) : [prefix + e.name],
    )
    .sort();
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

function validateCase(dir: string, folder: string): { case?: EvalCase; errors: string[] } {
  const errors: string[] = [];
  const fail = (msg: string) => errors.push(`${folder}: ${msg}`);

  let badEntry = false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const kind = Object.hasOwn(CASE_ENTRIES, entry.name) ? CASE_ENTRIES[entry.name] : undefined;
    if (!kind) {
      fail(`unexpected entry "${entry.name}"`);
    } else if (kind === 'folder' ? !entry.isDirectory() : !entry.isFile()) {
      fail(`${entry.name} must be a ${kind}`);
      badEntry = true;
    }
  }
  if (badEntry) return { errors };
  const casePath = join(dir, 'case.json');
  if (!existsSync(casePath)) {
    fail('missing case.json');
    return { errors };
  }
  let raw: unknown;
  try {
    raw = readJson(casePath);
  } catch (e) {
    fail(`case.json is not valid JSON: ${(e as Error).message}`);
    return { errors };
  }
  const parsed = EvalCase.safeParse(raw);
  if (!parsed.success) {
    fail(`case.json does not match EvalCase:\n${z.prettifyError(parsed.error)}`);
    return { errors };
  }
  const c = parsed.data;
  if (c.id !== folder) fail(`id "${c.id}" does not match its folder`);
  if (!Object.hasOwn(CATEGORY_TARGETS, c.category)) {
    fail(`unknown category "${c.category}"`);
  } else {
    const wanted = OUTCOME_CATEGORIES[c.expectedOutcome];
    const isOutcomeCategory = Object.values(OUTCOME_CATEGORIES).includes(c.category);
    if (wanted ? c.category !== wanted : isOutcomeCategory) {
      fail(`category "${c.category}" does not fit expectedOutcome "${c.expectedOutcome}"`);
    }
  }

  // input/ holds exactly the file the agent sees: anything else would be
  // extra context for the agent, or even the answer. (sourceFiles are
  // repo-mode paths into the sample site, checked by the repo-mode cases, #25.)
  const inputDir = join(dir, 'input');
  const inputFiles = existsSync(inputDir) ? listFiles(inputDir) : [];
  if (!inputFiles.includes(c.filePath)) {
    fail(`input/${c.filePath} does not exist`);
    return { case: c, errors };
  }
  const extra = inputFiles.filter((f) => f !== c.filePath);
  if (extra.length > 0)
    fail(`input/ must hold only ${c.filePath}, also found: ${extra.join(', ')}`);
  const input = readFileSync(join(inputDir, c.filePath), 'utf8');
  const lineCount = splitLines(input).length;
  for (const r of c.allowedLines ?? []) {
    if (r.end > lineCount) {
      fail(
        `allowedLines ${r.start}-${r.end} runs past the end of ${c.filePath} (${lineCount} lines)`,
      );
    }
  }

  const expectedDir = join(dir, 'expected');
  if (existsSync(expectedDir)) {
    if (c.expectedOutcome !== 'fix') {
      fail(`expected/ is only allowed when expectedOutcome is "fix"`);
    } else {
      const files = listFiles(expectedDir);
      if (files.length !== 1 || files[0] !== c.filePath) {
        fail(`expected/ must hold only ${c.filePath}, found: ${files.join(', ') || 'nothing'}`);
      } else {
        const expected = readFileSync(join(expectedDir, c.filePath), 'utf8');
        if (sameLines(input, expected)) {
          fail(`expected/${c.filePath} is the same as the input`);
        }
        for (const out of changesOutside(input, expected, c.allowedLines ?? [])) {
          fail(`expected/${c.filePath} ${out}, outside allowedLines`);
        }
      }
    }
  }
  return { case: c, errors };
}

export function validateDataset(root: string): DatasetReport {
  const errors: string[] = [];
  const cases: LoadedCase[] = [];

  let manifest: DatasetManifest | undefined;
  try {
    const parsed = DatasetManifest.safeParse(readJson(join(root, 'manifest.json')));
    if (parsed.success) manifest = parsed.data;
    else errors.push(`manifest.json: ${z.prettifyError(parsed.error)}`);
  } catch (e) {
    errors.push(`manifest.json: ${(e as Error).message}`);
  }

  const casesDir = join(root, 'cases');
  const folders = existsSync(casesDir)
    ? readdirSync(casesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    : [];
  for (const folder of folders) {
    const result = validateCase(join(casesDir, folder), folder);
    errors.push(...result.errors);
    if (result.case) cases.push({ dir: join(casesDir, folder), case: result.case });
  }

  if (manifest) {
    const listed = new Set(manifest.cases);
    const present = new Set(folders);
    for (const id of manifest.cases.filter((id) => !present.has(id))) {
      errors.push(`manifest.json: lists "${id}", which has no folder in cases/`);
    }
    for (const id of folders.filter((id) => !listed.has(id))) {
      errors.push(`manifest.json: does not list cases/${id}`);
    }
  }
  return { manifest, cases, errors };
}

/** Case counts by category and by expected outcome, for the summary. */
export function countBy(cases: LoadedCase[], key: 'category' | 'expectedOutcome') {
  const counts = new Map<string, number>();
  for (const { case: c } of cases) counts.set(c[key], (counts.get(c[key]) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
}
