import { describe, expect, it } from 'vitest';
import {
  fingerprint,
  formatTarget,
  toA11yIssues,
  wcagCriteria,
  type AxeResults,
} from './normalize';

describe('wcagCriteria', () => {
  it('parses criterion tags and skips level and other tags', () => {
    expect(
      wcagCriteria(['cat.text-alternatives', 'wcag2a', 'wcag111', 'wcag21aa', 'section508']),
    ).toEqual(['1.1.1']);
    expect(wcagCriteria(['wcag143', 'wcag1411', 'wcag2411', 'wcag412'])).toEqual([
      '1.4.3',
      '1.4.11',
      '2.4.11',
      '4.1.2',
    ]);
  });
});

describe('formatTarget', () => {
  it('joins frames and shadow roots', () => {
    expect(formatTarget(['img.hero'])).toBe('img.hero');
    expect(formatTarget(['iframe', 'button'])).toBe('iframe |> button');
    expect(formatTarget([['my-el', 'button']])).toBe('my-el >>> button');
  });
});

describe('fingerprint', () => {
  it('is stable when only position or whitespace changes', () => {
    const a = fingerprint('image-alt', 'ul > li:nth-child(2) > img', '<img  src="a.png">');
    const b = fingerprint('image-alt', 'ul > li:nth-child(5) > img', '<img src="a.png">');
    expect(a).toBe(b);
  });

  it('ignores React useId values in id selectors and id attributes', () => {
    expect(fingerprint('label', '#\\:r1\\:', '<input id=":r1:">')).toBe(
      fingerprint('label', '#\\:r7\\:', '<input id=":r7:">'),
    );
    expect(
      fingerprint(
        'aria-valid-attr-value',
        '[aria-labelledby="_r_2_"]',
        '<div aria-labelledby="_r_2_ title">',
      ),
    ).toBe(
      fingerprint(
        'aria-valid-attr-value',
        '[aria-labelledby="_r_9_"]',
        '<div aria-labelledby="_r_9_ title">',
      ),
    );
  });

  it('keeps class names that only look like useId values', () => {
    expect(fingerprint('button-name', '.btn_r_2_', '<button class="btn_r_2_">')).not.toBe(
      fingerprint('button-name', '.btn_r_3_', '<button class="btn_r_3_">'),
    );
  });

  it('differs by rule and by element', () => {
    const base = fingerprint('image-alt', 'img.hero', '<img class="hero">');
    expect(fingerprint('role-img-alt', 'img.hero', '<img class="hero">')).not.toBe(base);
    expect(fingerprint('image-alt', 'img.logo', '<img class="logo">')).not.toBe(base);
  });
});

function results(nodes: { target: string[]; html: string }[]): AxeResults {
  return {
    violations: [
      {
        id: 'button-name',
        impact: 'critical',
        tags: ['cat.name-role-value', 'wcag2a', 'wcag412'],
        description: 'Ensure buttons have discernible text',
        help: 'Buttons must have discernible text',
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.11/button-name?application=axeAPI',
        nodes: nodes.map((n) => ({
          ...n,
          impact: 'critical',
          any: [],
          all: [],
          none: [],
          failureSummary: 'Fix any of the following:\n  Element does not have inner text',
        })),
      },
    ],
  } as unknown as AxeResults;
}

describe('toA11yIssues', () => {
  it('produces one valid A11yIssue per node', () => {
    const [issue, ...rest] = toA11yIssues(
      results([{ target: ['.close'], html: '<button class="close"></button>' }]),
      'https://example.com/',
    );
    expect(rest).toEqual([]);
    expect(issue).toMatchObject({
      ruleId: 'button-name',
      impact: 'critical',
      wcag: ['4.1.2'],
      pageUrl: 'https://example.com/',
      selector: '.close',
      html: '<button class="close"></button>',
    });
    expect(issue!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('skips a node that does not fit A11yIssue, keeping the rest', () => {
    const skipped: string[] = [];
    const issues = toA11yIssues(
      results([
        { target: [], html: '<button></button>' },
        { target: ['.close'], html: '<button class="close"></button>' },
      ]),
      'https://example.com/',
      (ruleId) => skipped.push(ruleId),
    );
    expect(issues.map((i) => i.selector)).toEqual(['.close']);
    expect(skipped).toEqual(['button-name']);
  });

  it('keeps fingerprints unique within a page when elements look the same', () => {
    const html = '<button class="icon"></button>';
    const issues = toA11yIssues(
      results([
        { target: ['li:nth-child(1) > .icon'], html },
        { target: ['li:nth-child(2) > .icon'], html },
        { target: ['li:nth-child(3) > .icon'], html },
      ]),
      'https://example.com/',
    );
    const [first, second, third] = issues.map((i) => i.fingerprint);
    expect(second).toBe(`${first}:2`);
    expect(third).toBe(`${first}:3`);
  });
});
