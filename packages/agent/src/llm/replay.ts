// Record and replay (#6). `record` calls the API and saves each response under
// a hash of its request; `replay` serves saved responses and never touches the
// network, so tests and local UI work cost $0 and are deterministic.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { ReplayMissError } from './errors';

export type LLMMode = 'live' | 'record' | 'replay';

/** The one API call the provider makes. The Anthropic client in live use, a stub in tests. */
export type SendMessage = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  options: { signal?: AbortSignal },
) => Promise<Anthropic.Message>;

/** A saved request and its response, one JSON file per request. */
interface Recording {
  request: Anthropic.MessageCreateParamsNonStreaming;
  response: Anthropic.Message;
}

/** JSON with object keys sorted, so equal requests always hash the same. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export function requestKey(params: Anthropic.MessageCreateParamsNonStreaming): string {
  return createHash('sha256').update(stableStringify(params)).digest('hex').slice(0, 32);
}

/** Saves a response for `replaying` to serve. */
export async function saveRecording(
  dir: string,
  request: Anthropic.MessageCreateParamsNonStreaming,
  response: Anthropic.Message,
): Promise<void> {
  const recorded: Recording = { request, response };
  await mkdir(dir, { recursive: true });
  // Write then rename, so a crash can't leave a half-written recording behind.
  // The temp name is unique, so concurrent identical requests don't collide.
  const path = join(dir, `${requestKey(request)}.json`);
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(recorded, null, 2)}\n`);
  await rename(tmp, path);
}

/** Serves responses saved by `saveRecording`. A request with no recording throws `ReplayMissError`. */
export function replaying(dir: string): SendMessage {
  return async (params) => {
    const key = requestKey(params);
    let text: string;
    try {
      text = await readFile(join(dir, `${key}.json`), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ReplayMissError(key);
      throw err;
    }
    return (JSON.parse(text) as Recording).response;
  };
}
