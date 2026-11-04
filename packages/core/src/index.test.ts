import { describe, expect, it } from 'vitest';
import {
  A11yIssue,
  AgentStep,
  EvalCase,
  EvalCaseObject,
  EvalResult,
  IssueExplanation,
  PatchProposal,
  RelativePath,
  ScanJobPayload,
} from './index';

const issue: A11yIssue = {
  ruleId: 'image-alt',
  impact: 'critical',
  help: 'Images must have alternative text',
  helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/image-alt',
  wcag: ['1.1.1'],
  pageUrl: 'http://localhost:5173/',
  selector: 'img.hero',
  html: '<img class="hero" src="/hero.png">',
  fingerprint: 'image-alt:img.hero:3f2a',
};

describe('RelativePath', () => {
  it.each(['src/App.tsx', 'App.tsx', 'a/b/c.css', 'src/..foo/x.ts'])('accepts %s', (p) => {
    expect(RelativePath.safeParse(p).success).toBe(true);
  });

  it.each([
    '',
    '/etc/passwd',
    'C:\\x.ts',
    '../secret',
    'src/../../x',
    'a\\..\\b',
    // Windows forms that resolve outside the root.
    '\\Windows\\win.ini',
    '\\\\server\\share\\x',
    'C:secret.txt',
    'C:..\\secret.txt',
    // Directories, not files.
    '.',
    './',
    'src/',
    './src/App.tsx',
    'src//App.tsx',
  ])('rejects %s', (p) => {
    expect(RelativePath.safeParse(p).success).toBe(false);
  });
});

