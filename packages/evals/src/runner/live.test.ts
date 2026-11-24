import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { MODELS, createMemoryLedger, createProvider, proposeFix } from '@curbcut/agent';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { validateDataset } from '../dataset/dataset';
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
const reply = (): Anthropic.Message =>
  ({
    id: 'm',
    type: 'message',
    role: 'assistant',
    model: MODELS.sonnet,
    content: [{ type: 'text', text: JSON.stringify(badAnswer), citations: null }],
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
});
