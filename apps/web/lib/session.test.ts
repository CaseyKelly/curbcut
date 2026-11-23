import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redirectTarget } from './testing';

const mocks = vi.hoisted(() => ({ auth: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/auth', () => ({ auth: mocks.auth }));

const { currentLogin, requireUser } = await import('./session');

describe('requireUser', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('ALLOWED_GITHUB_LOGINS', 'CaseyKelly');
  });

  it('returns the allowlisted user with their GitHub id', async () => {
    mocks.auth.mockResolvedValue({ user: { login: 'CaseyKelly', githubId: 9472412 } });
    await expect(requireUser('/x')).resolves.toEqual({ login: 'CaseyKelly', githubId: 9472412 });
  });

  it('sends a signed-out caller to sign in, then back to returnTo', async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(redirectTarget(requireUser('/x'))).resolves.toBe('/sign-in?callbackUrl=%2Fx');
    await expect(redirectTarget(requireUser())).resolves.toBe('/sign-in');
  });

  it('sends a session from before the GitHub id was stored back to returnTo', async () => {
    mocks.auth.mockResolvedValue({ user: { login: 'CaseyKelly' } });
    await expect(redirectTarget(requireUser('/scans/abc'))).resolves.toBe(
      '/sign-in?callbackUrl=%2Fscans%2Fabc',
    );
  });

  it('sends an account that is not allowlisted away, not to sign in', async () => {
    mocks.auth.mockResolvedValue({ user: { login: 'stranger', githubId: 1 } });
    await expect(redirectTarget(requireUser('/x'))).resolves.toBe('/not-authorized');
  });
});

describe('currentLogin', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('ALLOWED_GITHUB_LOGINS', 'CaseyKelly');
  });

  it('is the login when allowlisted, and null otherwise', async () => {
    mocks.auth.mockResolvedValue({ user: { login: 'CaseyKelly' } });
    await expect(currentLogin()).resolves.toBe('CaseyKelly');
    mocks.auth.mockResolvedValue({ user: { login: 'stranger' } });
    await expect(currentLogin()).resolves.toBeNull();
    mocks.auth.mockResolvedValue(null);
    await expect(currentLogin()).resolves.toBeNull();
  });
});
