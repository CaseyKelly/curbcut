// Runs the judge on the calibration set and reports how often it lands within
// 1 point of the labels (#15). The target is 80%; it's reported, not a gate.
//
//   npm run evals:calibrate                  all labelled items
//   npm run evals:calibrate -- --out <path>  where to write the JSON report
//
// The judge's calls follow LLM_MODE like the runner's: `record` or `live`
// spends money (15 Haiku calls, about a cent), and `replay` serves recordings.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validateDataset } from '../dataset/dataset.ts';
import { createCallGuard, createEvalLLM } from '../runner/llm.ts';
import { JUDGE_MODEL, JUDGE_PROMPT_VERSION, judgeFix, judgeInput } from '../scorers/judge.ts';
import { AGREEMENT_TARGET, agreement, loadCalibration } from './calibration.ts';

const evalsRoot = fileURLToPath(new URL('../../', import.meta.url));
const cwd = process.env.INIT_CWD ?? process.cwd();
const { values } = parseArgs({ options: { out: { type: 'string' } } });

const { cases, errors: datasetErrors } = validateDataset(join(evalsRoot, 'dataset'));
if (datasetErrors.length > 0) {
  console.error(`The dataset is invalid; run npm run evals:validate.`);
  process.exit(1);
}
const { items, errors } = loadCalibration(join(evalsRoot, 'calibration'), cases);
if (errors.length > 0) {
  console.error(`The calibration set is invalid:\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
const labelled = items.filter((i) => i.item.label !== null);
if (labelled.length === 0) {
  console.error('No item in calibration/labels.json has a label yet.');
  process.exit(2);
}

let llm;
try {
  llm = createEvalLLM();
} catch (e) {
  console.error(`Can't run the judge: ${(e as Error).message}`);
  process.exit(2);
}

const rows: {
  id: string;
  label: number;
  labelReason: string;
  judge?: number;
  judgeReason?: string;
  error?: string;
}[] = [];
let costUsd = 0;
// An account-wide error stops the run: agreement on part of the set would mislead.
const guard = createCallGuard();
try {
  for (const { item, loaded, input, diff, referenceDiff } of labelled) {
    if (guard.stopped) break;
    const label = item.label!;
    try {
      const r = await judgeFix(
        llm.provider,
        judgeInput(loaded.case, input, diff, { referenceDiff }),
        llm.context,
      );
      guard.succeeded();
      costUsd += r.costUsd;
      rows.push({
        id: item.id,
        label: label.score,
        labelReason: label.reason,
        judge: r.judgement.score,
        judgeReason: r.judgement.reason,
      });
    } catch (e) {
      guard.failed(e);
      rows.push({
        id: item.id,
        label: label.score,
        labelReason: label.reason,
        error: (e as Error).message || String(e),
      });
    }
  }
} finally {
  await llm.close();
}
if (guard.stopped) {
  console.error(`The judge stopped early, so there's no agreement to report: ${guard.stopped}`);
  process.exit(1);
}

const result = agreement(rows);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const width = Math.max(4, ...rows.map((r) => r.id.length));
console.log(`Judge calibration: ${JUDGE_MODEL}, prompt ${JUDGE_PROMPT_VERSION}\n`);
console.log(`${'item'.padEnd(width)}  label  judge  diff`);
for (const r of rows) {
  const judge = r.judge === undefined ? 'ERR' : String(r.judge);
  const diff = r.judge === undefined ? '' : String(r.judge - r.label);
  const flag = r.judge !== undefined && Math.abs(r.judge - r.label) > 1 ? '  <- off by 2+' : '';
  console.log(
    `${r.id.padEnd(width)}  ${String(r.label).padStart(5)}  ${judge.padStart(5)}  ${diff.padStart(4)}${flag}`,
  );
}
console.log(
  `\nWithin 1 point  ${result.withinOne}/${result.compared} (${pct(result.rate)}), target ${pct(AGREEMENT_TARGET)}: ${result.meetsTarget ? 'met' : 'NOT met'}`,
);
console.log(`Exact           ${result.exact}/${result.compared}`);
console.log(
  `Mean bias       ${result.meanBias >= 0 ? '+' : ''}${result.meanBias.toFixed(2)} (judge minus label)`,
);
console.log(`Unlabelled      ${items.length - labelled.length}`);
console.log(`Cost            $${costUsd.toFixed(4)}`);
const failed = rows.filter((r) => r.error);
if (failed.length > 0) {
  console.log(`\nJudge errors:\n${failed.map((r) => `  ${r.id}: ${r.error}`).join('\n')}`);
}
const disagreements = rows.filter((r) => r.judge !== undefined && Math.abs(r.judge - r.label) > 1);
if (disagreements.length > 0) {
  console.log('\nOff by 2 or more:');
  for (const r of disagreements) {
    console.log(
      `  ${r.id}\n    label ${r.label}: ${r.labelReason}\n    judge ${r.judge}: ${r.judgeReason}`,
    );
  }
}

const createdAt = new Date().toISOString();
const out = resolve(
  cwd,
  values.out ??
    join(evalsRoot, 'reports', `${createdAt.replaceAll(/[:.]/g, '-')}-calibration.json`),
);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `${JSON.stringify({ createdAt, model: JUDGE_MODEL, promptVersion: JUDGE_PROMPT_VERSION, agreement: result, costUsd, items: rows }, null, 2)}\n`,
);
const shown = relative(cwd, out);
console.log(`\nReport: ${shown.startsWith('..') ? out : shown}`);
