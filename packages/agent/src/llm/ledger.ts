// Where the provider records spend and reads it back for the budget guard (#6).
import { agentRuns, evalRuns, scans, type Db } from '@curbcut/db';
import { eq, gte, sql } from 'drizzle-orm';

/** One LLM call's tokens and cost, charged to a run. */
export interface UsageRecord {
  runId: string;
  model: string;
  /** All input, cached or not. The cost carries the price difference. */
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface UsageLedger {
  record(usage: UsageRecord): Promise<void>;
  /** Spend since the start of the current UTC month, in US dollars. */
  monthToDateSpendUsd(): Promise<number>;
}

/** Start of the current month in UTC. */
export function startOfMonthUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * LLM spend since the start of the UTC month: `agent_runs.cost_usd` plus
 * `eval_runs.cost_usd` (#16), each run counted in the month it started. Every
 * database ledger uses this, so the budget sees all spend. An eval run is
 * saved once it finishes, so the guard doesn't see one still in progress.
 */
export async function monthToDateSpendUsd(db: Db): Promise<number> {
  const since = startOfMonthUtc();
  const sum = (column: typeof agentRuns.costUsd | typeof evalRuns.costUsd) =>
    sql<string>`coalesce(sum(${column}), 0)`;
  const [[agent], [evals]] = await Promise.all([
    db
      .select({ total: sum(agentRuns.costUsd) })
      .from(agentRuns)
      .where(gte(agentRuns.createdAt, since)),
    db
      .select({ total: sum(evalRuns.costUsd) })
      .from(evalRuns)
      .where(gte(evalRuns.createdAt, since)),
  ]);
  return Number(agent?.total ?? 0) + Number(evals?.total ?? 0);
}

/** Charges each call to its `agent_runs` row and the run's scan. */
export function createDbLedger(db: Db): UsageLedger {
  return {
    async record({ runId, inputTokens, outputTokens, costUsd }) {
      await db.transaction(async (tx) => {
        const [run] = await tx
          .update(agentRuns)
          .set({
            inputTokens: sql`${agentRuns.inputTokens} + ${inputTokens}`,
            outputTokens: sql`${agentRuns.outputTokens} + ${outputTokens}`,
            costUsd: sql`${agentRuns.costUsd} + ${costUsd}`,
          })
          .where(eq(agentRuns.id, runId))
          .returning({ scanId: agentRuns.scanId });
        // The money is already spent, so a missing run is a bug worth failing loudly on.
        if (!run) throw new Error(`No agent run ${runId} to record LLM usage against`);
        await tx
          .update(scans)
          .set({
            inputTokens: sql`${scans.inputTokens} + ${inputTokens}`,
            outputTokens: sql`${scans.outputTokens} + ${outputTokens}`,
            costUsd: sql`${scans.costUsd} + ${costUsd}`,
          })
          .where(eq(scans.id, run.scanId));
      });
    },

    monthToDateSpendUsd: () => monthToDateSpendUsd(db),
  };
}

/** Keeps usage in memory. For tests and local scripts. */
export function createMemoryLedger(initialSpendUsd = 0) {
  const records: UsageRecord[] = [];
  return {
    records,
    record(usage: UsageRecord) {
      records.push(usage);
      return Promise.resolve();
    },
    monthToDateSpendUsd() {
      return Promise.resolve(records.reduce((sum, r) => sum + r.costUsd, initialSpendUsd));
    },
  } satisfies UsageLedger & { records: UsageRecord[] };
}
