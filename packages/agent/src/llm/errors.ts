/** Month-to-date LLM spend has reached `LLM_MONTHLY_BUDGET_USD`, so the call wasn't made (#6). */
export class BudgetExceededError extends Error {
  override name = 'BudgetExceededError';
  constructor(
    readonly spentUsd: number,
    readonly budgetUsd: number,
  ) {
    super(`Monthly LLM budget reached: $${spentUsd.toFixed(2)} spent of $${budgetUsd.toFixed(2)}`);
  }
}

/**
 * The model's output still failed its schema after one repair attempt (#6).
 * `output` and `problem` are from the last attempt.
 */
export class StructuredOutputError extends Error {
  override name = 'StructuredOutputError';
  constructor(
    readonly output: string,
    readonly problem: string,
  ) {
    super(`Model output failed its schema after a repair attempt: ${problem}`);
  }
}

/** A structured answer was cut off at `max_tokens`, so it wasn't sent for repair. */
export class OutputTruncatedError extends Error {
  override name = 'OutputTruncatedError';
  constructor(readonly maxTokens: number) {
    super(`Model output was cut off at max_tokens (${maxTokens}); raise maxTokens`);
  }
}

/** The model declined the request (`stop_reason: "refusal"`). Retrying won't help. */
export class RefusalError extends Error {
  override name = 'RefusalError';
}

/** Replay mode has no recording for this request. Record one with `LLM_MODE=record`. */
export class ReplayMissError extends Error {
  override name = 'ReplayMissError';
  constructor(readonly key: string) {
    super(`No recorded LLM response for request ${key}; re-run with LLM_MODE=record to record it`);
  }
}
