import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowPrivateFromEnv, validateScanUrl } from './scan-url';

const error = (input: string, options?: { allowPrivate?: boolean }) => {
  const result = validateScanUrl(input, options);
  if (result.ok) throw new Error(`expected ${input} to be rejected, got ${result.url}`);
  return result.error;
};

describe('validateScanUrl', () => {
  it('accepts http and https URLs and returns them normalized', () => {
    expect(validateScanUrl('https://example.com')).toEqual({
      ok: true,
      url: 'https://example.com/',
    });
    expect(validateScanUrl('  http://example.com/a?b=1#c  ')).toEqual({
      ok: true,
      url: 'http://example.com/a?b=1#c',
    });
  });

  it('asks for an address when the field is empty', () => {
    expect(error('')).toMatch(/enter the address/i);
    expect(error('   ')).toMatch(/enter the address/i);
  });

  it('says what to fix when the text is not a URL', () => {
    expect(error('example.com')).toMatch(/start it with https/i);
    expect(error('not a url')).toMatch(/start it with https/i);
    expect(error('https://')).toMatch(/web address|website name/i);
  });

  it.each(['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'ftp://example.com'])(
    'rejects %s',
    (input) => {
      expect(validateScanUrl(input).ok).toBe(false);
    },
  );

  it('rejects credentials in the URL', () => {
    expect(error('https://user:pass@example.com/')).toMatch(/username and password/i);
    expect(error('https://user@example.com/')).toMatch(/username and password/i);
  });

  it('rejects very long input', () => {
    expect(error(`https://example.com/${'a'.repeat(2_100)}`)).toMatch(/too long/i);
  });

  it.each([
    'http://localhost:3000/',
    'http://LOCALHOST/',
    'http://app.localhost/',
    'http://127.0.0.1/',
    'http://127.1/',
    'http://2130706433/',
    'http://0x7f.0.0.1/',
    'http://0.0.0.0/',
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://[::1]/',
    'http://[::]/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://[::ffff:127.0.0.1]/',
  ])('rejects the local or private address %s', (input) => {
    expect(error(input)).toMatch(/public websites/i);
  });

  it('accepts public IP addresses and look-alike hostnames', () => {
    for (const input of [
      'http://93.184.216.34/',
      'http://172.32.0.1/',
      'http://[2606:4700::1111]/',
      'https://localhost.example.com/',
      'https://notlocalhost/',
    ]) {
      expect(validateScanUrl(input).ok, input).toBe(true);
    }
  });

  it('accepts local addresses when private targets are allowed', () => {
    expect(validateScanUrl('http://localhost:5173/', { allowPrivate: true })).toEqual({
      ok: true,
      url: 'http://localhost:5173/',
    });
    // Everything else still applies.
    expect(validateScanUrl('file:///etc/passwd', { allowPrivate: true }).ok).toBe(false);
    expect(validateScanUrl('http://u:p@localhost/', { allowPrivate: true }).ok).toBe(false);
  });
});

describe('allowPrivateFromEnv', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('follows ALLOW_PRIVATE_SCAN_TARGETS outside production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ALLOW_PRIVATE_SCAN_TARGETS', 'true');
    expect(allowPrivateFromEnv()).toBe(true);
    vi.stubEnv('ALLOW_PRIVATE_SCAN_TARGETS', 'false');
    expect(allowPrivateFromEnv()).toBe(false);
    vi.stubEnv('ALLOW_PRIVATE_SCAN_TARGETS', '');
    expect(allowPrivateFromEnv()).toBe(false);
  });

  it('is off in production whatever the variable says', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOW_PRIVATE_SCAN_TARGETS', 'true');
    expect(allowPrivateFromEnv()).toBe(false);
  });
});
