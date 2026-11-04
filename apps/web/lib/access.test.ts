import { describe, expect, it } from 'vitest';
import { decideAccess, isAllowedLogin, isPublicPath, parseAllowlist, signInPath } from './access';

const allowlist = parseAllowlist('CaseyKelly, UpasanaAjbani');

describe('parseAllowlist', () => {
  it('trims, lowercases, and drops empty entries', () => {
    expect([...parseAllowlist(' CaseyKelly,,UpasanaAjbani , ')]).toEqual([
      'caseykelly',
      'upasanaajbani',
    ]);
  });

  it('allows no one when unset or empty', () => {
    expect(parseAllowlist(undefined).size).toBe(0);
    expect(parseAllowlist('').size).toBe(0);
    expect(isAllowedLogin('CaseyKelly', parseAllowlist(undefined))).toBe(false);
  });
});

describe('isAllowedLogin', () => {
  it('matches logins case-insensitively, like GitHub', () => {
    expect(isAllowedLogin('caseykelly', allowlist)).toBe(true);
    expect(isAllowedLogin('UPASANAAJBANI', allowlist)).toBe(true);
  });

  it('rejects other and missing logins', () => {
    expect(isAllowedLogin('stranger', allowlist)).toBe(false);
    expect(isAllowedLogin('', allowlist)).toBe(false);
    expect(isAllowedLogin(undefined, allowlist)).toBe(false);
    expect(isAllowedLogin(null, allowlist)).toBe(false);
  });
});

describe('isPublicPath', () => {
  it('covers the sign-in flow and the not-authorized page', () => {
    expect(isPublicPath('/sign-in')).toBe(true);
    expect(isPublicPath('/not-authorized')).toBe(true);
    expect(isPublicPath('/api/auth/callback/github')).toBe(true);
  });

  it('does not match on a shared prefix', () => {
    expect(isPublicPath('/sign-in-elsewhere')).toBe(false);
    expect(isPublicPath('/api/authx')).toBe(false);
    expect(isPublicPath('/')).toBe(false);
    expect(isPublicPath('/api/scans')).toBe(false);
  });
});

describe('decideAccess', () => {
  it('lets anyone reach public paths', () => {
    expect(decideAccess('/sign-in', undefined, allowlist)).toEqual({ kind: 'allow' });
    expect(decideAccess('/not-authorized', 'stranger', allowlist)).toEqual({ kind: 'allow' });
  });

  it('sends signed-out visitors to sign in', () => {
    expect(decideAccess('/', undefined, allowlist)).toEqual({ kind: 'redirect', to: '/sign-in' });
  });

  it('sends non-allowlisted accounts to the not-authorized page', () => {
    expect(decideAccess('/', 'stranger', allowlist)).toEqual({
      kind: 'redirect',
      to: '/not-authorized',
    });
  });

  it('answers route handlers with 401 and 403 instead of redirecting', () => {
    expect(decideAccess('/api/scans', undefined, allowlist)).toEqual({ kind: 'deny', status: 401 });
    expect(decideAccess('/api/scans', 'stranger', allowlist)).toEqual({
      kind: 'deny',
      status: 403,
    });
  });

  it('allows allowlisted accounts everywhere', () => {
    expect(decideAccess('/', 'CaseyKelly', allowlist)).toEqual({ kind: 'allow' });
    expect(decideAccess('/api/scans', 'upasanaajbani', allowlist)).toEqual({ kind: 'allow' });
  });

  it('locks out a login removed from the allowlist', () => {
    expect(decideAccess('/', 'CaseyKelly', parseAllowlist('UpasanaAjbani'))).toEqual({
      kind: 'redirect',
      to: '/not-authorized',
    });
  });
});

describe('signInPath', () => {
  it('carries the path to come back to', () => {
    expect(signInPath('/scans/abc')).toBe('/sign-in?callbackUrl=%2Fscans%2Fabc');
    expect(signInPath('/')).toBe('/sign-in?callbackUrl=%2F');
  });

  it('carries nothing when there is no path', () => {
    expect(signInPath()).toBe('/sign-in');
    expect(signInPath('')).toBe('/sign-in');
  });

  it.each([
    'https://evil.example/',
    '//evil.example/',
    '/\\evil.example',
    'scans/abc',
    'javascript:1',
  ])('drops %s, which is not a path of ours', (returnTo) => {
    expect(signInPath(returnTo)).toBe('/sign-in');
  });
});
