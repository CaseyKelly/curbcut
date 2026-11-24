import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import {
  BudgetExceededError,
  MODELS,
  createMemoryLedger,
  createProvider,
  proposeFix,
} from '@curbcut/agent';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { validateDataset } from '../dataset/dataset';
import { judgeFix, judgeInput } from '../scorers/judge';
import { createEvalLLM } from './llm';
import { liveFixer } from './live';

const root = new URL('../../dataset/', import.meta.url).pathname;
const { manifest, cases } = validateDataset(root);
const { case: c, dir } = cases.find((x) => x.case.id === 'area-alt-store-map')!;
const input = readFileSync(join(dir, 'input', c.filePath), 'utf8');

/** An answer whose edit never matches, so both attempts fail. */
const badAnswer = {
  outcome: 'fix',
  edits: [{ find: 'not in the file', replace: 'x' }],
  question: '',
  explanation: 'e',
  confidence: 0.5,
};
const reply = (answer: unknown = badAnswer): Anthropic.Message =>
  ({
    id: 'm',
    type: 'message',
    role: 'assistant',
    model: MODELS.sonnet,
    content: [{ type: 'text', text: JSON.stringify(answer), citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    container: null,
    usage: { input_tokens: 2_000, output_tokens: 300 },
  }) as Anthropic.Message;

describe('liveFixer', () => {
  const recordings = mkdtempSync(join(tmpdir(), 'live-fixer-'));
  afterAll(() => rmSync(recordings, { recursive: true, force: true }));
  afterEach(() => vi.unstubAllEnvs());

  it('prices a replayed failure from its recorded calls, with nothing spent', async () => {
    // Record a case that fails after its repair attempt: two calls.
    const recorder = createProvider({
      ledger: createMemoryLedger(),
      mode: 'record',
      recordingsDir: recordings,
      send: () => Promise.resolve(reply()),
    });
    const recorded = await proposeFix(
      { provider: recorder },
      { path: c.filePath, content: input },
      c.issue,
      { runId: 'r' },
    ).catch((e: unknown) => e);
    expect(recorded).toBeInstanceOf(Error);

    vi.stubEnv('LLM_MODE', 'replay');
    vi.stubEnv('DATABASE_URL', '');
    const fixer = await liveFixer({ runId: 'eval', recordingsDir: recordings });
    expect(fixer.llmMode).toBe('replay');
    const r = await fixer.propose(c, input, dir, manifest!.datasetVersion);
    expect(r).toMatchObject({ error: expect.stringContaining('repair') as string, spentUsd: 0 });
    // Two Sonnet calls of 2,000 in and 300 out at $2/$10 per million.
    expect(r.costUsd).toBeCloseTo(2 * (0.004 + 0.003));
  });

  describe('with the judge', () => {
    const judging = () => judgeInput(c, input, '--- a\n+++ b\n');
    const live = async () => {
      vi.stubEnv('LLM_MODE', 'live');
      vi.stubEnv('DATABASE_URL', '');
      vi.stubEnv('ANTHROPIC_API_KEY', 'test');
      vi.stubEnv('LLM_MONTHLY_BUDGET_USD', '0.05');
      return liveFixer({ runId: 'eval', recordingsDir: recordings });
    };
    const usage = (costUsd: number) => ({
      runId: 'eval',
      model: MODELS.sonnet,
      inputTokens: 1,
      outputTokens: 1,
      costUsd,
      recordedCostUsd: costUsd,
    });

    it("stops the judge once the fixer's spend reaches the budget", async () => {
      const fixer = await live();
      await fixer.ledger.record(usage(0.05));
      const send = vi.fn(() => Promise.resolve(reply({ score: 5, reason: 'r' })));
      const { provider, context } = createEvalLLM({ ledger: fixer.ledger, send });
      await expect(judgeFix(provider, judging(), context)).rejects.toBeInstanceOf(
        BudgetExceededError,
      );
      expect(send).not.toHaveBeenCalled();
    });

    it("charges the judge's calls where the fixer's guard sees them", async () => {
      const fixer = await live();
      const send = () => Promise.resolve(reply({ score: 5, reason: 'r' }));
      const { provider, context } = createEvalLLM({ ledger: fixer.ledger, send });
      const judged = await judgeFix(provider, judging(), context);
      expect(judged.costUsd).toBeGreaterThan(0);
      expect(await fixer.ledger.monthToDateSpendUsd()).toBeCloseTo(judged.costUsd);
    });
  });
});
