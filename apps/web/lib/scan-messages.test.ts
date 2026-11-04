import { describe, expect, it } from 'vitest';
import {
  connectionMessage,
  failureDetail,
  missingExplanation,
  retryNote,
  skippedNote,
  stageMessage,
} from './scan-messages';
import type { GroupView, ScanView } from './scan-view';

const explanation = {
  whatsWrong: 'a',
  whoItAffects: 'b',
  whyItMatters: 'c',
  confidence: 0.9,
};

const group = (ruleId: string, explained: boolean): GroupView => ({
  groupKey: ruleId,
  ruleId,
  impact: 'serious',
  count: 1,
  help: 'help',
  helpUrl: 'https://example.com/',
  wcag: [],
  explanation: explained ? explanation : null,
  elements: [],
});

type View = Pick<
  ScanView,
  'stage' | 'issueCount' | 'groups' | 'error' | 'explainStatus' | 'explainError'
>;

/** A view with `explained` of `total` groups explained. */
const view = (over: Partial<View> = {}, total = 5, explained = 0): View => ({
  stage: 'done',
  issueCount: total,
  groups: Array.from({ length: total }, (_, i) => group(`rule-${i}`, i < explained)),
  error: null,
  explainStatus: 'completed',
  explainError: null,
  ...over,
});

describe('stageMessage', () => {
  it.each<[string, View, string]>([
    ['queued', view({ stage: 'queued', explainStatus: null }, 0), 'Waiting for the scan to start.'],
    ['scanning', view({ stage: 'scanning', explainStatus: null }, 0), 'Scanning the page.'],
    ['failed', view({ stage: 'failed', explainStatus: null }, 0), 'The scan failed.'],
    [
      'explaining, pending',
      view({ stage: 'explaining', explainStatus: 'pending' }, 3),
      'Scan finished: 3 issues across 3 rules. Writing explanations.',
    ],
    [
      'explaining, running',
      view({ stage: 'explaining', explainStatus: 'running' }, 1),
      'Scan finished: 1 issue across 1 rule. Writing explanations.',
    ],
    [
      'done, no issues',
      view({ explainStatus: null }, 0),
      'Scan finished: no accessibility issues found.',
    ],
    ['done, explained', view({}, 4, 4), 'Scan finished: 4 issues across 4 rules.'],
    [
      'done, explaining failed, none explained',
      view({ explainStatus: 'failed' }, 4, 0),
      'Scan finished: 4 issues across 4 rules. Explanations couldn’t be written.',
    ],
    [
      'done, explaining failed, some explained',
      view({ explainStatus: 'failed' }, 5, 3),
      'Scan finished: 5 issues across 5 rules. Some explanations couldn’t be written.',
    ],
  ])('%s', (_name, v, expected) => {
    expect(stageMessage(v)).toBe(expected);
  });

  it('counts issues and rules separately', () => {
    const v = view({ issueCount: 28 }, 21, 21);
    expect(stageMessage(v)).toBe('Scan finished: 28 issues across 21 rules.');
  });
});

describe('failureDetail', () => {
  it('gives the scan error, or a plain one when there is none', () => {
    expect(failureDetail(view({ stage: 'failed', error: 'Timed out' }, 0))).toBe(
      'Error: Timed out',
    );
    expect(failureDetail(view({ stage: 'failed', error: null }, 0))).toBe(
      'Error: The scan failed.',
    );
  });

  it('says explanations are unavailable when none were written', () => {
    expect(failureDetail(view({ explainStatus: 'failed', explainError: 'No key' }, 4, 0))).toBe(
      'Error: explanations couldn’t be written (No key). The issues below show axe’s own descriptions.',
    );
  });

  it('counts what is left when explaining failed part-way, and does not contradict the cards', () => {
    const text = failureDetail(view({ explainStatus: 'failed', explainError: '429' }, 5, 3));
    expect(text).toBe(
      'Error: 2 rules of 5 couldn’t be explained (429). Those show axe’s own descriptions.',
    );
    expect(text).not.toMatch(/issues below show/);
  });

  it.each(['pending', 'running', 'completed', null] as const)(
    'has nothing to say at explain status %s',
    (explainStatus) => {
      expect(failureDetail(view({ explainStatus }, 3, 1))).toBeNull();
    },
  );

  it('has nothing to say while a scan is still going', () => {
    for (const stage of ['queued', 'scanning', 'explaining'] as const) {
      expect(failureDetail(view({ stage, explainStatus: 'failed' }, 3))).toBeNull();
    }
  });
});

describe('missingExplanation', () => {
  it('says one is being written while explaining', () => {
    expect(missingExplanation(view({ stage: 'explaining', explainStatus: 'running' }, 3, 1))).toBe(
      'Writing an explanation…',
    );
  });

  it('says none are available when explaining failed with nothing explained', () => {
    expect(missingExplanation(view({ explainStatus: 'failed' }, 3, 0))).toMatch(
      /aren’t available for this scan/,
    );
  });

  it('says explaining stopped, not that none are available, when others were explained', () => {
    const text = missingExplanation(view({ explainStatus: 'failed' }, 3, 2));
    expect(text).toMatch(/stopped before this rule/);
    expect(text).not.toMatch(/aren’t available/);
  });

  it('says it could not be written when the job finished without it', () => {
    expect(missingExplanation(view({ explainStatus: 'completed' }, 3, 2))).toMatch(
      /No explanation could be written for this rule/,
    );
  });
});

describe('retryNote', () => {
  it('names the reason while the scan is queued again', () => {
    expect(retryNote(view({ stage: 'queued', error: 'reset', explainStatus: null }, 0))).toBe(
      'The last attempt didn’t work, so it’s trying again. Reason: reset',
    );
    expect(retryNote(view({ stage: 'queued', error: null, explainStatus: null }, 0))).toBeNull();
  });

  it('names the reason while the explain job waits for another attempt', () => {
    expect(
      retryNote(view({ stage: 'explaining', explainStatus: 'pending', explainError: '429' }, 3)),
    ).toBe('Writing explanations didn’t work, so it’s trying again. Reason: 429');
    expect(
      retryNote(view({ stage: 'explaining', explainStatus: 'running', explainError: '429' }, 3)),
    ).toBeNull();
  });
});

describe('skippedNote', () => {
  it('shows the note only on a finished, completed explain job', () => {
    const note = "1 of 3 groups couldn't be explained: label";
    expect(skippedNote(view({ explainStatus: 'completed', explainError: note }))).toBe(
      `Note: ${note}`,
    );
    expect(skippedNote(view({ explainStatus: 'completed', explainError: null }))).toBeNull();
    expect(skippedNote(view({ explainStatus: 'failed', explainError: note }))).toBeNull();
    expect(
      skippedNote(view({ stage: 'explaining', explainStatus: 'running', explainError: note })),
    ).toBeNull();
  });
});

describe('connectionMessage', () => {
  it('is silent while live, and says what to do once the connection ended', () => {
    expect(connectionMessage('live')).toBeNull();
    expect(connectionMessage('reconnecting')).toMatch(/trying to reconnect/i);
    expect(connectionMessage('lost')).toMatch(/reload the page/i);
  });
});
