// The LLM provider for eval runs (#15). Evals have no `agent_runs` row to
// charge, so their spend is kept with the run and stored with it (#16). The
// budget guard still sees the month's spend from the database when
// DATABASE_URL is set; without it, only this run's.
//
// The mode comes from LLM_MODE as everywhere else: `replay` (the default
// outside production) serves recordings from LLM_RECORDINGS_DIR for free,
// `record` calls the API and saves them, `live` just calls the API.
import { randomUUID } from 'node:crypto';
import {
  BudgetExceededError,
  createProvider,
  monthToDateSpendUsd,
  OutputTruncatedError,
  RefusalError,
  StructuredOutputError,
  type CallContext,
  type LLMProvider,
  type UsageLedger,
} from '@curbcut/agent';
import { createDb, type Db } from '@curbcut/db';

/** The month's spend couldn't be read, so no call can pass the budget guard. */
export class BudgetCheckError extends Error {
  override name = 'BudgetCheckError';
}

export interface EvalLLM {
  provider: LLMProvider;
  /** Charges every call to this eval run. */
  context: CallContext;
  /** Closes the database connection, if there is one. */
  close(): Promise<void>;
}

export function createEvalLLM(): EvalLLM {
  const db: Db | undefined = process.env.DATABASE_URL ? createDb() : undefined;
  let spentUsd = 0;
  const ledger: UsageLedger = {
    record({ costUsd }) {
      spentUsd += costUsd;
      return Promise.resolve();
    },
    async monthToDateSpendUsd() {
      // This run isn't saved until it ends, so add what it has spent so far.
      if (!db) return spentUsd;
      try {
        return (await monthToDateSpendUsd(db)) + spentUsd;
      } catch (e) {
        throw new BudgetCheckError(
          `can't read this month's LLM spend from DATABASE_URL: ${(e as Error).message}`,
          { cause: e },
        );
      }
    },
  };
  return {
    provider: createProvider({ ledger }),
    context: { runId: randomUUID() },
    close: async () => {
      await db?.$client.end();
    },
  };
}

/**
 * Rejected requests in a row, with no call answered in between, after which
 * an eval stops calling. The account hitting its console spend limit looks
 * like this: every request comes back 400. Matches the explain job (#7).
 */
export const MAX_CONSECUTIVE_REJECTIONS = 3;

/**
 * Decides when an eval should stop making LLM calls, so an account-wide
 * problem fails once with a clear reason instead of once per case. Errors
 * about one request (a bad output, a missing recording, a timeout) don't
 * stop it.
 */
export function createCallGuard() {
  let rejections = 0;
  let reason: string | undefined;
  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
  return {
    /** Why calls have stopped, or undefined while they may go on. */
    get stopped() {
      return reason;
    },
    succeeded() {
      rejections = 0;
    },
    failed(err: unknown) {
      if (err instanceof BudgetExceededError || err instanceof BudgetCheckError) {
        reason ??= message(err);
        return;
      }
      // The API answered, even if the answer was unusable.
      if (
        err instanceof StructuredOutputError ||
        err instanceof OutputTruncatedError ||
        err instanceof RefusalError
      ) {
        rejections = 0;
        return;
      }
      const status = (err as { status?: unknown } | null)?.status;
      if (status === 401 || status === 402 || status === 403 || status === 404) {
        reason ??= `the API refused the request (${status}): ${message(err)}`;
      } else if (status === 400 || status === 413 || status === 422) {
        if (++rejections >= MAX_CONSECUTIVE_REJECTIONS) {
          reason ??= `the API rejected ${rejections} requests in a row: ${message(err)}`;
        }
      }
    },
  };
}
