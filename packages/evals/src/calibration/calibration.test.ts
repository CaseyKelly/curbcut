import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { validateDataset } from '../dataset/dataset';
import { agreement, CalibrationSet, loadCalibration } from './calibration';

const evalsRoot = fileURLToPath(new URL('../../', import.meta.url));
const calibrationDir = join(evalsRoot, 'calibration');
const { cases } = validateDataset(join(evalsRoot, 'dataset'));

describe('the calibration set', () => {
  it('matches the dataset', () => {
    const { items, errors } = loadCalibration(calibrationDir, cases);
    expect(errors).toEqual([]);
    expect(items).toHaveLength(15);
    for (const i of items) expect(i.diff).toMatch(/^@@/m);
  });
});

describe('loadCalibration', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** A copy of the set with labels.json edited. */
  function edited(edit: (set: CalibrationSet) => void) {
    dir = mkdtempSync(join(tmpdir(), 'calibration-'));
    cpSync(calibrationDir, dir, { recursive: true });
    const path = join(dir, 'labels.json');
    const set = CalibrationSet.parse(JSON.parse(readFileSync(path, 'utf8')));
    edit(set);
    writeFileSync(path, JSON.stringify(set));
    return loadCalibration(dir, cases).errors;
  }

  it('flags an item written for an older case version', () => {
    const errors = edited((s) => {
      s.items[0]!.caseVersion += 1;
    });
    expect(errors).toEqual([expect.stringMatching(/recheck it and its label/)]);
  });

  it('flags a reference item that is not the expected file', () => {
    const errors = edited((s) => {
      const variant = s.items.find((i) => i.source === 'variant')!;
      variant.source = 'reference';
    });
    expect(errors).toEqual([expect.stringMatching(/must match the case's expected file/)]);
  });

  it('flags unknown cases and duplicate ids', () => {
    const errors = edited((s) => {
      s.items.push({ ...s.items[0]! });
      s.items.push({ ...s.items[0]!, id: 'nope--x', caseId: 'nope' });
    });
    expect(errors).toEqual([expect.stringMatching(/duplicate id/), 'nope--x: no case nope']);
  });
});

describe('agreement', () => {
  it('counts the judge within 1 point of the label', () => {
    const a = agreement([
      { label: 5, judge: 5 },
      { label: 4, judge: 5 },
      { label: 2, judge: 4 },
      { label: 1, judge: 1 },
      { label: 3 },
    ]);
    expect(a).toMatchObject({
      compared: 4,
      withinOne: 3,
      exact: 2,
      rate: 0.75,
      meetsTarget: false,
    });
    expect(a.meanBias).toBeCloseTo(0.75);
    expect(a.meanAbsoluteError).toBeCloseTo(0.75);
  });

  it('meets the target at 80%', () => {
    const pairs = [
      ...Array.from({ length: 4 }, () => ({ label: 3, judge: 3 })),
      { label: 1, judge: 5 },
    ];
    expect(agreement(pairs)).toMatchObject({ rate: 0.8, meetsTarget: true });
  });

  it('never meets the target with nothing to compare', () => {
    expect(agreement([])).toMatchObject({ compared: 0, rate: 0, meetsTarget: false });
  });
});
