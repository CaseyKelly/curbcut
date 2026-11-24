// proposeFix v0 (#9): one issue, one file, one `PatchProposal`. The eval
// runner calls it directly, and in M3 the agent's `propose_patch` tool will
// too. It needs only an `LLMProvider`: no database, worker or web app, so a
// memory ledger is enough to run it.
import { PatchProposal, RelativePath } from '@curbcut/core';
import { applyPatch, createPatch } from 'diff';
import type { CallContext, LLMProvider } from './llm/provider';
import type { TokenUsage } from './llm/pricing';
import {
  FIX_MODEL,
  FIX_PROMPT_VERSION,
  FIX_SYSTEM,
  applyEdits,
  fixInput,
  fixMessage,
  fixOutputFor,
  type FixableFile,
  type FixableIssue,
} from './prompts/fix';

/** Room for a long answer with several edits, without letting a runaway one cost much. */
const MAX_TOKENS = 8_000;
/** About 15k tokens. A component bigger than this is out of scope for a single-file fix. */
export const MAX_FIX_FILE_CHARS = 60_000;

/**
 * Files whose contents must never reach a prompt. A stopgap until the secret
 * scanner arrives with repo mode (#21), which also scans file contents.
 */
const DENYLIST = [
  // Every .env-prefixed name: .env, .env.local, .env-production, .envrc.
  /(^|\/)\.env[^/]*$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|crt|cer|der|jks|keystore)$/i,
];

/** The file can't be sent to the model. Nothing was called or charged. */
export class FixInputError extends Error {
  override name = 'FixInputError';
}

export interface ProposeFixResult {
  proposal: PatchProposal;
  usage: TokenUsage;
  /** Zero in replay mode. */
  costUsd: number;
  /** Priced from the tokens even in replay mode, so evals can compare runs. */
  recordedCostUsd: number;
  /** 2 when the provider's repair attempt was needed. */
  attempts: number;
  model: string;
  promptVersion: string;
}

function checkFile({ path, content }: FixableFile): void {
  const parsed = RelativePath.safeParse(path);
  if (!parsed.success) throw new FixInputError(`File path ${JSON.stringify(path)} is not relative`);
  const normalized = path.replaceAll('\\', '/');
  if (DENYLIST.some((re) => re.test(normalized))) {
    throw new FixInputError(`${path} may hold secrets, so it is never sent to the model`);
  }
  if (content.length > MAX_FIX_FILE_CHARS) {
    throw new FixInputError(
      `${path} is ${content.length} characters; the limit is ${MAX_FIX_FILE_CHARS}`,
    );
  }
}

/**
 * Asks the model to fix `issue` in `file`. Returns a `fix` with a unified
 * diff that applies cleanly to `file.content`, or `no_change_needed`, or
 * `unsure` with a question for the reviewer.
 *
 * Throws `FixInputError` for a file it won't send, and the provider's errors
 * (budget, refusal, a structured output that still fails after one repair).
 */
export async function proposeFix(
  { provider }: { provider: LLMProvider },
  file: FixableFile,
  issue: FixableIssue,
  context: CallContext,
): Promise<ProposeFixResult> {
  checkFile(file);
  const input = fixInput(file.path, issue);
  const result = await provider.generateObject(
    {
      model: FIX_MODEL,
      system: FIX_SYSTEM,
      messages: [{ role: 'user', content: fixMessage(input, file.content) }],
      schema: fixOutputFor(file.content),
      maxTokens: MAX_TOKENS,
    },
    context,
  );
  const out = result.value;
  const { explanation, confidence } = out;

  let proposal: PatchProposal;
  if (out.outcome === 'fix') {
    // The schema already checked the edits apply, so this can't fail.
    const applied = applyEdits(file.content, out.edits);
    if (!applied.ok) throw new Error(`Validated edits failed to apply: ${applied.problem}`);
    const diff = createPatch(file.path, file.content, applied.text);
    // A diff we built ourselves must round-trip; if it doesn't, that's our bug.
    if (applyPatch(file.content, diff) !== applied.text) {
      throw new Error(`The diff for ${file.path} does not reproduce the edited file`);
    }
    proposal = { outcome: 'fix', filePath: file.path, diff, explanation, confidence };
  } else if (out.outcome === 'unsure') {
    proposal = { outcome: 'unsure', question: out.question, explanation, confidence };
  } else {
    proposal = { outcome: 'no_change_needed', explanation, confidence };
  }

  return {
    // Parsed so a contract change in core fails here, not in a consumer.
    proposal: PatchProposal.parse(proposal),
    usage: result.usage,
    costUsd: result.costUsd,
    recordedCostUsd: result.recordedCostUsd,
    attempts: result.attempts,
    model: FIX_MODEL,
    promptVersion: FIX_PROMPT_VERSION,
  };
}
