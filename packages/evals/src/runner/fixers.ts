// What the runner scores. The live fixer will call `proposeFix` from
// @curbcut/agent once it lands (#9). Until then, and for checking the
// harness itself, there are two fixers that cost nothing:
//
// - reference: answers every case with its expected outcome, and fix cases
//   with the diff from input/ to expected/. Every case should pass; if one
//   doesn't, the harness or the case is wrong, not the agent.
// - rescore: returns the proposals saved in an earlier run's JSON report, so a
//   change to the scorers or the harness can be checked for free. It never
//   runs agent code; `--replay` will, on recorded responses, once the provider
//   has a replay mode (#6).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PatchProposal, type EvalCase } from '@curbcut/core';
import { createPatch } from 'diff';
import { RunReport } from './report.ts';

export type FixerResult = (
  | { proposal: unknown }
  /** A failure the fixer can still give metrics for (a recorded error). */
  | { error: string }
) & {
  costUsd: number;
  /** Set when the fixer knows better than the runner's wall clock (rescore). */
  latencyMs?: number;
};

export interface Fixer {
  model: string;
  promptVersion: string;
  /** `dir` is the case folder; only the reference fixer may look past input/. */
  propose(c: EvalCase, input: string, dir: string, datasetVersion: number): Promise<FixerResult>;
}

export const referenceFixer: Fixer = {
  model: 'reference',
  promptVersion: 'expected',
  propose(c, input, dir) {
    let proposal: PatchProposal;
    const explanation = 'Reference answer from the dataset.';
    if (c.expectedOutcome === 'fix') {
      const expected = readFileSync(join(dir, 'expected', c.filePath), 'utf8');
      const diff = createPatch(c.filePath, input, expected);
      proposal = { outcome: 'fix', filePath: c.filePath, diff, explanation, confidence: 1 };
    } else if (c.expectedOutcome === 'unsure') {
      proposal = { outcome: 'unsure', question: 'Reference question.', explanation, confidence: 1 };
    } else {
      proposal = { outcome: 'no_change_needed', explanation, confidence: 1 };
    }
    return Promise.resolve({ proposal, costUsd: 0 });
  },
};

/** Returns the proposals in a saved report. Throws if the report doesn't parse. */
export function rescoreFixer(reportPath: string): Fixer {
  const report = RunReport.parse(JSON.parse(readFileSync(reportPath, 'utf8')));
  const byCase = new Map(report.cases.map((r) => [r.result.caseId, r]));
  return {
    model: report.model,
    promptVersion: report.promptVersion,
    // In a promise executor, so a stale or missing recording rejects like a live failure would.
    propose: (c, _input, _dir, datasetVersion) =>
      new Promise((resolve) => {
        const r = byCase.get(c.id);
        if (!r) throw new Error(`no recording for this case in ${reportPath}`);
        const { result } = r;
        const metrics = { costUsd: result.costUsd, latencyMs: result.latencyMs };
        // A case that changed since the recording would score a stale answer.
        if (result.caseVersion !== c.version || result.datasetVersion !== datasetVersion) {
          throw new Error(
            `recorded against case v${result.caseVersion} of dataset v${result.datasetVersion}, ` +
              `now case v${c.version} of dataset v${datasetVersion}`,
          );
        }
        if (result.outcome === 'error') resolve({ error: result.error, ...metrics });
        else if (!r.proposal) resolve({ error: 'recording has no proposal', ...metrics });
        else resolve({ proposal: r.proposal, ...metrics });
      }),
  };
}
