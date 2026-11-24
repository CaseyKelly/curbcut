import type { IssueExplanation } from '@curbcut/core';
import { describe, expect, it } from 'vitest';
import {
  buildScanView,
  isFinal,
  parseDoneReason,
  parseScanEvent,
  MAX_ELEMENTS_PER_GROUP,
  ScanView,
  type IssueRow,
  type ScanRow,
} from './scan-view';

const scan = (over: Partial<ScanRow> = {}): ScanRow => ({
  id: '4b1f5f0e-6c0d-4a4e-9a58-3d5e6b0d6c11',
  targets: ['https://example.com/'],
  status: 'completed',
  error: null,
  explainStatus: 'completed',
  explainError: null,
  ...over,
});

const issue = (over: Partial<IssueRow> = {}): IssueRow => ({
  ruleId: 'image-alt',
  groupKey: 'image-alt',
  impact: 'critical',
  help: 'Images must have alternative text',
  helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/image-alt',
  wcag: ['1.1.1'],
  pageUrl: 'https://example.com/',
  selector: 'img',
  html: '<img src="a.png">',
  failureSummary: 'Fix any of the following: Element does not have an alt attribute',
  explanationId: null,
  ...over,
});

const explanation: IssueExplanation = {
  whatsWrong: 'Images have no text alternative.',
  whoItAffects: 'People who use screen readers.',
  whyItMatters: 'They hear nothing about the image.',
  confidence: 0.9,
};

describe('buildScanView stage', () => {
  it.each<[Partial<ScanRow>, string]>([
    [{ status: 'queued' }, 'queued'],
    [{ status: 'running' }, 'scanning'],
    [{ status: 'failed', error: 'boom' }, 'failed'],
    [{ status: 'completed', explainStatus: null }, 'done'],
    [{ status: 'completed', explainStatus: 'pending' }, 'explaining'],
    [{ status: 'completed', explainStatus: 'running' }, 'explaining'],
    [{ status: 'completed', explainStatus: 'completed' }, 'done'],
    [{ status: 'completed', explainStatus: 'failed' }, 'done'],
  ])('%j is %s', (over, stage) => {
    expect(buildScanView(scan(over), [], new Map()).stage).toBe(stage);
  });

  it('is final only when done or failed', () => {
    expect(isFinal({ stage: 'done' })).toBe(true);
    expect(isFinal({ stage: 'failed' })).toBe(true);
    for (const stage of ['queued', 'scanning', 'explaining'] as const) {
      expect(isFinal({ stage })).toBe(false);
    }
  });

  it('passes errors and the explain status through', () => {
    const view = buildScanView(
      scan({ status: 'queued', error: 'timeout', explainStatus: null }),
      [],
      new Map(),
    );
    expect(view).toMatchObject({ error: 'timeout', explainStatus: null, explainError: null });
  });
});

describe('buildScanView groups', () => {
  it('groups by rule, highest impact first, then by count', () => {
    const view = buildScanView(
      scan(),
      [
        issue({ ruleId: 'region', groupKey: 'region', impact: 'moderate' }),
        issue({ selector: 'img.a' }),
        issue({ selector: 'img.b' }),
        issue({ ruleId: 'label', groupKey: 'label', impact: 'critical', selector: 'input' }),
      ],
      new Map(),
    );
    expect(view.issueCount).toBe(4);
    expect(view.groups.map((g) => [g.ruleId, g.impact, g.count])).toEqual([
      ['image-alt', 'critical', 2],
      ['label', 'critical', 1],
      ['region', 'moderate', 1],
    ]);
  });

  it("takes a group's impact from its worst element", () => {
    const view = buildScanView(
      scan(),
      [issue({ impact: 'minor' }), issue({ impact: 'serious', selector: 'img.b' })],
      new Map(),
    );
    expect(view.groups[0]?.impact).toBe('serious');
  });

  it("attaches the group's explanation, and null where there is none", () => {
    const view = buildScanView(
      scan(),
      [
        issue({ explanationId: 'e1' }),
        issue({ ruleId: 'label', groupKey: 'label', impact: 'serious', explanationId: null }),
      ],
      new Map([['e1', explanation]]),
    );
    expect(view.groups.find((g) => g.ruleId === 'image-alt')?.explanation).toEqual(explanation);
    expect(view.groups.find((g) => g.ruleId === 'label')?.explanation).toBeNull();
  });

  it('treats a missing explanation row as unexplained', () => {
    const view = buildScanView(scan(), [issue({ explanationId: 'gone' })], new Map());
    expect(view.groups[0]?.explanation).toBeNull();
  });

  it('finds the explanation when only some issues of a group are linked yet', () => {
    const view = buildScanView(
      scan({ explainStatus: 'running' }),
      [issue(), issue({ selector: 'img.b', explanationId: 'e1' })],
      new Map([['e1', explanation]]),
    );
    expect(view.groups[0]?.explanation).toEqual(explanation);
  });

  it('carries the rule help, links and WCAG criteria, dropping malformed criteria', () => {
    const view = buildScanView(scan(), [issue({ wcag: ['1.1.1', 'wcag111', ''] })], new Map());
    expect(view.groups[0]).toMatchObject({
      help: 'Images must have alternative text',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/image-alt',
      wcag: ['1.1.1'],
    });
  });

  it('caps the elements sent per group but keeps the full count', () => {
    const many = Array.from({ length: MAX_ELEMENTS_PER_GROUP + 5 }, (_, i) =>
      issue({ selector: `img.n${i}` }),
    );
    const group = buildScanView(scan(), many, new Map()).groups[0]!;
    expect(group.count).toBe(MAX_ELEMENTS_PER_GROUP + 5);
    expect(group.elements).toHaveLength(MAX_ELEMENTS_PER_GROUP);
    expect(group.elements[0]?.selector).toBe('img.n0');
  });

  it('has no groups for a scan with no issues', () => {
    const view = buildScanView(scan({ explainStatus: null }), [], new Map());
    expect(view).toMatchObject({ issueCount: 0, groups: [], stage: 'done' });
  });

  it('produces something the client schema accepts, and survives JSON', () => {
    const view = buildScanView(
      scan(),
      [issue({ explanationId: 'e1', failureSummary: null })],
      new Map([['e1', explanation]]),
    );
    expect(ScanView.parse(JSON.parse(JSON.stringify(view)))).toEqual(view);
  });
});

describe('parsing events', () => {
  it('reads a scan event, and returns null for anything the page cannot show', () => {
    const view = buildScanView(scan(), [], new Map());
    expect(parseScanEvent(JSON.stringify(view))).toEqual(view);
    expect(parseScanEvent('not json')).toBeNull();
    expect(parseScanEvent('{}')).toBeNull();
    expect(parseScanEvent(JSON.stringify({ ...view, extra: 1 }))).toBeNull();
  });

  it('reads the reason a stream ended, and returns null for a bad payload', () => {
    expect(parseDoneReason('{"reason":"final"}')).toBe('final');
    expect(parseDoneReason('{"reason":"gone"}')).toBe('gone');
    expect(parseDoneReason('{"reason":"other"}')).toBeNull();
    expect(parseDoneReason('null')).toBeNull();
    expect(parseDoneReason('<html>')).toBeNull();
  });
});
