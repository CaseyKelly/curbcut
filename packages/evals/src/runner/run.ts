// Runs a fixer over the eval dataset and scores each case (#13):
// (a) resolved, (b) build safe, (c) scoped, (e) cost and latency. Prints a
// summary table and writes a JSON report.
//
//   npm run evals -- --reference          harness self-check: every case should pass
//   npm run evals -- --rescore <report>   re-score a saved run for free
//   npm run evals -- --case <id> ...      only these cases
//   npm run evals -- --out <path>         where to write the report
//
// Without --reference or --rescore it runs the live fixer, which needs
// proposeFix from @curbcut/agent (#9). Needs Chromium:
// `npx playwright install chromium`.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PatchProposal, type EvalResult, type EvalScores } from '@curbcut/core';
import { z } from 'zod';
import { validateDataset, type LoadedCase } from '../dataset/dataset.ts';
import { scoreBuilds, type BuildCheck } from '../scorers/build.ts';
import { scanPages, scoreResolved, type Page } from '../scorers/resolved.ts';
import { scoreScoped } from '../scorers/scoped.ts';
import { referenceFixer, rescoreFixer, type Fixer } from './fixers.ts';
import { applyDiff } from './patch.ts';
import {
  RunReport,
  passed,
  summaryLines,
  totals,
  type CaseRecord,
  type RunMode,
} from './report.ts';

const evalsRoot = fileURLToPath(new URL('../../', import.meta.url));
// npm runs workspace scripts from the package; paths on the command line are
// relative to where it was run.
const cwd = process.env.INIT_CWD ?? process.cwd();
const { values } = parseArgs({
  options: {
    reference: { type: 'boolean', default: false },
    rescore: { type: 'string' },
    case: { type: 'string', multiple: true },
    out: { type: 'string' },
  },
});

let mode: RunMode;
let fixer: Fixer;
if (values.reference && values.rescore) {
  console.error('Use --reference or --rescore, not both.');
  process.exit(2);
} else if (values.reference) {
  mode = 'reference';
  fixer = referenceFixer;
} else if (values.rescore) {
  mode = 'rescore';
  try {
    fixer = rescoreFixer(resolve(cwd, values.rescore));
  } catch (e) {
    console.error(`Can't rescore ${values.rescore}: ${(e as Error).message}`);
    process.exit(2);
  }
} else {
  console.error(
    'The live fixer needs proposeFix from @curbcut/agent (#9), which has not landed yet.\n' +
      'Use --reference to check the harness, or --rescore <report.json>.',
  );
  process.exit(2);
}

