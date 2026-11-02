// The LLM provider (#6). Every Claude call goes through here, so each one is
// checked against the monthly budget, charged to a run, and can be recorded
// or replayed. The interface is small so the provider stays swappable.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import {
  BudgetExceededError,
  OutputTruncatedError,
  RefusalError,
  StructuredOutputError,
} from './errors';
import type { UsageLedger } from './ledger';
import { costUsd, isKnownModel, type ModelId, type TokenUsage } from './pricing';
import { replaying, saveRecording, type LLMMode, type SendMessage } from './replay';

export interface LLMRequest {
  model: ModelId;
  /** Keep it stable: it's cached, and any change misses the cache. */
  system: string;
  messages: Anthropic.MessageParam[];
  /** Cached along with the system prompt. Keep the order stable. */
  tools?: Anthropic.Tool[];
  maxTokens?: number;
  effort?: Anthropic.OutputConfig['effort'];
}

export interface CallContext {
  /** The `agent_runs` row the call is charged to. */
  runId: string;
  signal?: AbortSignal;
}

export interface LLMResult {
  usage: TokenUsage;
  /** Zero in replay mode: nothing was spent. */
  costUsd: number;
}

export interface MessageResult extends LLMResult {
  message: Anthropic.Message;
}

export interface ObjectResult<T> extends LLMResult {
  value: T;
  /** 1, or 2 when the repair attempt was needed. Usage and cost cover both. */
  attempts: number;
}

export interface LLMProvider {
  readonly mode: LLMMode;
  createMessage(request: LLMRequest, context: CallContext): Promise<MessageResult>;
  /** A call whose output is JSON validated by `schema`, with one repair attempt. */
  generateObject<S extends z.ZodType>(
    request: Omit<LLMRequest, 'tools'> & { schema: S },
    context: CallContext,
  ): Promise<ObjectResult<z.infer<S>>>;
}

export interface ProviderOptions {
  ledger: UsageLedger;
  /** Default: `LLM_MODE`, else `live` in production and `replay` everywhere else. */
  mode?: LLMMode;
  /** Where recordings are saved and served from. Default: `LLM_RECORDINGS_DIR`. */
  recordingsDir?: string;
  /** Default: `LLM_MONTHLY_BUDGET_USD`, else 20. */
  monthlyBudgetUsd?: number;
  /**
   * Per attempt, until the response starts. Calls stream, so a long answer
   * isn't cut off by it. The SDK retries timeouts too.
   */
  timeoutMs?: number;
  /** SDK retries for 408, 409, 429, 5xx and connection errors. */
  maxRetries?: number;
  /** Replaces the Anthropic client in live and record modes. For tests. */
  send?: SendMessage;
}

const DEFAULT_MAX_TOKENS = 16_000;
const CACHED = { type: 'ephemeral' } as const;

function modeFromEnv(): LLMMode {
  const mode = process.env.LLM_MODE;
  if (!mode) return process.env.NODE_ENV === 'production' ? 'live' : 'replay';
  if (mode === 'live' || mode === 'record' || mode === 'replay') return mode;
  throw new Error(`LLM_MODE must be live, record, or replay, not ${mode}`);
}

function budgetFromEnv(): number {
  const raw = process.env.LLM_MONTHLY_BUDGET_USD;
  if (!raw) return 20;
  const budget = Number(raw);
  if (!Number.isFinite(budget) || budget < 0) {
    throw new Error(`LLM_MONTHLY_BUDGET_USD must be a non-negative number, not ${raw}`);
  }
  return budget;
}

/**
 * The request as sent. The system prompt and the last tool carry cache
 * breakpoints, so repeated calls pay the cache-read rate for them. Tools come
 * before the system prompt in the cached prefix.
 */
export function buildParams(
  request: LLMRequest,
  format?: Anthropic.JSONOutputFormat,
): Anthropic.MessageCreateParamsNonStreaming {
  const { model, system, messages, tools, maxTokens = DEFAULT_MAX_TOKENS, effort } = request;
  return {
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: CACHED }],
    messages,
    ...(tools?.length && {
      tools: tools.map((tool, i) =>
        i === tools.length - 1 ? { ...tool, cache_control: CACHED } : tool,
      ),
    }),
    ...((effort || format) && {
      output_config: { ...(effort && { effort }), ...(format && { format }) },
    }),
  };
}

