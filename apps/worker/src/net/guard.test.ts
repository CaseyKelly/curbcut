import { describe, expect, it } from 'vitest';
import { UnsafeUrlError } from '../errors';
import { assertScanUrl, isPrivateAddress, resolvePublic, type ResolvedAddress } from './guard';

const dns =
  (records: Record<string, string[]>) =>
  (hostname: string): Promise<ResolvedAddress[]> =>
    Promise.resolve(
      (records[hostname] ?? []).map((address) => ({
        address,
        family: address.includes(':') ? 6 : 4,
      })),
    );

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '64:ff9b::a00:1',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['93.184.215.14', '8.8.8.8', '172.32.0.1', '2606:4700::6810:84e5', '::ffff:8.8.8.8'])(
    'allows %s',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});

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
