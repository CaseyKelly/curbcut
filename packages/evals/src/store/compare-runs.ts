// Compares two eval runs per metric and per case (#16).
//
//   npm run evals:compare -- <base> <head> [--json]
//
// Each run is a stored run's id, a JSON report from the runner, or `main` for
// the latest run on main with the other run's dataset version (the baseline
// a PR is judged against). Stored runs and `main` need DATABASE_URL.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createDb, type Db } from '@curbcut/db';
import { RunReport } from '../runner/report.ts';
import { compareRuns, comparisonLines } from './compare.ts';
import { latestRun, loadRun } from './runs.ts';

const cwd = process.env.INIT_CWD ?? process.cwd();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { json: { type: 'boolean', default: false } },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

if (positionals.length !== 2) fail('Usage: evals:compare <base> <head> [--json]');
if (positionals[0] === 'main' && positionals[1] === 'main') {
  fail('Only one side can be `main`: its dataset version comes from the other run.');
}

interface Loaded {
  label: string;
  report: RunReport;
}

let db: Db | undefined;
const database = () => (db ??= createDb());

/** A run from a report file or the database; `main` is resolved afterwards. */
async function load(arg: string): Promise<Loaded> {
  const path = resolve(cwd, arg);
  if (existsSync(path)) {
    try {
      return { label: arg, report: RunReport.parse(JSON.parse(readFileSync(path, 'utf8'))) };
    } catch (e) {
      fail(`Can't read ${arg}: ${(e as Error).message}`);
    }
  }
  const run = await loadRun(database(), arg);
  if (!run) fail(`No report file or stored run called ${arg}`);
  return {
    label: `run ${arg.slice(0, 8)} (${run.branch} @ ${run.gitSha.slice(0, 7)})`,
    report: run.report,
  };
}

async function baseline(datasetVersion: number): Promise<Loaded> {
  const run = await latestRun(database(), datasetVersion);
  if (!run) fail(`No run on main for dataset v${datasetVersion} yet`);
  return { label: `main (${run.gitSha.slice(0, 7)})`, report: run.report };
}

try {
  const [baseArg, headArg] = positionals as [string, string];
  const head = baseArg === 'main' ? await load(headArg) : undefined;
  const base = head ? await baseline(head.report.datasetVersion) : await load(baseArg);
  const resolvedHead =
    head ?? (headArg === 'main' ? await baseline(base.report.datasetVersion) : await load(headArg));

  let comparison;
  try {
    comparison = compareRuns(base.report, resolvedHead.report);
  } catch (e) {
    fail(`Can't compare: ${(e as Error).message}`);
  }
  console.log(
    values.json
      ? JSON.stringify(comparison, null, 2)
      : comparisonLines(comparison, base.label, resolvedHead.label).join('\n'),
  );
} finally {
  await db?.$client.end();
}
