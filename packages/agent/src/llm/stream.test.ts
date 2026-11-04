// The real SDK streaming path, against a local server that speaks SSE. No
// live API calls: the client is pointed at localhost with a fake key.
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CallTimeoutError } from './errors';
import { createMemoryLedger } from './ledger';
import { MODELS } from './pricing';
import { createProvider, type ProviderOptions } from './provider';

type Handler = (res: ServerResponse) => Promise<void>;

function sse(res: ServerResponse, type: string, data: object) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

const start = (res: ServerResponse) =>
  sse(res, 'message_start', {
    message: {
      id: 'msg_local',
      type: 'message',
      role: 'assistant',
      model: MODELS.haiku,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 1_000,
        output_tokens: 1,
        cache_read_input_tokens: 4_000,
        cache_creation_input_tokens: 0,
      },
    },
  });

function finish(res: ServerResponse, text: string) {
  sse(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  sse(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  sse(res, 'content_block_stop', { index: 0 });
  sse(res, 'message_delta', {
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 200 },
  });
  sse(res, 'message_stop', {});
  res.end();
}

describe('streaming through the real client', () => {
  let server: Server;
  let handler: Handler;
  let requests = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests++;
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      handler(res).catch(() => res.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    vi.stubEnv('ANTHROPIC_BASE_URL', `http://127.0.0.1:${port}`);
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  function provider(options: Partial<ProviderOptions> = {}) {
    const ledger = createMemoryLedger();
    return { ledger, llm: createProvider({ ledger, mode: 'live', maxRetries: 0, ...options }) };
  }

  const request = {
    model: MODELS.haiku,
    system: 'Say hi.',
    messages: [{ role: 'user' as const, content: 'hi' }],
  };
  const context = { runId: 'run-1' };

  it('charges usage from the whole answer, cached tokens included', async () => {
    handler = (res) => {
      start(res);
      finish(res, 'hi');
      return Promise.resolve();
    };
    const { llm, ledger } = provider();
    const result = await llm.createMessage(request, context);
    expect(result.message.content).toMatchObject([{ type: 'text', text: 'hi' }]);
    expect(result.usage).toEqual({
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 4_000,
      cacheWriteTokens: 0,
    });
    expect(ledger.records).toMatchObject([{ inputTokens: 5_000, outputTokens: 200 }]);
  });

  it('lets an answer that has started run past the response timeout', async () => {
    handler = async (res) => {
      start(res);
      await sleep(600);
      finish(res, 'slow');
    };
    const { llm, ledger } = provider({ timeoutMs: 200 });
    const result = await llm.createMessage(request, context);
    expect(result.message.content).toMatchObject([{ type: 'text', text: 'slow' }]);
    expect(ledger.records).toHaveLength(1);
  });

  it('ends a stream that stalls after it starts', async () => {
    handler = async (res) => {
      start(res);
      await sleep(10_000);
    };
    const before = requests;
    const { llm, ledger } = provider({ callTimeoutMs: 300 });
    await expect(llm.createMessage(request, context)).rejects.toThrow(CallTimeoutError);
    expect(requests - before).toBe(1);
    expect(ledger.records).toHaveLength(0);
  });

  it('reports a caller abort as an abort, not a timeout', async () => {
    handler = async (res) => {
      start(res);
      await sleep(10_000);
    };
    const { llm } = provider({ callTimeoutMs: 5_000 });
    const err: unknown = await llm
      .createMessage(request, { ...context, signal: AbortSignal.timeout(200) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CallTimeoutError);
  });
});
