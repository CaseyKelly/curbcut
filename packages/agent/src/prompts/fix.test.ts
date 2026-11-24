import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  FIX_PROMPT_VERSION,
  FIX_SYSTEM,
  FixOutput,
  applyEdits,
  fixInput,
  fixMessage,
  fixOutputFor,
  type FixableIssue,
  type FixOutput as FixOutputType,
} from './fix';

const issue = (overrides: Partial<FixableIssue> = {}): FixableIssue => ({
  ruleId: 'image-alt',
  help: 'Images must have alternative text',
  wcag: ['1.1.1'],
  selector: 'img',
  html: '<img src="/a.png">',
  ...overrides,
});

/**
 * Every message `fixOutputFor` can send back to the model on the repair
 * attempt, one per failing branch, so rewording one changes the hash too.
 */
function retryMessages(): string[] {
  const content = 'a\nb b\n';
  const schema = fixOutputFor(content);
  const base: FixOutputType = {
    outcome: 'fix',
    edits: [{ find: 'a', replace: 'A' }],
    question: '',
    explanation: 'e',
    confidence: 0.5,
  };
  const failing: Partial<FixOutputType>[] = [
    { outcome: 'unsure', edits: [], question: '' },
    { question: 'Why?' },
    { outcome: 'no_change_needed' },
    { edits: [] },
    { edits: [{ find: '', replace: 'x' }] },
    { edits: [{ find: 'zzz', replace: 'x' }] },
    {
      edits: [
        { find: 'a', replace: 'A' },
        { find: 'zzz', replace: 'x' },
      ],
    },
    { edits: [{ find: 'b', replace: 'x' }] },
    { edits: [{ find: 'a', replace: 'a' }] },
  ];
  return failing.map((o) => {
    const r = schema.safeParse({ ...base, ...o });
    if (r.success) throw new Error(`expected ${JSON.stringify(o)} to fail`);
    return z.prettifyError(r.error);
  });
}

describe('prompt version', () => {
  // If this fails you changed the prompt text, the message layout,
  // `FixOutput`, or a message the model gets back on a retry. Bump
  // FIX_PROMPT_VERSION, then replace the pinned hash.
  const PINNED: Record<string, string> = {
    'fix-v1': '5ccbb7317096e8533ae45960733e7fbaa101e70715882935d835c9e0733d5fd5',
  };

  it('is bumped whenever the prompt changes', () => {
    const text = [
      FIX_SYSTEM,
      fixMessage(fixInput('Hero.tsx', issue()), 'export const A = 1;'),
      JSON.stringify(z.toJSONSchema(FixOutput)),
      ...retryMessages(),
    ].join('\n----\n');
    const hash = createHash('sha256').update(text).digest('hex');
    expect(PINNED[FIX_PROMPT_VERSION]).toBe(hash);
  });
});

describe('fixInput', () => {
  it('sorts the criteria and drops a missing failure summary', () => {
    const input = fixInput('Hero.tsx', issue({ wcag: ['4.1.2', '1.1.1'], failureSummary: null }));
    expect(input).toEqual({
      filePath: 'Hero.tsx',
      issue: {
        ruleId: 'image-alt',
        help: 'Images must have alternative text',
        wcag: ['1.1.1', '4.1.2'],
        selector: 'img',
        html: '<img src="/a.png">',
      },
    });
  });

  it('redacts secrets in the page HTML and failure summary', () => {
    const input = fixInput(
      'Login.tsx',
      issue({
        html: '<input type="password" value="s3cret-pass">',
        failureSummary: 'Fix: <input type="hidden" value="s3cret-token">',
      }),
    );
    expect(JSON.stringify(input)).not.toContain('s3cret');
  });

  it('caps long fields', () => {
    const { issue: i } = fixInput('A.tsx', issue({ html: `<div>${'x'.repeat(50_000)}</div>` }));
    expect(i.html.length).toBeLessThanOrEqual(2_001);
  });
});

describe('fixMessage', () => {
  it('sends the file verbatim, not JSON-escaped', () => {
    const content = 'const s = "a\\nb";\n\texport default s;\n';
    expect(fixMessage(fixInput('A.tsx', issue()), content)).toContain(
      `<<<FILE\n${content}\nFILE>>>`,
    );
  });
});

describe('applyEdits', () => {
  const file = 'one\ntwo\nthree\n';

  it('applies edits in order, each to the text the earlier ones left', () => {
    const r = applyEdits(file, [
      { find: 'two', replace: 'TWO' },
      { find: 'TWO\nthree', replace: 'TWO\n3' },
    ]);
    expect(r).toEqual({ ok: true, text: 'one\nTWO\n3\n' });
  });

  it('rejects a find that is missing, repeated, or empty', () => {
    expect(applyEdits(file, [{ find: 'four', replace: '4' }])).toMatchObject({
      ok: false,
      problem: expect.stringContaining('does not appear') as string,
    });
    expect(applyEdits('a a', [{ find: 'a', replace: 'b' }])).toMatchObject({
      ok: false,
      problem: expect.stringContaining('more than once') as string,
    });
    expect(applyEdits(file, [{ find: '', replace: 'x' }])).toMatchObject({ ok: false });
  });
});

describe('fixOutputFor', () => {
  const content = '<img src="/a.png" />\n';
  const schema = fixOutputFor(content);
  const out = (o: Partial<FixOutputType>): FixOutputType => ({
    outcome: 'fix',
    edits: [{ find: '<img ', replace: '<img alt="" ' }],
    question: '',
    explanation: 'Marked the image decorative.',
    confidence: 0.8,
    ...o,
  });
  const problems = (o: Partial<FixOutputType>) => {
    const r = schema.safeParse(out(o));
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it('accepts a fix whose edits apply and change the file', () => {
    expect(problems({})).toEqual([]);
  });

  it('accepts no_change_needed and unsure without edits', () => {
    expect(problems({ outcome: 'no_change_needed', edits: [] })).toEqual([]);
    expect(problems({ outcome: 'unsure', edits: [], question: 'What does it show?' })).toEqual([]);
  });

  it('sends back edits that do not match the file, so the model gets one retry', () => {
    expect(problems({ edits: [{ find: '<image', replace: 'x' }] })).toEqual([
      expect.stringContaining('does not appear'),
    ]);
  });

  it('rejects a fix that changes nothing or has no edits', () => {
    expect(problems({ edits: [{ find: '<img ', replace: '<img ' }] })).toEqual([
      expect.stringContaining('no_change_needed'),
    ]);
    expect(problems({ edits: [] })).toEqual([expect.stringContaining('at least one edit')]);
  });

  it('keeps edits and questions to the outcomes that have them', () => {
    expect(problems({ outcome: 'no_change_needed' })).toEqual([
      expect.stringContaining('has no edits'),
    ]);
    expect(problems({ outcome: 'unsure', edits: [], question: ' ' })).toEqual([
      expect.stringContaining('must ask'),
    ]);
    expect(problems({ question: 'Why?' })).toEqual([expect.stringContaining('only an "unsure"')]);
  });
});
