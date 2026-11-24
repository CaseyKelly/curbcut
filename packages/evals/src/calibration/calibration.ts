// The judge's calibration set (#15): fixes for dataset cases, each with a
// person's 1-5 label on the judge's rubric. Calibration runs the judge on the
// same fixes and reports how often it lands within 1 point of the label.
//
//   calibration/labels.json         the items and their labels
//   calibration/items/<id>/<file>   the patched file each item proposes
//
// An item's diff is computed from its case's input, so it can't drift from it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JudgeVerdict } from '@curbcut/core';
import { createPatch } from 'diff';
import { z } from 'zod';
import type { LoadedCase } from '../dataset/dataset.ts';

/** The plan's target: the judge within 1 point of the label on 80% of items. */
export const AGREEMENT_TARGET = 0.8;

export const CalibrationItem = z.strictObject({
  /** `<caseId>--<variant>`, which is also its folder under items/. */
  id: z.string().regex(/^[a-z0-9-]+--[a-z0-9-]+$/),
  caseId: z.string().min(1),
  /** The case version the item was written against; a changed case needs the item rechecked. */
  caseVersion: z.int().positive(),
  /** `reference` is the case's expected fix; a `variant` is another fix, good or bad. */
  source: z.enum(['reference', 'variant']),
  /** Null until someone labels it. */
  label: JudgeVerdict.nullable(),
});
export type CalibrationItem = z.infer<typeof CalibrationItem>;

export const CalibrationSet = z.strictObject({ items: z.array(CalibrationItem) });
export type CalibrationSet = z.infer<typeof CalibrationSet>;

/** An item ready to judge. */
export interface LoadedItem {
  item: CalibrationItem;
  loaded: LoadedCase;
  input: string;
  diff: string;
  referenceDiff?: string;
}

/** Loads and checks the set against the dataset. Problems are returned, not thrown. */
export function loadCalibration(
  dir: string,
  cases: LoadedCase[],
): { items: LoadedItem[]; errors: string[] } {
  const errors: string[] = [];
  let set: CalibrationSet;
  try {
    set = CalibrationSet.parse(JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8')));
  } catch (e) {
    return { items: [], errors: [`labels.json: ${(e as Error).message}`] };
  }
  const byId = new Map(cases.map((c) => [c.case.id, c]));
  const seen = new Set<string>();
  const items: LoadedItem[] = [];
  for (const item of set.items) {
    const where = `${item.id}:`;
    if (seen.has(item.id)) errors.push(`${where} duplicate id`);
    seen.add(item.id);
    if (!item.id.startsWith(`${item.caseId}--`)) {
      errors.push(`${where} id must start with its case id`);
    }
    const loaded = byId.get(item.caseId);
    if (!loaded) {
      errors.push(`${where} no case ${item.caseId}`);
      continue;
    }
    const c = loaded.case;
    if (c.expectedOutcome !== 'fix') errors.push(`${where} ${c.id} isn't a fix case`);
    if (c.version !== item.caseVersion) {
      errors.push(
        `${where} written for ${c.id} v${item.caseVersion}, now v${c.version}; recheck it and its label`,
      );
    }
    const patchedPath = join(dir, 'items', item.id, c.filePath);
    if (!existsSync(patchedPath)) {
      errors.push(`${where} missing items/${item.id}/${c.filePath}`);
      continue;
    }
    const input = readFileSync(join(loaded.dir, 'input', c.filePath), 'utf8');
    const patched = readFileSync(patchedPath, 'utf8');
    if (patched === input) errors.push(`${where} the patched file is the same as the input`);
    const expectedPath = join(loaded.dir, 'expected', c.filePath);
    const expected = existsSync(expectedPath) ? readFileSync(expectedPath, 'utf8') : undefined;
    if (item.source === 'reference' && patched !== expected) {
      errors.push(`${where} a reference item must match the case's expected file`);
    }
    items.push({
      item,
      loaded,
      input,
      diff: createPatch(c.filePath, input, patched),
      ...(expected !== undefined && {
        referenceDiff: createPatch(c.filePath, input, expected),
      }),
    });
  }
  return { items, errors };
}

export interface Agreement {
  /** Items with both a label and a judge score. */
  compared: number;
  withinOne: number;
  exact: number;
  /** Mean of judge minus label: positive means the judge is generous. */
  meanBias: number;
  meanAbsoluteError: number;
  rate: number;
  meetsTarget: boolean;
}

/** How well judge scores match labels. Pairs without both are skipped. */
export function agreement(pairs: { label?: number; judge?: number }[]): Agreement {
  const both = pairs.flatMap((p) =>
    p.label !== undefined && p.judge !== undefined ? [p.judge - p.label] : [],
  );
  const n = both.length;
  const withinOne = both.filter((d) => Math.abs(d) <= 1).length;
  const mean = (xs: number[]) => (n === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / n);
  const rate = n === 0 ? 0 : withinOne / n;
  return {
    compared: n,
    withinOne,
    exact: both.filter((d) => d === 0).length,
    meanBias: mean(both),
    meanAbsoluteError: mean(both.map(Math.abs)),
    rate,
    meetsTarget: n > 0 && rate >= AGREEMENT_TARGET,
  };
}
