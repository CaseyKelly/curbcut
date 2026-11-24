// The live fixer (#9): calls `proposeFix` from @curbcut/agent, the same code
// the agent will call through `propose_patch` in M3, so a score measures what
// ships. It needs only an LLM provider: no worker or web app, and a database
// only to read the month's spend.
//
// `LLM_MODE` picks live, record, or replay, as everywhere else. Outside
// production it defaults to replay, which serves recordings from
// `LLM_RECORDINGS_DIR` (here, `packages/evals/recordings` unless set) and
// fails a case that has none. Record with `LLM_MODE=record`.
//
// Spend goes to an in-memory ledger: a run is saved to `eval_runs` only once
// it finishes (`npm run evals:save`, #16). When the run spends money and
// DATABASE_URL is set, the budget guard starts from the month's spend so far;
// without it, the guard sees only this run and `LLM_MONTHLY_BUDGET_USD` caps
// the run.
import {
  FIX_MODEL,
  FIX_PROMPT_VERSION,
  createMemoryLedger,
  createProvider,
  monthToDateSpendUsd,
  proposeFix,
  type LLMMode,
  type UsageLedger,
} from '@curbcut/agent';
import { createDb } from '@curbcut/db';
import type { Fixer } from './fixers.ts';

export interface LiveFixer extends Fixer {
  llmMode: LLMMode;
  /** Month-to-date spend read from the database, or undefined if it wasn't read. */
  priorSpendUsd: number | undefined;
  /**
   * The run's spend so far, on top of `priorSpendUsd`. The judge (#15) charges
   * its calls here too, so one budget guard sees the fixer's and the judge's.
   */
  ledger: UsageLedger;
}

async function readMonthSpend(url: string): Promise<number> {
  const db = createDb(url);
  try {
    return await monthToDateSpendUsd(db);
  } finally {
    await db.$client.end();
  }
}

export async function liveFixer({
  runId,
  recordingsDir,
}: {
  runId: string;
  recordingsDir: string;
}): Promise<LiveFixer> {
  const memory = createMemoryLedger();
  let priorSpendUsd: number | undefined;
  const ledger: UsageLedger = {
    record: (usage) => memory.record(usage),
    monthToDateSpendUsd: async () => (priorSpendUsd ?? 0) + (await memory.monthToDateSpendUsd()),
  };
  const provider = createProvider({
    ledger,
    recordingsDir: process.env.LLM_RECORDINGS_DIR ?? recordingsDir,
  });
  // Replay spends nothing and skips the guard, so it never needs the database.
  if (provider.mode !== 'replay' && process.env.DATABASE_URL) {
    priorSpendUsd = await readMonthSpend(process.env.DATABASE_URL);
  }

  return {
    model: FIX_MODEL,
    promptVersion: FIX_PROMPT_VERSION,
    llmMode: provider.mode,
    priorSpendUsd,
    ledger,
    async propose(c, input) {
      const before = memory.records.length;
      try {
        const r = await proposeFix({ provider }, { path: c.filePath, content: input }, c.issue, {
          runId,
        });
        // costUsd is priced from the tokens even when replayed, so replayed and
        // live runs compare; spentUsd is what was actually paid (0 in replay).
        return { proposal: r.proposal, costUsd: r.recordedCostUsd, spentUsd: r.costUsd };
      } catch (e) {
        // A case that failed after its calls were made (a refusal, a cut-off
        // answer, a repair that still failed) still cost them, every attempt
        // included. Priced from the tokens, as for a success; spent is 0 in replay.
        // Slicing from `before` is right only because the runner proposes one
        // case at a time, and judges only after every proposal; run cases in
        // parallel, or judge while proposing, and this would count other calls. Charge per case then (a ledger per case, say).
        const calls = memory.records.slice(before);
        const sum = (pick: (u: (typeof calls)[number]) => number) =>
          calls.reduce((total, u) => total + pick(u), 0);
        return {
          error: (e as Error).message || String(e),
          costUsd: sum((u) => u.recordedCostUsd),
          spentUsd: sum((u) => u.costUsd),
        };
      }
    },
  };
}
