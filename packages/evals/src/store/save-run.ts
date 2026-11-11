// Saves a live run's JSON report to `eval_runs` and `eval_results` (#16).
//
//   npm run evals:save -- <report.json> --trigger pr|weekly|manual [--sha <sha>] [--branch <name>]
//
// The git SHA and branch default to GitHub Actions' variables, then to the
// local checkout. Needs DATABASE_URL. Prints the new run's id.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createDb } from '@curbcut/db';
import { RunReport } from '../runner/report.ts';
import { EvalTrigger, saveRun } from './runs.ts';

const cwd = process.env.INIT_CWD ?? process.cwd();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    trigger: { type: 'string' },
    sha: { type: 'string' },
    branch: { type: 'string' },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

if (positionals.length !== 1) fail('Usage: evals:save <report.json> --trigger pr|weekly|manual');
const trigger = EvalTrigger.safeParse(values.trigger);
if (!trigger.success) fail(`--trigger must be one of: ${EvalTrigger.options.join(', ')}`);

let report: RunReport;
try {
  report = RunReport.parse(JSON.parse(readFileSync(resolve(cwd, positionals[0]!), 'utf8')));
} catch (e) {
  fail(`Can't read ${positionals[0]}: ${(e as Error).message}`);
}

// On a pull_request event GITHUB_SHA is the merge commit and GITHUB_REF_NAME
// is `<n>/merge`, so a PR's own branch comes from GITHUB_HEAD_REF.
const gitSha = values.sha ?? process.env.GITHUB_SHA ?? git('rev-parse', 'HEAD');
const branch =
  values.branch ||
  process.env.GITHUB_HEAD_REF ||
  process.env.GITHUB_REF_NAME ||
  git('rev-parse', '--abbrev-ref', 'HEAD');

const db = createDb();
try {
  const id = await saveRun(db, report, { gitSha, branch, trigger: trigger.data });
  console.log(`Saved eval run ${id} (${branch} @ ${gitSha.slice(0, 7)}, ${trigger.data})`);
} catch (e) {
  console.error(`Can't save the run: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.$client.end();
}
