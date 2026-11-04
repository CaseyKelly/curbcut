// Scorer (c): the diff touches only the case's file and only its allowed
// lines. Cases without allowedLines (no_change_needed, unsure) allow nothing,
// so any diff fails them.
import type { EvalCase } from '@curbcut/core';
import { changesOutside } from '../dataset/lines.ts';

export type Scored = { pass: boolean; notes: string[] };

export function scoreScoped(c: EvalCase, input: string, patched: string): Scored {
  const outside = changesOutside(input, patched, c.allowedLines ?? []);
  if (outside.length === 0) return { pass: true, notes: [] };
  const where = c.allowedLines ? 'outside allowedLines' : 'but this case allows no changes';
  return { pass: false, notes: outside.map((o) => `scoped: ${o}, ${where}`) };
}
