import { readFileSync } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import { EvalCase } from '@curbcut/core';
import { applyPatch, parsePatch } from 'diff';
import { describe, expect, it, vi } from 'vitest';
import { FixInputError, MAX_FIX_FILE_CHARS, proposeFix } from './fix';
import { StructuredOutputError } from './llm/errors';
import { createMemoryLedger } from './llm/ledger';
import { MODELS } from './llm/pricing';
import { createProvider } from './llm/provider';
import type { SendMessage } from './llm/replay';
import { FIX_PROMPT_VERSION, type FixOutput } from './prompts/fix';

/** A fix case from the eval dataset: the runner is the first caller (#9). */
const caseDir = new URL('../../evals/dataset/cases/area-alt-store-map/', import.meta.url);
const evalCase = EvalCase.parse(JSON.parse(readFileSync(new URL('case.json', caseDir), 'utf8')));
const input = readFileSync(new URL(`input/${evalCase.filePath}`, caseDir), 'utf8');
const expected = readFileSync(new URL(`expected/${evalCase.filePath}`, caseDir), 'utf8');
const file = { path: evalCase.filePath, content: input };

function reply(out: FixOutput | string): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: MODELS.sonnet,
    content: [
      { type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out), citations: null },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    container: null,
    usage: { input_tokens: 2_000, output_tokens: 300 },
  } as Anthropic.Message;
}

/** A provider in live mode whose API is a stub that answers with `outputs` in order. */
function setup(...outputs: (FixOutput | string)[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const send = vi.fn<SendMessage>((params) => {
    requests.push(params);
    const next = outputs.shift();
    return next === undefined
      ? Promise.reject(new Error('no more responses'))
      : Promise.resolve(reply(next));
  });
  const ledger = createMemoryLedger();
  const provider = createProvider({ ledger, mode: 'live', send, monthlyBudgetUsd: 5 });
  return { provider, requests, ledger };
}

const context = { runId: 'eval-run' };

const fixAlt: FixOutput = {
  outcome: 'fix',
  edits: [
    {
      find: 'href="/departments/garden-tools" />',
      replace: 'href="/departments/garden-tools" alt="Garden tools" />',
    },
  ],
  question: '',
  explanation: 'Gave the area the name of the department it links to.',
  confidence: 0.9,
};

describe('proposeFix', () => {
  it('turns edits into a unified diff that applies cleanly to the input', async () => {
    const { provider, requests, ledger } = setup(fixAlt);
    const r = await proposeFix({ provider }, file, evalCase.issue, context);

    expect(r.proposal).toMatchObject({ outcome: 'fix', filePath: 'StoreMap.tsx', confidence: 0.9 });
    if (r.proposal.outcome !== 'fix') throw new Error('expected a fix');
    const [patch] = parsePatch(r.proposal.diff);
    expect(patch).toMatchObject({ oldFileName: 'StoreMap.tsx', newFileName: 'StoreMap.tsx' });
    expect(applyPatch(input, r.proposal.diff)).toBe(expected);

    expect(r).toMatchObject({
      attempts: 1,
      model: MODELS.sonnet,
      promptVersion: FIX_PROMPT_VERSION,
    });
    expect(r.costUsd).toBeGreaterThan(0);
    expect(ledger.records).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: MODELS.sonnet });
    expect(JSON.stringify(requests[0]!.messages)).toContain('coords=\\"200,0,400,300\\"');
  });

  it('returns no_change_needed and unsure without a diff', async () => {
    const noChange = setup({
      outcome: 'no_change_needed',
      edits: [],
      question: '',
      explanation: 'The area already has alt text.',
      confidence: 0.7,
    });
    expect((await proposeFix(noChange, file, evalCase.issue, context)).proposal).toEqual({
      outcome: 'no_change_needed',
      explanation: 'The area already has alt text.',
      confidence: 0.7,
    });

    const unsure = setup({
      outcome: 'unsure',
      edits: [],
      question: 'What is in the right half of the map?',
      explanation: 'The link target alone may not name the area.',
      confidence: 0.4,
    });
    expect((await proposeFix(unsure, file, evalCase.issue, context)).proposal).toEqual({
      outcome: 'unsure',
      question: 'What is in the right half of the map?',
      explanation: 'The link target alone may not name the area.',
      confidence: 0.4,
    });
  });

  it('gives the model one retry when an edit does not match the file', async () => {
    const wrong = { ...fixAlt, edits: [{ find: '<area href="/garden"', replace: 'x' }] };
    const { provider, requests } = setup(wrong, fixAlt);
    const r = await proposeFix({ provider }, file, evalCase.issue, context);
    expect(r.attempts).toBe(2);
    expect(r.proposal.outcome).toBe('fix');
    expect(JSON.stringify(requests[1]!.messages.at(-1))).toContain('does not appear in the file');
  });

  it('throws when the edits still do not apply after the retry', async () => {
    const wrong = { ...fixAlt, edits: [{ find: 'nowhere', replace: 'x' }] };
    const { provider } = setup(wrong, wrong);
    await expect(proposeFix({ provider }, file, evalCase.issue, context)).rejects.toBeInstanceOf(
      StructuredOutputError,
    );
  });

  it('refuses files that may hold secrets, bad paths, and huge files without calling the model', async () => {
    const { provider, requests } = setup();
    const refuse = (path: string, content = 'x') =>
      expect(proposeFix({ provider }, { path, content }, evalCase.issue, context)).rejects.toThrow(
        FixInputError,
      );
    await refuse('.env');
    await refuse('config/.env.local');
    await refuse('.envrc');
    await refuse('deploy/.env-production');
    await refuse('certs/server.pem');
    await refuse('../outside.tsx');
    await refuse('/abs/App.tsx');
    await refuse('App.tsx', 'x'.repeat(MAX_FIX_FILE_CHARS + 1));
    expect(requests).toHaveLength(0);
  });

  it('keeps a file without a trailing newline intact', async () => {
    const content = 'export const A = () => <img src="/a.png" />;';
    const { provider } = setup({
      ...fixAlt,
      edits: [{ find: '<img ', replace: '<img alt="" ' }],
    });
    const r = await proposeFix({ provider }, { path: 'A.tsx', content }, evalCase.issue, context);
    if (r.proposal.outcome !== 'fix') throw new Error('expected a fix');
    expect(applyPatch(content, r.proposal.diff)).toBe(
      'export const A = () => <img alt="" src="/a.png" />;',
    );
  });
});