describe('A11yIssue', () => {
  it('accepts a normalized axe violation', () => {
    expect(A11yIssue.parse(issue)).toEqual(issue);
  });

  it('rejects an unknown impact', () => {
    expect(A11yIssue.safeParse({ ...issue, impact: 'severe' }).success).toBe(false);
  });

  it('rejects a malformed WCAG criterion', () => {
    expect(A11yIssue.safeParse({ ...issue, wcag: ['wcag111'] }).success).toBe(false);
  });

  it('rejects a missing fingerprint', () => {
    expect(A11yIssue.safeParse({ ...issue, fingerprint: undefined }).success).toBe(false);
  });

  it('rejects non-http URLs', () => {
    expect(A11yIssue.safeParse({ ...issue, helpUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(A11yIssue.safeParse({ ...issue, pageUrl: 'data:text/html,x' }).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(A11yIssue.safeParse({ ...issue, severity: 'high' }).success).toBe(false);
  });
});

describe('ScanJobPayload', () => {
  it('accepts a scan id', () => {
    const scanId = '0b6c1f9e-2a4d-4c8e-9f3a-7d5e6b1c2a40';
    expect(ScanJobPayload.parse({ scanId })).toEqual({ scanId });
  });

  it('rejects a missing or malformed scan id', () => {
    expect(ScanJobPayload.safeParse({}).success).toBe(false);
    expect(ScanJobPayload.safeParse({ scanId: 'scan-1' }).success).toBe(false);
  });
});

describe('IssueExplanation', () => {
  const explanation = {
    whatsWrong: 'The hero image has no alt text.',
    whoItAffects: 'Screen reader users.',
    whyItMatters: 'They cannot tell what the image shows.',
    confidence: 0.9,
  };

  it('accepts a complete explanation', () => {
    expect(IssueExplanation.safeParse(explanation).success).toBe(true);
  });

  it('rejects confidence outside 0 to 1', () => {
    expect(IssueExplanation.safeParse({ ...explanation, confidence: 1.2 }).success).toBe(false);
  });

  it('rejects an empty field', () => {
    expect(IssueExplanation.safeParse({ ...explanation, whoItAffects: '' }).success).toBe(false);
  });
});

describe('PatchProposal', () => {
  const fix = {
    outcome: 'fix',
    filePath: 'src/Hero.tsx',
    diff: '--- a/src/Hero.tsx\n+++ b/src/Hero.tsx\n@@ -1 +1 @@\n-<img src="/hero.png" />\n+<img src="/hero.png" alt="" />\n',
    explanation: 'The image is decorative, so it gets an empty alt.',
    confidence: 0.8,
  };

  it('accepts a fix with filePath and diff', () => {
    expect(PatchProposal.safeParse(fix).success).toBe(true);
  });

  it('accepts no_change_needed without a diff', () => {
    const result = PatchProposal.safeParse({
      outcome: 'no_change_needed',
      explanation: 'The button already has an accessible name from aria-label.',
      confidence: 0.7,
    });
    expect(result.success).toBe(true);
  });

  it('accepts unsure with a question', () => {
    const result = PatchProposal.safeParse({
      outcome: 'unsure',
      question: 'Is this image decorative or does it convey information?',
      explanation: 'The right fix depends on what the image is for.',
      confidence: 0.3,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a fix without a diff', () => {
    expect(PatchProposal.safeParse({ ...fix, diff: undefined }).success).toBe(false);
  });

  it('rejects a fix without a filePath', () => {
    expect(PatchProposal.safeParse({ ...fix, filePath: undefined }).success).toBe(false);
  });

  it('rejects a fix whose filePath escapes the repo', () => {
    expect(PatchProposal.safeParse({ ...fix, filePath: '../.env' }).success).toBe(false);
  });

  it('rejects unsure without a question', () => {
    const result = PatchProposal.safeParse({
      outcome: 'unsure',
      explanation: 'Not sure.',
      confidence: 0.2,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown outcome', () => {
    expect(PatchProposal.safeParse({ ...fix, outcome: 'maybe' }).success).toBe(false);
  });

  it('rejects no_change_needed that also carries a diff', () => {
    const result = PatchProposal.safeParse({ ...fix, outcome: 'no_change_needed' });
    expect(result.success).toBe(false);
  });

  it('rejects unsure that also carries a filePath', () => {
    const result = PatchProposal.safeParse({
      outcome: 'unsure',
      question: 'Decorative?',
      filePath: 'src/Hero.tsx',
      explanation: 'Depends on the image.',
      confidence: 0.3,
    });
    expect(result.success).toBe(false);
  });
});

describe('AgentStep', () => {
  const base = { runId: 'run_1', index: 0, createdAt: '2026-10-27T12:00:00Z' };

  it('accepts each step type', () => {
    const steps = [
      { ...base, type: 'thought', text: 'Scanning first.' },
      { ...base, type: 'tool_call', toolCallId: 't1', tool: 'run_scan', input: { url: 'x' } },
      {
        ...base,
        type: 'tool_result',
        toolCallId: 't1',
        tool: 'run_scan',
        output: [],
        isError: false,
      },
      { ...base, type: 'end', reason: 'max_steps', message: 'Hit the 25 step limit.' },
    ];
    for (const step of steps) {
      expect(AgentStep.safeParse(step).success).toBe(true);
    }
  });

  it('rejects an unknown tool', () => {
    const step = { ...base, type: 'tool_call', toolCallId: 't1', tool: 'rm_rf', input: {} };
    expect(AgentStep.safeParse(step).success).toBe(false);
  });

  it('rejects a tool_result without isError', () => {
    const step = { ...base, type: 'tool_result', toolCallId: 't1', tool: 'read_file', output: '' };
    expect(AgentStep.safeParse(step).success).toBe(false);
  });

  it('rejects a negative index and a non-ISO timestamp', () => {
    const thought = { ...base, type: 'thought', text: '' };
    expect(AgentStep.safeParse({ ...thought, index: -1 }).success).toBe(false);
    expect(AgentStep.safeParse({ ...thought, createdAt: 'yesterday' }).success).toBe(false);
  });

  it('rejects an unknown end reason', () => {
    expect(AgentStep.safeParse({ ...base, type: 'end', reason: 'bored' }).success).toBe(false);
  });

  it('accepts a Postgres timestamptz with an offset', () => {
    const step = {
      ...base,
      type: 'thought',
      text: '',
      createdAt: '2026-10-27T12:00:00.123456+00:00',
    };
    expect(AgentStep.safeParse(step).success).toBe(true);
  });

  it('rejects a key from another step type', () => {
    const step = { ...base, type: 'thought', text: '', tool: 'read_file' };
    expect(AgentStep.safeParse(step).success).toBe(false);
  });
});

describe('EvalCase', () => {
  const evalCase = {
    id: 'image-alt-decorative',
    version: 1,
    framework: 'react',
    description: 'Decorative hero image with no alt.',
    category: 'images',
    tags: ['smoke'],
    filePath: 'Hero.tsx',
    issue,
    expectedOutcome: 'fix',
    allowedLines: [{ start: 4, end: 4 }],
  };

  it('accepts a fix case', () => {
    expect(EvalCase.safeParse(evalCase).success).toBe(true);
  });

  it('accepts a no-change case and defaults tags', () => {
    const parsed = EvalCase.parse({
      ...evalCase,
      tags: undefined,
      allowedLines: undefined,
      expectedOutcome: 'no_change_needed',
    });
    expect(parsed.tags).toEqual([]);
  });

  it('accepts a repo-mode case with source files', () => {
    const result = EvalCase.safeParse({ ...evalCase, sourceFiles: ['src/components/Hero.tsx'] });
    expect(result.success).toBe(true);
  });

  it('rejects allowedLines on a no-change case', () => {
    const result = EvalCase.safeParse({ ...evalCase, expectedOutcome: 'no_change_needed' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-kebab-case id', () => {
    expect(EvalCase.safeParse({ ...evalCase, id: 'Image Alt' }).success).toBe(false);
  });

  it('rejects an inverted line range', () => {
    const result = EvalCase.safeParse({ ...evalCase, allowedLines: [{ start: 5, end: 2 }] });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid embedded issue', () => {
    const result = EvalCase.safeParse({ ...evalCase, issue: { ...issue, helpUrl: 'nope' } });
    expect(result.success).toBe(false);
  });

  it('rejects a fix case without allowedLines', () => {
    expect(EvalCase.safeParse({ ...evalCase, allowedLines: undefined }).success).toBe(false);
    expect(EvalCase.safeParse({ ...evalCase, allowedLines: [] }).success).toBe(false);
  });

  it('rejects a misspelled key', () => {
    expect(EvalCase.safeParse({ ...evalCase, tag: ['smoke'] }).success).toBe(false);
  });

  it('requires a positive version and a supported framework', () => {
    expect(EvalCase.safeParse({ ...evalCase, version: undefined }).success).toBe(false);
    expect(EvalCase.safeParse({ ...evalCase, version: 0 }).success).toBe(false);
    expect(EvalCase.safeParse({ ...evalCase, framework: undefined }).success).toBe(false);
    expect(EvalCase.safeParse({ ...evalCase, framework: 'vue' }).success).toBe(false);
  });

  it('exposes an omittable object shape', () => {
    const withoutIssue = EvalCaseObject.omit({ issue: true });
    const input = Object.fromEntries(Object.entries(evalCase).filter(([k]) => k !== 'issue'));
    expect(withoutIssue.safeParse(input).success).toBe(true);
  });
});

describe('EvalResult', () => {
  const result = {
    caseId: 'image-alt-decorative',
    datasetVersion: 1,
    caseVersion: 1,
    outcome: 'fix',
    outcomeCorrect: true,
    scores: {
      resolved: true,
      buildSafe: true,
      scoped: true,
      judge: {
        score: 4,
        reason: 'Correct and minimal.',
        model: 'judge-model',
        promptVersion: 'j1',
      },
    },
    costUsd: 0.0031,
    latencyMs: 2400,
    model: 'fix-model',
    promptVersion: 'p1',
  };

  it('accepts a fully scored result', () => {
    expect(EvalResult.safeParse(result).success).toBe(true);
  });

  const crashed = {
    caseId: 'image-alt-decorative',
    datasetVersion: 1,
    caseVersion: 1,
    outcome: 'error',
    error: 'Timed out',
    costUsd: 0.001,
    latencyMs: 60000,
    model: 'fix-model',
    promptVersion: 'p1',
  };

  it('accepts a crash with no proposal outcome or scores', () => {
    expect(EvalResult.safeParse(crashed).success).toBe(true);
  });

  it('rejects a crash without an error message', () => {
    expect(EvalResult.safeParse({ ...crashed, error: undefined }).success).toBe(false);
  });

  it('rejects scores on a crash', () => {
    expect(EvalResult.safeParse({ ...crashed, scores: {} }).success).toBe(false);
  });

  it('rejects an error message on a scored result', () => {
    expect(EvalResult.safeParse({ ...result, error: 'Timed out' }).success).toBe(false);
  });

  it('rejects a judge score outside 1 to 5', () => {
    const bad = { ...result, scores: { judge: { ...result.scores.judge, score: 6 } } };
    expect(EvalResult.safeParse(bad).success).toBe(false);
  });

  it('rejects a fractional judge score', () => {
    const bad = { ...result, scores: { judge: { ...result.scores.judge, score: 3.5 } } };
    expect(EvalResult.safeParse(bad).success).toBe(false);
  });

  it('rejects negative cost and latency', () => {
    expect(EvalResult.safeParse({ ...result, costUsd: -1 }).success).toBe(false);
    expect(EvalResult.safeParse({ ...result, caseVersion: undefined }).success).toBe(false);
    expect(EvalResult.safeParse({ ...crashed, datasetVersion: undefined }).success).toBe(false);
    expect(EvalResult.safeParse({ ...result, latencyMs: -1 }).success).toBe(false);
  });
});
