// Applies a proposal's unified diff to the case's input file. Strict: no
// fuzz, so a diff whose context doesn't match the input fails rather than
// landing somewhere else. The file the diff names must be the file it's
// applied to, with or without git's a/ and b/ prefixes.
import { applyPatch, parsePatch } from 'diff';

export type Applied = { ok: true; text: string } | { ok: false; error: string };

export function applyDiff(source: string, diff: string, filePath: string): Applied {
  let patches;
  try {
    patches = parsePatch(diff);
  } catch (e) {
    return { ok: false, error: `diff does not parse: ${(e as Error).message}` };
  }
  if (patches.length !== 1) {
    return { ok: false, error: `diff must patch one file, found ${patches.length}` };
  }
  const [patch] = patches as [(typeof patches)[number]];
  if (patch.hunks.length === 0) return { ok: false, error: 'diff has no hunks' };
  const { oldFileName: from, newFileName: to } = patch;
  if (
    (from !== filePath && from !== `a/${filePath}`) ||
    (to !== filePath && to !== `b/${filePath}`)
  ) {
    return {
      ok: false,
      error: `diff names ${from ?? 'no file'} -> ${to ?? 'no file'}, not ${filePath}`,
    };
  }
  const text = applyPatch(source, patch);
  if (text === false) return { ok: false, error: 'diff does not apply to the input' };
  return { ok: true, text };
}
