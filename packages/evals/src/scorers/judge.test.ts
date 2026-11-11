import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LLMProvider } from '@curbcut/agent';
import { JudgeVerdict } from '@curbcut/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateDataset } from '../dataset/dataset';
import {
  JUDGE_MODEL,
  JUDGE_PROMPT_VERSION,
  JUDGE_SYSTEM,
  judgeFix,
  judgeInput,
  judgeMessage,
  type JudgeInput,
} from './judge';

const { cases } = validateDataset(
  join(fileURLToPath(new URL('../../', import.meta.url)), 'dataset'),
);
const c = cases.find((x) => x.case.id === 'image-alt-product-photo')!.case;

describe('prompt version', () => {
  // If this fails you changed the rubric, the message layout, or
  // `JudgeVerdict`. Bump JUDGE_PROMPT_VERSION, then replace the pinned hash.
  const PINNED: Record<string, string> = {
    'judge-v1': 'e555546e7de556762a2ae2485a73463960e1d82880bb51c1515fb42c050b6b64',
  };

  it('is bumped whenever the prompt changes', () => {
    // A fixed input, so editing a dataset case doesn't look like a prompt change.
    const sample: JudgeInput = {
      issue: { ruleId: 'image-alt', help: 'h', html: '<img>', failureSummary: 'f' },
      filePath: 'A.tsx',
      source: 'source',
      diff: 'diff',
      explanation: 'e',
      referenceDiff: 'ref',
    };
    const text = [
      JUDGE_SYSTEM,
      judgeMessage(sample),
      JSON.stringify(z.toJSONSchema(JudgeVerdict)),
    ].join('\n----\n');
    const hash = createHash('sha256').update(text).digest('hex');
    expect(PINNED[JUDGE_PROMPT_VERSION]).toBe(hash);
  });
});

describe('judgeInput', () => {
  it('takes the issue from the case and leaves out what it was not given', () => {
    const input = judgeInput(c, 'src', 'diff');
    expect(input).toEqual({
      issue: {
        ruleId: 'image-alt',
        help: c.issue.help,
        html: c.issue.html,
        ...(c.issue.failureSummary && { failureSummary: c.issue.failureSummary }),
      },
      filePath: 'PlantTile.tsx',
      source: 'src',
      diff: 'diff',
    });
  });

  it('includes the explanation and reference diff when given', () => {
    expect(judgeInput(c, 's', 'd', { explanation: 'why', referenceDiff: 'ref' })).toMatchObject({
      explanation: 'why',
      referenceDiff: 'ref',
    });
  });
});

describe('judgeFix', () => {
  it('asks Haiku for a JudgeVerdict and stamps it with the versions', async () => {
    const requests: unknown[] = [];
    const provider = {
      mode: 'replay',
      createMessage: () => Promise.reject(new Error('unused')),
      generateObject: (request: unknown) => {
        requests.push(request);
        return Promise.resolve({
          value: { score: 4, reason: 'Minimal and correct.' },
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0,
          recordedCostUsd: 0.0002,
          attempts: 1,
        });
      },
    } as unknown as LLMProvider;

    const result = await judgeFix(provider, judgeInput(c, 's', 'd'), { runId: 'r' });
    expect(result).toEqual({
      judgement: {
        score: 4,
        reason: 'Minimal and correct.',
        model: JUDGE_MODEL,
        promptVersion: JUDGE_PROMPT_VERSION,
      },
      costUsd: 0,
      recordedCostUsd: 0.0002,
    });
    expect(requests[0]).toMatchObject({ model: 'claude-haiku-5-5', schema: JudgeVerdict });
  });
});
