import { createHash } from 'node:crypto';
import { IssueExplanation } from '@curbcut/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  EXPLAIN_MODEL,
  EXPLAIN_PROMPT_VERSION,
  EXPLAIN_SYSTEM,
  explainCacheKey,
  explainInput,
  explainMessage,
  type ExplainableIssue,
} from './explain';

const issue = (overrides: Partial<ExplainableIssue> = {}): ExplainableIssue => ({
  ruleId: 'image-alt',
  help: 'Images must have alternative text',
  wcag: ['1.1.1'],
  html: '<img src="/a.png">',
  ...overrides,
});

describe('prompt version', () => {
  // If this fails you changed the prompt text, the message layout, or
  // `IssueExplanation` (cached rows must still parse as it). Bump
  // EXPLAIN_PROMPT_VERSION, then replace the pinned hash with the new one.
  const PINNED: Record<string, string> = {
    'explain-v1': 'db230e161c74cd1ea26bcdadd2f04db9753195f4cce8f595ebcd07609cf528d7',
  };

  it('is bumped whenever the prompt changes', () => {
    const text = [
      EXPLAIN_SYSTEM,
      explainMessage(explainInput([issue()])),
      JSON.stringify(z.toJSONSchema(IssueExplanation)),
    ].join('\n----\n');
    const hash = createHash('sha256').update(text).digest('hex');
    expect(PINNED[EXPLAIN_PROMPT_VERSION]).toBe(hash);
  });
});

describe('explainInput', () => {
  it('takes the rule from the issues and sorts the criteria', () => {
    const input = explainInput([issue({ wcag: ['4.1.2', '1.1.1'] })]);
    expect(input).toMatchObject({
      ruleId: 'image-alt',
      help: 'Images must have alternative text',
      wcag: ['1.1.1', '4.1.2'],
    });
  });

  it('rejects an empty group', () => {
    expect(() => explainInput([])).toThrow('empty group');
  });

  it('sends distinct samples, at most three', () => {
    const issues = [
      ...['d', 'a', 'a', 'c', 'b'].map((x) => issue({ html: `<img src="${x}.png">` })),
    ];
    const { samples } = explainInput(issues);
    expect(samples.map((s) => s.html)).toEqual([
      '<img src="a.png">',
      '<img src="b.png">',
      '<img src="c.png">',
    ]);
  });

  it('keeps the failure summary, which carries details like contrast colors', () => {
    const { samples } = explainInput([
      issue({ html: '<p>x</p>', failureSummary: 'Fix any of the following:\n contrast 2.1:1' }),
      issue({ html: '<p>x</p>', failureSummary: null }),
    ]);
    expect(samples).toHaveLength(2);
    expect(samples.some((s) => s.failureSummary?.includes('2.1:1'))).toBe(true);
  });

  it('caps long fields', () => {
    const [sample] = explainInput([issue({ html: `<div>${'x'.repeat(50_000)}</div>` })]).samples;
    expect(sample!.html.length).toBeLessThanOrEqual(2_001);
  });
});

describe('redaction in samples', () => {
  it('applies to the HTML and the failure summary', () => {
    const { samples } = explainInput([
      issue({
        html: '<input type="password" value="s3cret-pass">',
        failureSummary: 'Fix: <input type="hidden" value="s3cret-token">',
      }),
    ]);
    expect(JSON.stringify(samples)).not.toContain('s3cret');
  });

  it('blanks a value whose type is cut off by the length cap', () => {
    const html = `<input value="hunter2-planted" data-x="${'x'.repeat(25_000)}" type="password">`;
    const [sample] = explainInput([issue({ html })]).samples;
    expect(sample!.html).not.toContain('hunter2-planted');
  });
});

describe('explainCacheKey', () => {
  const key = (issues: ExplainableIssue[], version?: string, model?: string) =>
    explainCacheKey(explainInput(issues), version, model);

  it('ignores the order issues appear in and repeats', () => {
    const a = issue({ html: '<img src="a.png">' });
    const b = issue({ html: '<img src="b.png">' });
    expect(key([a, b])).toBe(key([b, a, a]));
  });

  it('changes with the rule, the HTML, the prompt version, and the model', () => {
    const base = key([issue()]);
    expect(key([issue({ ruleId: 'input-image-alt' })])).not.toBe(base);
    expect(key([issue({ html: '<img src="other.png">' })])).not.toBe(base);
    expect(key([issue({ failureSummary: 'something else' })])).not.toBe(base);
    expect(key([issue()], 'explain-v2')).not.toBe(base);
    expect(key([issue()], EXPLAIN_PROMPT_VERSION, 'claude-sonnet-5-5')).not.toBe(base);
    expect(key([issue()], EXPLAIN_PROMPT_VERSION, EXPLAIN_MODEL)).toBe(base);
  });
});
