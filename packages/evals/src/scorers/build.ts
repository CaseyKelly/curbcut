// Scorer (b): the patched file still type-checks, passes ESLint with
// jsx-a11y, and passes the case's own test.tsx if it has one.
//
// Inputs type-check by construction (CI checks the dataset), so any type
// error is the patch's. Inputs are full of jsx-a11y errors on purpose, so
// lint only fails on rules that report more errors than on the input. The
// count is per rule, so a patch that fixes one error and adds another of the
// same rule nets zero and passes.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint, type Linter } from 'eslint';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import ts from 'typescript';
import type { Scored } from './scoped.ts';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const datasetTsconfig = fileURLToPath(new URL('../../dataset/tsconfig.json', import.meta.url));

export type BuildCheck = {
  key: string;
  filePath: string;
  input: string;
  patched: string;
  /** The case's test.tsx, if it has one. */
  testPath?: string;
  /** The axe rule the patch is fixing, which can excuse a lint rule. */
  targetRule?: string;
};

/**
 * Lint rules a patch may break when fixing an axe rule, because axe's own fix
 * is what the lint rule forbids. A scrollable region with nothing focusable in
 * it needs `tabIndex={0}`, which is correct but would otherwise count as a
 * merge-blocking build break. Only these targets are excused (#14).
 */
const LINT_EXEMPTIONS: Record<string, string[]> = {
  'scrollable-region-focusable': ['jsx-a11y/no-noninteractive-tabindex'],
};

/** Type errors per file, with the dataset's compiler options, in one program. */
function typecheck(files: string[]): Map<string, string[]> {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    datasetTsconfig,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      },
    },
  );
  if (!parsed) throw new Error(`could not read ${datasetTsconfig}`);
  const program = ts.createProgram(files, { ...parsed.options, noEmit: true });
  const out = new Map<string, string[]>(files.map((f) => [f, []]));
  for (const d of ts.getPreEmitDiagnostics(program)) {
    if (!d.file) continue;
    const list = out.get(d.file.fileName);
    if (!list) continue;
    const { line } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
    list.push(`line ${line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  }
  return out;
}

// The repo's .tsx rules without type-aware linting: tsc already covers types,
// and a type-aware program per scratch file would be slow.
const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: true,
  overrideConfig: [
    ...(tseslint.configs.recommended as Linter.Config[]),
    { files: ['**/*.tsx'], ...jsxA11y.flatConfigs.strict },
    {
      files: ['**/*.tsx'],
      plugins: { 'react-hooks': reactHooks },
      rules: reactHooks.configs.recommended.rules,
    } as Linter.Config,
  ],
});

/** ESLint error counts by rule; a parse error counts as rule `fatal`. */
async function lintErrors(text: string, filePath: string): Promise<Map<string, number>> {
  const [result] = await eslint.lintText(text, { filePath });
  const counts = new Map<string, number>();
  for (const m of result?.messages ?? []) {
    if (m.severity !== 2) continue;
    const rule = m.fatal ? 'fatal' : (m.ruleId ?? 'unknown');
    counts.set(rule, (counts.get(rule) ?? 0) + 1);
  }
  return counts;
}

/** Runs the case's test.tsx against the patched file with Vitest in jsdom. */
function runCaseTest(dir: string, check: BuildCheck & { testPath: string }): string[] {
  // The test imports the component as ./input/<filePath>, as it does in the dataset.
  const caseDir = join(dir, 'test');
  mkdirSync(dirname(join(caseDir, 'input', check.filePath)), { recursive: true });
  writeFileSync(join(caseDir, 'input', check.filePath), check.patched);
  copyFileSync(check.testPath, join(caseDir, 'case.test.tsx'));
  writeFileSync(
    join(caseDir, 'vitest.config.mjs'),
    `export default { test: { environment: 'jsdom', include: ['case.test.tsx'] } };\n`,
  );
  const vitest = join(repoRoot, 'node_modules', '.bin', 'vitest');
  const run = spawnSync(vitest, ['run', '--root', caseDir, '--config', 'vitest.config.mjs'], {
    cwd: caseDir,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (run.status === 0) return [];
  const output = `${run.stdout}${run.stderr}`.trim().split('\n').slice(-15).join('\n');
  return [`buildSafe: test.tsx failed\n${output}`];
}

/** Scores every patched file. `dir` is scratch space under the repo, so react resolves. */
export async function scoreBuilds(dir: string, checks: BuildCheck[]): Promise<Map<string, Scored>> {
  const paths = new Map<string, string>();
  for (const c of checks) {
    const path = join(dir, c.key, c.filePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, c.patched);
    paths.set(c.key, path);
  }
  const typeErrors =
    checks.length > 0 ? typecheck([...paths.values()]) : new Map<string, string[]>();

  const out = new Map<string, Scored>();
  for (const c of checks) {
    const path = paths.get(c.key)!;
    const notes = (typeErrors.get(path) ?? []).map((e) => `buildSafe: tsc ${e}`);

    const lintPath = relative(repoRoot, path);
    const [before, after] = await Promise.all([
      lintErrors(c.input, lintPath),
      lintErrors(c.patched, lintPath),
    ]);
    const exempt = (c.targetRule && LINT_EXEMPTIONS[c.targetRule]) || [];
    for (const [rule, n] of after) {
      if (exempt.includes(rule)) continue;
      const was = before.get(rule) ?? 0;
      if (n > was) notes.push(`buildSafe: ESLint ${rule} (${was} -> ${n} errors)`);
    }

    if (c.testPath) notes.push(...runCaseTest(join(dir, c.key), { ...c, testPath: c.testPath }));
    out.set(c.key, { pass: notes.length === 0, notes });
  }
  return out;
}
