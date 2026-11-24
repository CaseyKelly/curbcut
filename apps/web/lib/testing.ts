/**
 * Where a `redirect()` inside `run` sent the caller, read from the digest of
 * the error Next.js throws (`NEXT_REDIRECT;<type>;<url>;<status>;`). For tests:
 * asserting only that a redirect happened can't tell `/sign-in` from the scan.
 */
export async function redirectTarget(run: Promise<unknown>): Promise<string> {
  const err: unknown = await run.then(
    () => {
      throw new Error('expected a redirect');
    },
    (e: unknown) => e,
  );
  const digest = (err as { digest?: unknown } | null)?.digest;
  if (typeof digest !== 'string' || !digest.startsWith('NEXT_REDIRECT;')) throw err;
  return digest.split(';').slice(2, -2).join(';');
}
