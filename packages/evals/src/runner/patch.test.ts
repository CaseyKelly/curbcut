import { createPatch } from 'diff';
import { describe, expect, it } from 'vitest';
import { applyDiff } from './patch';

const INPUT = `export default function Tile() {
  return <img src="/fern.jpg" />;
}
`;
const FIXED = INPUT.replace('/>', 'alt="Fern" />');

describe('applyDiff', () => {
  it('applies a unified diff', () => {
    expect(applyDiff(INPUT, createPatch('Tile.tsx', INPUT, FIXED), 'Tile.tsx')).toEqual({
      ok: true,
      text: FIXED,
    });
  });

  it('fails a diff whose context does not match, rather than fuzzing it in', () => {
    const other = INPUT.replace('fern', 'cactus');
    const diff = createPatch('Tile.tsx', other, other.replace('/>', 'alt="Cactus" />'));
    expect(applyDiff(INPUT, diff, 'Tile.tsx')).toEqual({
      ok: false,
      error: 'diff does not apply to the input',
    });
  });

  it('fails a diff with no hunks or for several files', () => {
    expect(applyDiff(INPUT, '', 'Tile.tsx')).toMatchObject({ ok: false });
    const one = createPatch('Tile.tsx', INPUT, FIXED);
    expect(applyDiff(INPUT, one + createPatch('Other.tsx', 'a\n', 'b\n'), 'Tile.tsx')).toEqual({
      ok: false,
      error: 'diff must patch one file, found 2',
    });
  });

  it('accepts the a/ and b/ prefixes git adds', () => {
    const diff = createPatch('Tile.tsx', INPUT, FIXED)
      .replace('--- Tile.tsx', '--- a/Tile.tsx')
      .replace('+++ Tile.tsx', '+++ b/Tile.tsx');
    expect(applyDiff(INPUT, diff, 'Tile.tsx')).toEqual({ ok: true, text: FIXED });
  });

  it('fails a diff that names another file, even if it would apply', () => {
    expect(applyDiff(INPUT, createPatch('Other.tsx', INPUT, FIXED), 'Tile.tsx')).toEqual({
      ok: false,
      error: 'diff names Other.tsx -> Other.tsx, not Tile.tsx',
    });
  });

  it('fails a diff that names no file', () => {
    const diff = createPatch('Tile.tsx', INPUT, FIXED).replace(/^[\s\S]*?(?=@@)/, '');
    expect(applyDiff(INPUT, diff, 'Tile.tsx')).toEqual({
      ok: false,
      error: 'diff names no file -> no file, not Tile.tsx',
    });
  });
});
