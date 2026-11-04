import { describe, expect, it } from 'vitest';
import { costUsd, MODELS } from './pricing';

const none = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe('costUsd', () => {
  it('prices input and output per million tokens', () => {
    const cost = costUsd(MODELS.sonnet, { ...none, inputTokens: 1_000_000, outputTokens: 100_000 });
    expect(cost).toBeCloseTo(2 + 1);
  });

  it('prices cache reads at 0.1x and cache writes at 1.25x the input rate', () => {
    expect(costUsd(MODELS.sonnet, { ...none, cacheReadTokens: 1_000_000 })).toBeCloseTo(0.2);
    expect(costUsd(MODELS.sonnet, { ...none, cacheWriteTokens: 1_000_000 })).toBeCloseTo(2.5);
  });

  it("uses Haiku's higher rates for prompts over 100K tokens, cached ones included", () => {
    expect(costUsd(MODELS.haiku, { ...none, inputTokens: 100_000 })).toBeCloseTo(0.01);
    expect(
      costUsd(MODELS.haiku, { ...none, inputTokens: 50_000, cacheReadTokens: 50_001 }),
    ).toBeCloseTo((50_000 * 0.5 + 50_001 * 0.05) / 1_000_000);
  });

  it('refuses to price an unknown model rather than call it free', () => {
    expect(() => costUsd('claude-unknown', none)).toThrow(/No pricing/);
  });
});