const { manifest, cases: allCases, errors } = validateDataset(join(evalsRoot, 'dataset'));
if (!manifest || errors.length > 0) {
  console.error(`The dataset is invalid; run npm run evals:validate.\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
const datasetVersion = manifest.datasetVersion;
const unknown = (values.case ?? []).filter((id) => !allCases.some((c) => c.case.id === id));
if (unknown.length > 0) {
  console.error(`Unknown case(s): ${unknown.join(', ')}`);
  process.exit(2);
}
const cases = values.case ? allCases.filter((c) => values.case!.includes(c.case.id)) : allCases;

/** A case on its way through the scorers. */
type Work = {
  loaded: LoadedCase;
  input: string;
  costUsd: number;
  latencyMs: number;
  notes: string[];
  proposal?: PatchProposal;
  error?: string;
  /** Set when the proposal is a fix whose diff applied. */
  patched?: string;
  scores: EvalScores;
};

// 1. Propose. Cases run one at a time so latency isn't skewed by contention.
const work: Work[] = [];
for (const loaded of cases) {
  const { case: c, dir } = loaded;
  const input = readFileSync(join(dir, 'input', c.filePath), 'utf8');
  const w: Work = { loaded, input, costUsd: 0, latencyMs: 0, notes: [], scores: {} };
  const started = performance.now();
  try {
    const r = await fixer.propose(c, input, dir, datasetVersion);
    w.costUsd = r.costUsd;
    w.latencyMs = r.latencyMs ?? Math.round(performance.now() - started);
    if ('error' in r) {
      w.error = r.error;
    } else {
      const parsed = PatchProposal.safeParse(r.proposal);
      if (parsed.success) w.proposal = parsed.data;
      else w.error = `proposal does not match PatchProposal:\n${z.prettifyError(parsed.error)}`;
    }
  } catch (e) {
    w.latencyMs = Math.round(performance.now() - started);
    w.error = (e as Error).message || String(e);
  }
  work.push(w);
}

// 2. Apply fixes and score (c). A diff for the wrong file, or one that
// doesn't apply, fails (a), (b) and (c): there's no patched file to check.
for (const w of work) {
  const p = w.proposal;
  if (!p) continue;
  if (p.outcome !== 'fix') {
    w.scores.scoped = true;
    continue;
  }
  const c = w.loaded.case;
  const applied =
    p.filePath === c.filePath
      ? applyDiff(w.input, p.diff, c.filePath)
      : { ok: false as const, error: `diff patches ${p.filePath}, not ${c.filePath}` };
  if (!applied.ok) {
    w.scores = { resolved: false, buildSafe: false, scoped: false };
    w.notes.push(applied.error);
    continue;
  }
  w.patched = applied.text;
  const scoped = scoreScoped(c, w.input, applied.text);
  w.scores.scoped = scoped.pass;
  w.notes.push(...scoped.notes);
}

// 3. Score (b) and (a) on the patched files, in scratch space under the
// package so the harness resolves react from the workspace.
const patchedWork = work.filter((w) => w.patched !== undefined);
const scratchParent = join(evalsRoot, '.eval-tmp');
mkdirSync(scratchParent, { recursive: true });
const scratch = mkdtempSync(join(scratchParent, 'run-'));
let axeVersion: string | undefined;
try {
  const checks: BuildCheck[] = patchedWork.map((w) => {
    const c = w.loaded.case;
    const testPath = join(w.loaded.dir, 'test.tsx');
    return {
      key: c.id,
      filePath: c.filePath,
      input: w.input,
      patched: w.patched!,
      testPath: existsSync(testPath) ? testPath : undefined,
      targetRule: c.issue.ruleId,
    };
  });
  const builds = await scoreBuilds(join(scratch, 'build'), checks);

  const pages: Page[] = patchedWork.flatMap((w) => {
    const { id, filePath } = w.loaded.case;
    return [
      { key: `${id}/input`, filePath, source: w.input },
      { key: `${id}/patched`, filePath, source: w.patched! },
    ];
  });
  const scanned = pages.length > 0 ? await scanPages(join(scratch, 'pages'), pages) : undefined;
  axeVersion = scanned?.axeVersion;

  for (const w of patchedWork) {
    const c = w.loaded.case;
    const build = builds.get(c.id)!;
    w.scores.buildSafe = build.pass;
    w.notes.push(...build.notes);
    const resolved = scoreResolved(
      c.issue.ruleId,
      c.expectedOutcome,
      scanned!.scans.get(`${c.id}/input`)!,
      scanned!.scans.get(`${c.id}/patched`)!,
    );
    w.scores.resolved = resolved.pass;
    w.notes.push(...resolved.notes);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// 4. Report.
const records: CaseRecord[] = work.map((w) => {
  const c = w.loaded.case;
  const base = {
    caseId: c.id,
    datasetVersion,
    caseVersion: c.version,
    costUsd: w.costUsd,
    latencyMs: w.latencyMs,
    model: fixer.model,
    promptVersion: fixer.promptVersion,
  };
  const result: EvalResult =
    w.proposal === undefined
      ? { ...base, outcome: 'error', error: w.error ?? 'no proposal' }
      : {
          ...base,
          outcome: w.proposal.outcome,
          outcomeCorrect: w.proposal.outcome === c.expectedOutcome,
          scores: w.scores,
        };
  const notes = result.outcome === 'error' ? [`error: ${result.error}`] : [...w.notes];
  if (result.outcome !== 'error' && !result.outcomeCorrect) {
    notes.unshift(`outcome: expected ${c.expectedOutcome}, got ${result.outcome}`);
  }
  return {
    result,
    expectedOutcome: c.expectedOutcome,
    category: c.category,
    pass: passed(c.expectedOutcome, result),
    proposal: w.proposal,
    notes,
  };
});

const createdAt = new Date().toISOString();
// Parsed here so a malformed report fails this run, not a later --rescore.
const report = RunReport.parse({
  createdAt,
  mode,
  datasetVersion,
  model: fixer.model,
  promptVersion: fixer.promptVersion,
  axeVersion,
  totals: totals(records),
  cases: records,
});
const out = resolve(
  cwd,
  values.out ?? join(evalsRoot, 'reports', `${createdAt.replaceAll(/[:.]/g, '-')}-${mode}.json`),
);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

console.log(summaryLines(report).join('\n'));
const shown = relative(cwd, out);
console.log(`\nReport: ${shown.startsWith('..') ? out : shown}`);

// The reference fixer is a self-check: any failure is a harness or dataset bug.
process.exit(mode === 'reference' && report.totals.passed < report.totals.cases ? 1 : 0);
