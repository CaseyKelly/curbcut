import { WcagCriterion } from '@curbcut/core';
import { describe, expect, it } from 'vitest';
import { KNOWN_CRITERIA, wcagUnderstandingUrl } from './wcag';

describe('wcagUnderstandingUrl', () => {
  it('links a criterion to its Understanding page', () => {
    expect(wcagUnderstandingUrl('1.4.3')).toBe(
      'https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html',
    );
    expect(wcagUnderstandingUrl('4.1.2')).toBe(
      'https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html',
    );
  });

  it('returns null for criteria it does not know, including inherited object keys', () => {
    expect(wcagUnderstandingUrl('2.4.11')).toBeNull();
    expect(wcagUnderstandingUrl('constructor')).toBeNull();
    expect(wcagUnderstandingUrl('')).toBeNull();
  });

  it('covers the 50 level A and AA criteria of WCAG 2.1, all valid criterion numbers', () => {
    // 30 level A + 20 level AA in 2.1 (4.1.1 still counts there).
    expect(KNOWN_CRITERIA).toHaveLength(50);
    for (const criterion of KNOWN_CRITERIA) {
      expect(WcagCriterion.safeParse(criterion).success, criterion).toBe(true);
    }
  });
});
