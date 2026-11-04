import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EXPLAIN_MODEL,
  EXPLAIN_PROMPT_VERSION,
  EXPLAIN_SYSTEM,
  explainCacheKey,
  explainInput,
  explainMessage,
  redactInputValues,
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
  // If this fails you changed the prompt text or the message layout. Bump
  // EXPLAIN_PROMPT_VERSION, then replace the pinned hash with the new one.
  const PINNED: Record<string, string> = {
    'explain-v1': '4105a6018536fe16bd3d2f64912f943c93f7ab84d0ec69c1b52e6351b89636ab',
  };

  it('is bumped whenever the prompt changes', () => {
    const text = [EXPLAIN_SYSTEM, explainMessage(explainInput([issue()]))].join('\n----\n');
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

describe('redactInputValues', () => {
  it.each([
    ['<input type="password" value="hunter2">'],
    ['<input value="hunter2" type="password">'],
    ["<input type='hidden' name='csrf' value='hunter2'>"],
    ['<input type=hidden value=hunter2>'],
    ['<input TYPE="Password" VALUE="hunter2" />'],
    ['<input type="hidden" value="a>hunter2">'],
    // axe cuts long HTML off, so the tag may never close.
    ['<input type="password" value="hunter2'],
  ])('blanks the value in %s', (html) => {
    const out = redactInputValues(html);
    expect(out).not.toContain('hunter2');
    expect(out).toContain('value=""');
  });

  it('leaves other inputs and other attributes alone', () => {
    const html = '<input type="text" value="Casey"><input type="password" name="pw">';
    expect(redactInputValues(html)).toBe(html);
  });

  it('only touches input tags', () => {
    const html = '<button type="hidden" value="x">Go</button>';
    expect(redactInputValues(html)).toBe(html);
  });

  it('applies to samples, including the failure summary', () => {
    const { samples } = explainInput([
      issue({
        html: '<input type="password" value="s3cret-pass">',
        failureSummary: 'Fix: <input type="hidden" value="s3cret-token">',
      }),
    ]);
    expect(JSON.stringify(samples)).not.toContain('s3cret');
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
