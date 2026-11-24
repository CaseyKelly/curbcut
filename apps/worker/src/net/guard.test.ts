import { describe, expect, it } from 'vitest';
import { UnsafeUrlError } from '../errors';
import { assertScanUrl, resolvePublic, type ResolvedAddress } from './guard';

const dns =
  (records: Record<string, string[]>) =>
  (hostname: string): Promise<ResolvedAddress[]> =>
    Promise.resolve(
      (records[hostname] ?? []).map((address) => ({
        address,
        family: address.includes(':') ? 6 : 4,
      })),
    );

// `isPrivateAddress`, the address list itself, is tested in packages/core/src/net.test.ts.

describe('resolvePublic', () => {
  const resolve = dns({
    'example.com': ['93.184.215.14'],
    'rebind.test': ['93.184.215.14', '10.0.0.5'],
    'internal.test': ['192.168.0.10'],
  });

  it('returns a public address', async () => {
    await expect(resolvePublic('example.com', { resolve })).resolves.toEqual({
      address: '93.184.215.14',
      family: 4,
    });
  });

  it('rejects a name with any private record', async () => {
    await expect(resolvePublic('rebind.test', { resolve })).rejects.toThrow(UnsafeUrlError);
    await expect(resolvePublic('internal.test', { resolve })).rejects.toThrow(/192\.168\.0\.10/);
  });

  it('checks IP literals without resolving them, including bracketed IPv6', async () => {
    await expect(resolvePublic('127.0.0.1', { resolve })).rejects.toThrow(UnsafeUrlError);
    await expect(resolvePublic('[::1]', { resolve })).rejects.toThrow(UnsafeUrlError);
  });

  it('fails a name that does not resolve', async () => {
    await expect(resolvePublic('nowhere.test', { resolve })).rejects.toThrow(/did not resolve/);
  });

  it('allows anything when told to, for local development', async () => {
    await expect(
      resolvePublic('internal.test', { resolve, isBlockedAddress: () => false }),
    ).resolves.toMatchObject({ address: '192.168.0.10' });
  });
});

describe('assertScanUrl', () => {
  const resolve = dns({ 'example.com': ['93.184.215.14'], localhost: ['127.0.0.1'] });

  it('accepts http and https URLs on public hosts', async () => {
    await expect(assertScanUrl('https://example.com/a?b=1', { resolve })).resolves.toBeInstanceOf(
      URL,
    );
    await expect(assertScanUrl('http://example.com/', { resolve })).resolves.toBeInstanceOf(URL);
  });

  it.each([
    'file:///etc/passwd',
    'ftp://example.com/',
    'javascript:alert(1)',
    'data:text/html,<h1>hi</h1>',
    'not a url',
    'https://user:pass@example.com/',
  ])('rejects %s', async (url) => {
    await expect(assertScanUrl(url, { resolve })).rejects.toThrow(UnsafeUrlError);
  });

  it.each([
    'http://localhost:3000/',
    'http://127.0.0.1/',
    'http://0x7f.1/',
    'http://2130706433/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
  ])('rejects private target %s', async (url) => {
    await expect(assertScanUrl(url, { resolve })).rejects.toThrow(UnsafeUrlError);
  });
});
