// Per-model prices and the cost of one call (#6). Costs feed the budget guard,
// so an unknown model is an error rather than a free call.

/** The models the plan uses: Sonnet for the agent and fixes, Haiku for explanations and the judge. */
export const MODELS = {
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
} as const;
export type ModelId = (typeof MODELS)[keyof typeof MODELS];

/** US dollars per million tokens. */
interface Rates {
  input: number;
  output: number;
}

interface ModelPricing {
  rates: Rates;
  /** A higher rate card for prompts over `threshold` input tokens (Haiku 5.5). */
  longPrompt?: { threshold: number; rates: Rates };
}

// Anthropic list prices as of Oct 2026. Update them here when they change.
const PRICING: Record<ModelId, ModelPricing> = {
  'claude-sonnet-5-5': { rates: { input: 2, output: 10 } },
  'claude-haiku-5-5': {
    rates: { input: 0.1, output: 0.5 },
    longPrompt: { threshold: 100_000, rates: { input: 0.5, output: 2.5 } },
  },
};

/** Cache reads and 5-minute cache writes, as multiples of the input rate. */
const CACHE_READ = 0.1;
const CACHE_WRITE = 1.25;

/** Token counts for one call, from the API's `usage`. */
export interface TokenUsage {
  /** Uncached input. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function isKnownModel(model: string): model is ModelId {
  return Object.hasOwn(PRICING, model);
}

/** What a call cost in US dollars. */
export function costUsd(model: string, usage: TokenUsage): number {
  if (!isKnownModel(model)) throw new Error(`No pricing for model ${model}`);
  const pricing = PRICING[model];
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const rates =
    pricing.longPrompt && prompt > pricing.longPrompt.threshold
      ? pricing.longPrompt.rates
      : pricing.rates;
  const input =
    usage.inputTokens + usage.cacheReadTokens * CACHE_READ + usage.cacheWriteTokens * CACHE_WRITE;
  return (input * rates.input + usage.outputTokens * rates.output) / 1_000_000;
}
