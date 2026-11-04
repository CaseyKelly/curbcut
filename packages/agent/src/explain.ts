// Explains one issue group, from the cache when it can (#7). A cache hit makes
// no LLM call, so it costs nothing and never touches the budget.
import { IssueExplanation } from '@curbcut/core';
import { explanations, type Db } from '@curbcut/db';
import { eq } from 'drizzle-orm';
import type { CallContext, LLMProvider } from './llm/provider';
import {
  EXPLAIN_MODEL,
  EXPLAIN_PROMPT_VERSION,
  EXPLAIN_SYSTEM,
  explainCacheKey,
  explainInput,
  explainMessage,
  type ExplainableIssue,
} from './prompts/explain';

/** An explanation is a few short sentences, so this is generous. */
const MAX_TOKENS = 1_024;

export interface ExplainResult {
  /** The `explanations` row, to link the group's issues to. */
  explanationId: string;
  /** True only if no call was made. A call that lost a race to store its answer still cost money. */
  cached: boolean;
}

async function findCached(db: Db, cacheKey: string) {
  const [row] = await db
    .select({ id: explanations.id, body: explanations.body })
    .from(explanations)
    .where(eq(explanations.cacheKey, cacheKey));
  if (!row) return undefined;
  // A bad cached body is a bug (a schema change without a prompt version bump), so fail loudly.
  return { id: row.id, body: IssueExplanation.parse(row.body) };
}

/**
 * Explains the issues of one rule: returns the cached explanation if there is
 * one, otherwise asks the model once and caches the answer. The cache key is
 * rule + a hash of the prompt input (the elements' HTML and failure
 * summaries, the rule's summary and criteria) + prompt version + model.
 */
export async function explainGroup(
  { db, provider }: { db: Db; provider: LLMProvider },
  issues: readonly ExplainableIssue[],
  context: CallContext,
): Promise<ExplainResult> {
  const input = explainInput(issues);
  const cacheKey = explainCacheKey(input);

  const hit = await findCached(db, cacheKey);
  if (hit) return { explanationId: hit.id, cached: true };

  const result = await provider.generateObject(
    {
      model: EXPLAIN_MODEL,
      system: EXPLAIN_SYSTEM,
      messages: [{ role: 'user', content: explainMessage(input) }],
      schema: IssueExplanation,
      maxTokens: MAX_TOKENS,
    },
    context,
  );

  const [inserted] = await db
    .insert(explanations)
    .values({
      cacheKey,
      ruleId: input.ruleId,
      body: result.value,
      model: EXPLAIN_MODEL,
      promptVersion: EXPLAIN_PROMPT_VERSION,
      inputTokens:
        result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.cacheWriteTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: result.costUsd,
    })
    // Two groups with identical input can race; the first row wins.
    .onConflictDoNothing({ target: explanations.cacheKey })
    .returning({ id: explanations.id });
  if (inserted) return { explanationId: inserted.id, cached: false };

  const winner = await findCached(db, cacheKey);
  if (!winner) throw new Error(`Explanation ${cacheKey} vanished after a conflicting insert`);
  // The call was made and charged to the run, so this isn't a cache hit.
  return { explanationId: winner.id, cached: false };
}
