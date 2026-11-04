import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { IssueExplanation } from '@curbcut/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BudgetExceededError,
  OutputTruncatedError,
  RefusalError,
  ReplayMissError,
  StructuredOutputError,
} from './errors';
import { createMemoryLedger } from './ledger';
import { costUsd, MODELS } from './pricing';
import { buildParams, createProvider, type LLMRequest } from './provider';
import type { SendMessage } from './replay';

const usage = { input_tokens: 1_000, output_tokens: 200 };

function message(
  text: string,
  extra: Partial<Anthropic.Message> & { usage?: Partial<Anthropic.Usage> } = {},
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: MODELS.haiku,
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    container: null,
    ...extra,
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      server_tool_use: null,
      service_tier: null,
      ...usage,
      ...extra.usage,
    },
  } as Anthropic.Message;
}

/** A stand-in for the API that returns `responses` in order and remembers each request. */
function fakeSend(...responses: Anthropic.Message[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const send = vi.fn<SendMessage>((params) => {
    requests.push(params);
    const next = responses.shift();
    return next ? Promise.resolve(next) : Promise.reject(new Error('no more responses'));
  });
  return { send, requests };
}

const explanation = {
  whatsWrong: 'The image has no alt text.',
  whoItAffects: 'Screen reader users.',
  whyItMatters: 'They miss what the image shows.',
  confidence: 0.9,
};

const request = {
  model: MODELS.haiku,
  system: 'Explain accessibility issues.',
  messages: [{ role: 'user', content: 'image-alt on <img src="a.png">' }],
} satisfies LLMRequest;

const context = { runId: 'run-1' };

describe('buildParams', () => {
  it('caches the system prompt and the tool definitions', () => {
    const tool = (name: string): Anthropic.Tool => ({
      name,
      description: name,
      input_schema: { type: 'object', properties: {} },
    });
    const params = buildParams({ ...request, tools: [tool('a'), tool('b')], effort: 'low' });
    expect(params.system).toEqual([
      { type: 'text', text: request.system, cache_control: { type: 'ephemeral' } },
    ]);
    // One breakpoint on the last tool caches them all.
    expect(params.tools?.map((t) => 'cache_control' in t && t.cache_control)).toEqual([
      false,
      { type: 'ephemeral' },
    ]);
    expect(params.output_config).toEqual({ effort: 'low' });
  });

  it('leaves out tools and output_config when there are none', () => {
    const params = buildParams(request);
    expect(params).not.toHaveProperty('tools');
    expect(params).not.toHaveProperty('output_config');
  });
});

describe('createProvider', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'curbcut-llm-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function live(send: SendMessage, ledger = createMemoryLedger()) {
    return createProvider({ ledger, mode: 'live', send, monthlyBudgetUsd: 20 });
  }

  describe('generateObject', () => {
    it('returns the validated object and charges the call to the run', async () => {
      const { send, requests } = fakeSend(message(JSON.stringify(explanation)));
      const ledger = createMemoryLedger();
      const result = await live(send, ledger).generateObject(
        { ...request, schema: IssueExplanation },
        context,
      );

      expect(result.value).toEqual(explanation);
      expect(result.attempts).toBe(1);
      expect(requests[0]?.output_config?.format?.type).toBe('json_schema');
      const cost = costUsd(MODELS.haiku, {
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      expect(result.costUsd).toBeCloseTo(cost);
      expect(ledger.records).toEqual([
        {
          runId: 'run-1',
          model: MODELS.haiku,
          inputTokens: 1_000,
          outputTokens: 200,
          costUsd: cost,
        },
      ]);
    });

    it('makes one repair attempt with the validation error', async () => {
      const bad = JSON.stringify({ ...explanation, confidence: 2 });
      const { send, requests } = fakeSend(message(bad), message(JSON.stringify(explanation)));
      const ledger = createMemoryLedger();
      const result = await live(send, ledger).generateObject(
        { ...request, schema: IssueExplanation },
        context,
      );

      expect(result.value).toEqual(explanation);
      expect(result.attempts).toBe(2);
      expect(result.usage.inputTokens).toBe(2_000);
      expect(ledger.records).toHaveLength(2);
      const repair = requests[1]!.messages;
      expect(repair).toHaveLength(3);
      expect(repair[1]).toMatchObject({
        role: 'assistant',
        content: [{ type: 'text', text: bad }],
      });
      expect(repair[2]).toMatchObject({ role: 'user' });
      expect(JSON.stringify(repair[2])).toContain('confidence');
    });

    it('throws a typed error when the repair fails too', async () => {
      const { send } = fakeSend(message('not json'), message('{"whatsWrong": ""}'));
      const err: unknown = await live(send)
        .generateObject({ ...request, schema: IssueExplanation }, context)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StructuredOutputError);
      expect((err as StructuredOutputError).output).toBe('{"whatsWrong": ""}');
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  it('does not repair an answer cut off at max_tokens', async () => {
    const { send } = fakeSend(message('{"whatsWrong": "The im', { stop_reason: 'max_tokens' }));
    const ledger = createMemoryLedger();
    await expect(
      live(send, ledger).generateObject(
        { ...request, maxTokens: 500, schema: IssueExplanation },
        context,
      ),
    ).rejects.toThrow(OutputTruncatedError);
    expect(send).toHaveBeenCalledOnce();
    expect(ledger.records).toHaveLength(1);
  });

  it('refuses a model it has no price for before calling the API', async () => {
    const { send } = fakeSend(message('hi'));
    const unknown = { ...request, model: 'claude-unknown' } as unknown as LLMRequest;
    await expect(live(send).createMessage(unknown, context)).rejects.toThrow(/No pricing/);
    expect(send).not.toHaveBeenCalled();
  });

  it('throws on a refusal, after recording its usage', async () => {
    const { send } = fakeSend(message('', { stop_reason: 'refusal' }));
    const ledger = createMemoryLedger();
    await expect(live(send, ledger).createMessage(request, context)).rejects.toThrow(RefusalError);
    expect(ledger.records).toHaveLength(1);
  });

  it('refuses calls once the monthly budget is spent', async () => {
    const { send } = fakeSend(message('hi'));
    const provider = live(send, createMemoryLedger(20));
    await expect(provider.createMessage(request, context)).rejects.toThrow(BudgetExceededError);
    expect(send).not.toHaveBeenCalled();
  });

  it('allows calls under the budget', async () => {
    const { send } = fakeSend(message('hi'));
    await live(send, createMemoryLedger(19.99)).createMessage(request, context);
    expect(send).toHaveBeenCalledOnce();
  });

  it('replays recorded responses without calling the API or spending', async () => {
    const { send } = fakeSend(message(JSON.stringify(explanation)));
    const recorder = createProvider({
      ledger: createMemoryLedger(),
      mode: 'record',
      recordingsDir: dir,
      send,
    });
    const recorded = await recorder.generateObject(
      { ...request, schema: IssueExplanation },
      context,
    );
    expect(await readdir(dir)).toHaveLength(1);
    expect(recorded.recordedCostUsd).toBe(recorded.costUsd);

    const ledger = createMemoryLedger(1_000);
    const replayer = createProvider({ ledger, mode: 'replay', recordingsDir: dir, send });
    const result = await replayer.generateObject({ ...request, schema: IssueExplanation }, context);
    expect(result.value).toEqual(explanation);
    expect(result.costUsd).toBe(0);
    // Priced from the recorded tokens, so evals can report a comparable cost.
    expect(result.recordedCostUsd).toBe(recorded.costUsd);
    expect(result.recordedCostUsd).toBeGreaterThan(0);
    // Tokens are still recorded, at no cost, and the budget doesn't apply.
    expect(ledger.records).toMatchObject([{ inputTokens: 1_000, costUsd: 0 }]);
    expect(send).toHaveBeenCalledOnce();
  });

  it('records concurrent identical requests without the writes colliding', async () => {
    const { send } = fakeSend(message('hi'), message('hi'), message('hi'));
    const ledger = createMemoryLedger();
    const recorder = createProvider({ ledger, mode: 'record', recordingsDir: dir, send });
    await Promise.all([1, 2, 3].map(() => recorder.createMessage(request, context)));
    expect(await readdir(dir)).toHaveLength(1);
    expect(ledger.records).toHaveLength(3);
  });

  it('charges a recorded call even when saving the recording fails', async () => {
    const { send } = fakeSend(message('hi'));
    const ledger = createMemoryLedger();
    // A file where the directory should be makes the save fail.
    const blocked = join(dir, 'file');
    await writeFile(blocked, '');
    const recorder = createProvider({ ledger, mode: 'record', recordingsDir: blocked, send });
    await expect(recorder.createMessage(request, context)).rejects.toThrow();
    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0]!.costUsd).toBeGreaterThan(0);
  });

  it('fails a replay with no recording instead of calling the API', async () => {
    const { send } = fakeSend(message('hi'));
    const provider = createProvider({
      ledger: createMemoryLedger(),
      mode: 'replay',
      recordingsDir: dir,
      send,
    });
    await expect(provider.createMessage(request, context)).rejects.toThrow(ReplayMissError);
    expect(send).not.toHaveBeenCalled();
  });

  it('needs a recordings directory to record or replay', () => {
    vi.stubEnv('LLM_RECORDINGS_DIR', '');
    try {
      expect(() => createProvider({ ledger: createMemoryLedger(), mode: 'replay' })).toThrow(
        /recordings directory/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('defaults to replay outside production', () => {
    vi.stubEnv('LLM_MODE', '');
    vi.stubEnv('NODE_ENV', 'test');
    try {
      const provider = createProvider({ ledger: createMemoryLedger(), recordingsDir: dir });
      expect(provider.mode).toBe('replay');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
