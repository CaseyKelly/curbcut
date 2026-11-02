import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PatchProposal } from '@curbcut/core';
import { afterAll, describe, expect, it } from 'vitest';
import { validateDataset } from '../dataset/dataset';
import { referenceFixer, rescoreFixer } from './fixers';
import { applyDiff } from './patch';
import { totals, type CaseRecord, type RunReport } from './report';

const root = fileURLToPath(new URL('../../dataset/', import.meta.url));
const { manifest, cases } = validateDataset(root);
const datasetVersion = manifest!.datasetVersion;

describe('referenceFixer', () => {
  it.each(cases.map((c) => [c.case.id, c] as const))(
    '%s: answers with the expected outcome and fix',
    async (_id, { case: c, dir }) => {
      const input = readFileSync(join(dir, 'input', c.filePath), 'utf8');
      const r = await referenceFixer.propose(c, input, dir, datasetVersion);
      const p = PatchProposal.parse('proposal' in r ? r.proposal : undefined);
      expect(p.outcome).toBe(c.expectedOutcome);
      if (p.outcome === 'fix') {
        const expected = readFileSync(join(dir, 'expected', c.filePath), 'utf8');
        expect(applyDiff(input, p.diff, c.filePath)).toEqual({ ok: true, text: expected });
      }
    },
  );
});

describe('rescoreFixer', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rescore-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const { case: c, dir } = cases[0]!;
  const proposal: PatchProposal = {
    outcome: 'unsure',
    question: 'q',
    explanation: 'e',
    confidence: 0.4,
  };
  const base = {
    caseId: c.id,
    datasetVersion,
    costUsd: 0.02,
    latencyMs: 1234,
    model: 'claude-sonnet-5-5',
    promptVersion: 'fix-v1',
  };
  const answered = {
    outcome: 'unsure' as const,
    outcomeCorrect: false,
    scores: { scoped: true },
  };
  const write = (
    caseVersion: number,
    outcome: Pick<CaseRecord, 'proposal'> & {
      result: typeof answered | { outcome: 'error'; error: string };
    } = { result: answered, proposal },
  ) => {
    const record: CaseRecord = {
      ...outcome,
      result: { ...base, caseVersion, ...outcome.result },
      expectedOutcome: c.expectedOutcome,
      category: c.category,
      pass: false,
      notes: [],
    };
    const report: RunReport = {
      createdAt: new Date().toISOString(),
      mode: 'live',
      datasetVersion,
      model: 'claude-sonnet-5-5',
      promptVersion: 'fix-v1',
      totals: totals([record]),
      cases: [record],
    };
    const path = join(tmp, `v${caseVersion}-${outcome.result.outcome}-${!!outcome.proposal}.json`);
    writeFileSync(path, JSON.stringify(report));
    return path;
  };

  it('returns the recorded proposal, cost and latency', async () => {
    const fixer = rescoreFixer(write(c.version));
    expect(fixer.model).toBe('claude-sonnet-5-5');
    await expect(fixer.propose(c, '', dir, datasetVersion)).resolves.toEqual({
      proposal,
      costUsd: 0.02,
      latencyMs: 1234,
    });
  });

  it('keeps the cost and latency of a recorded error', async () => {
    const fixer = rescoreFixer(write(c.version, { result: { outcome: 'error', error: 'boom' } }));
    await expect(fixer.propose(c, '', dir, datasetVersion)).resolves.toEqual({
      error: 'boom',
      costUsd: 0.02,
      latencyMs: 1234,
    });
  });

  it('keeps the metrics of a recording with no proposal', async () => {
    const fixer = rescoreFixer(write(c.version, { result: answered }));
    await expect(fixer.propose(c, '', dir, datasetVersion)).resolves.toEqual({
      error: 'recording has no proposal',
      costUsd: 0.02,
      latencyMs: 1234,
    });
  });

  it('refuses a recording of an older case version', async () => {
    const fixer = rescoreFixer(write(c.version + 1));
    await expect(fixer.propose(c, '', dir, datasetVersion)).rejects.toThrow(/recorded against/);
  });
});
