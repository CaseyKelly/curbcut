// Turns axe results into `A11yIssue`s (#5): one issue per violating element,
// with WCAG criteria parsed from axe's tags and a fingerprint that stays the
// same across scans of an unchanged page.
import { createHash } from 'node:crypto';
import type AxeBuilder from '@axe-core/playwright';
import { A11yIssue } from '@curbcut/core';

export type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;
type AxeTarget = AxeResults['violations'][number]['nodes'][number]['target'];

/** Joins the parts of a selector that crosses shadow roots (`>>>`) or frames (`|>`). */
export function formatTarget(target: AxeTarget): string {
  return target.map((part) => (Array.isArray(part) ? part.join(' >>> ') : part)).join(' |> ');
}

/** axe tags criteria as `wcag143` (1.4.3) or `wcag1411` (1.4.11); level tags like `wcag21aa` aren't criteria. */
export function wcagCriteria(tags: string[]): string[] {
  const criteria = tags.flatMap((tag) => {
    const m = /^wcag(\d)(\d)(\d{1,2})$/.exec(tag);
    return m ? [`${m[1]}.${m[2]}.${m[3]}`] : [];
  });
  return [...new Set(criteria)];
}

/** React `useId` values (`:r1:`, `«r1»`, `_r_1_`), which change with render order. */
const USE_ID = /\\?:r[0-9a-z]+\\?:|«r[0-9a-z]+»|_r_[0-9a-z]+_/g;

/**
 * Drops what changes between scans of the same element: positional
 * pseudo-classes, which shift when a sibling is added, `useId` values in id
 * selectors and id-like attribute selectors, and whitespace. Class names are
 * left alone, even ones that happen to look like a `useId` value.
 */
export function normalizeSelector(selector: string): string {
  return selector
    .replace(/:nth-(?:last-)?(?:child|of-type)\([^)]*\)/g, '')
    .replace(/#(?:\\.|[\w-])+/g, (id) => id.replace(USE_ID, ''))
    .replace(/\[(?:id|for|aria-[\w-]+)[~|^$*]?=[^\]]*\]/g, (attr) => attr.replace(USE_ID, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Drops whitespace differences and `useId` values in the attributes that hold ids. */
export function normalizeHtml(html: string): string {
  return html
    .replace(/\s(?:id|for|aria-[\w-]+)=(?:"[^"]*"|'[^']*')/g, (attr) => attr.replace(USE_ID, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Hash of rule + normalized selector + normalized HTML, per the plan's data model. */
export function fingerprint(ruleId: string, selector: string, html: string): string {
  return createHash('sha256')
    .update(`${ruleId}\n${normalizeSelector(selector)}\n${normalizeHtml(html)}`)
    .digest('hex');
}

/**
 * One `A11yIssue` per element axe flagged on `pageUrl`. Two identical elements
 * (say, three unlabeled icon buttons in a list) normalize to the same
 * fingerprint; later ones get `:2`, `:3` in document order, so fingerprints
 * stay unique within a page and still match across scans. A node that doesn't
 * fit the contract is skipped and reported to `onInvalid`, rather than failing
 * the whole page.
 */
export function toA11yIssues(
  results: AxeResults,
  pageUrl: string,
  onInvalid?: (ruleId: string, reason: string) => void,
): A11yIssue[] {
  const seen = new Map<string, number>();
  return results.violations.flatMap((rule) =>
    rule.nodes.flatMap((node) => {
      const selector = formatTarget(node.target);
      const base = fingerprint(rule.id, selector, node.html);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const issue = A11yIssue.safeParse({
        ruleId: rule.id,
        // A violation always has an impact; the rule's is the highest of its nodes'.
        impact: node.impact ?? rule.impact ?? 'minor',
        help: rule.help,
        helpUrl: rule.helpUrl,
        wcag: wcagCriteria(rule.tags),
        pageUrl,
        selector,
        html: node.html,
        failureSummary: node.failureSummary || undefined,
        fingerprint: n === 1 ? base : `${base}:${n}`,
      });
      if (issue.success) return [issue.data];
      onInvalid?.(rule.id, issue.error.message);
      return [];
    }),
  );
}