function tokenUsage(usage: Anthropic.Usage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** Parses and validates model output, returning the value or what was wrong with it. */
function validate<S extends z.ZodType>(
  schema: S,
  text: string,
): { ok: true; value: z.infer<S> } | { ok: false; problem: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, problem: `Not valid JSON: ${(err as Error).message}` };
  }
  const result = schema.safeParse(json);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, problem: z.prettifyError(result.error) };
}

export function createProvider(options: ProviderOptions): LLMProvider {
  const { ledger } = options;
  const mode = options.mode ?? modeFromEnv();
  const budgetUsd = options.monthlyBudgetUsd ?? budgetFromEnv();
  const recordingsDir = options.recordingsDir ?? process.env.LLM_RECORDINGS_DIR;
  if (mode !== 'live' && !recordingsDir) {
    throw new Error(`LLM_MODE=${mode} needs a recordings directory (LLM_RECORDINGS_DIR)`);
  }

  let send: SendMessage;
  if (mode === 'replay') {
    // No client at all, so replay can't reach the API even by mistake.
    send = replaying(recordingsDir!);
  } else if (options.send) {
    send = options.send;
  } else {
    const client = new Anthropic({
      timeout: options.timeoutMs ?? 120_000,
      maxRetries: options.maxRetries ?? 2,
    });
    // Streaming, so the timeout only covers the wait for the response to
    // start and a long answer isn't abandoned after it's been paid for.
    send = (params, { signal }) => client.messages.stream(params, { signal }).finalMessage();
  }

  async function call(
    request: LLMRequest,
    context: CallContext,
    format?: Anthropic.JSONOutputFormat,
  ): Promise<MessageResult> {
    if (mode !== 'replay') {
      // Concurrent calls can each pass this check, so spend can overshoot by
      // the calls in flight. The Anthropic console spend limit is the backstop.
      const spentUsd = await ledger.monthToDateSpendUsd();
      if (spentUsd >= budgetUsd) throw new BudgetExceededError(spentUsd, budgetUsd);
    }
    const params = buildParams(request, format);
    // Checked before sending: a model with no price can't be charged afterwards.
    if (!isKnownModel(params.model)) throw new Error(`No pricing for model ${params.model}`);
    const message = await send(params, { signal: context.signal });
    const usage = tokenUsage(message.usage);
    const cost = mode === 'replay' ? 0 : costUsd(params.model, usage);
    await ledger.record({
      runId: context.runId,
      model: params.model,
      inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      costUsd: cost,
    });
    // Saved only after the call is charged, so a failed write can't hide its cost.
    if (mode === 'record') await saveRecording(recordingsDir!, params, message);
    if (message.stop_reason === 'refusal') {
      throw new RefusalError(
        `The model declined the request${message.stop_details?.category ? ` (${message.stop_details.category})` : ''}`,
      );
    }
    return { message, usage, costUsd: cost };
  }

  return {
    mode,

    createMessage: (request, context) => call(request, context),

    async generateObject({ schema, ...request }, context) {
      const format: Anthropic.JSONOutputFormat = {
        type: 'json_schema',
        schema: zodOutputFormat(schema).schema,
      };
      let messages = request.messages;
      let usage: TokenUsage | undefined;
      let cost = 0;
      for (let attempt = 1; ; attempt++) {
        const result = await call({ ...request, messages }, context, format);
        usage = usage ? addUsage(usage, result.usage) : result.usage;
        cost += result.costUsd;
        // Repairing a cut-off answer under the same limit would be cut off again.
        if (result.message.stop_reason === 'max_tokens') {
          throw new OutputTruncatedError(request.maxTokens ?? DEFAULT_MAX_TOKENS);
        }
        const text = result.message.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('');
        const checked = validate(schema, text);
        if (checked.ok) return { value: checked.value, usage, costUsd: cost, attempts: attempt };
        if (attempt === 2) throw new StructuredOutputError(text, checked.problem);
        // The JSON schema sent to the API can't express every Zod rule
        // (refinements, some bounds), so show the model what failed once.
        messages = [
          ...messages,
          { role: 'assistant', content: result.message.content },
          {
            role: 'user',
            content: `That output failed validation:\n${checked.problem}\n\nReply with the corrected JSON only.`,
          },
        ];
      }
    },
  };
}
