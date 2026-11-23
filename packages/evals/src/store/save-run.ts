// Saves a live run's JSON report to `eval_runs` and `eval_results` (#16).
//
//   npm run evals:save -- <report.json> --trigger pr|weekly|manual [--sha <sha>] [--branch <name>]
//
// The git SHA and branch default to GitHub Actions' variables, then to the
// local checkout. Needs DATABASE_URL. Prints the new run's id.
//
// A run on `main` can only be saved from GitHub Actions: `main` runs are the
// baseline PRs are judged against, and a local checkout may have changes
// that aren't on main.
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

/**
 * The PR's head commit on a pull_request event. There GITHUB_SHA is a
 * temporary merge commit with main, which nobody can look up later.
 */
function pullRequestHeadSha(): string | undefined {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!process.env.GITHUB_EVENT_NAME?.startsWith('pull_request') || !path) return undefined;
  const event = JSON.parse(readFileSync(path, 'utf8')) as {
    pull_request?: { head?: { sha?: string } };
  };
  return event.pull_request?.head?.sha;
}

// On a pull_request event GITHUB_REF_NAME is `<n>/merge`, so a PR's own
// branch comes from GITHUB_HEAD_REF.
const gitSha =
  values.sha ?? pullRequestHeadSha() ?? process.env.GITHUB_SHA ?? git('rev-parse', 'HEAD');
const branch =
  values.branch ||
  process.env.GITHUB_HEAD_REF ||
  process.env.GITHUB_REF_NAME ||
  git('rev-parse', '--abbrev-ref', 'HEAD');

if (branch === 'main' && process.env.GITHUB_ACTIONS !== 'true') {
  fail('Runs on main are the baseline, so only GitHub Actions saves them.');
}

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
