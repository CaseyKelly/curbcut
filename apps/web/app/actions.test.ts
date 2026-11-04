import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn<() => Promise<unknown>>(),
  createScan: vi.fn<() => Promise<string>>(),
}));

// The real `requireUser` runs, over a mocked session, so this tests the whole
// gate in front of the action, not just that it was called.
vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('@/lib/scan-create', () => ({ createScan: mocks.createScan }));

const { startScan } = await import('./actions');

const form = (url: string) => {
  const data = new FormData();
  data.set('url', url);
  return data;
};
const previous = { url: '', error: null };
const signedIn = (login: string, githubId = 1) =>
  mocks.auth.mockResolvedValue({ user: { login, githubId } });

describe('startScan', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('ALLOWED_GITHUB_LOGINS', 'CaseyKelly');
    vi.stubEnv('ALLOW_PRIVATE_SCAN_TARGETS', 'false');
    mocks.createScan.mockResolvedValue('scan-1');
  });

  it('writes nothing for a signed-out caller', async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(startScan(previous, form('https://example.com/'))).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(mocks.createScan).not.toHaveBeenCalled();
  });

  it('writes nothing for a signed-in account that is not allowlisted', async () => {
    signedIn('stranger');
    await expect(startScan(previous, form('https://example.com/'))).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(mocks.createScan).not.toHaveBeenCalled();
  });

  it('writes nothing for a session from before the GitHub id was stored', async () => {
    mocks.auth.mockResolvedValue({ user: { login: 'CaseyKelly' } });
    await expect(startScan(previous, form('https://example.com/'))).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(mocks.createScan).not.toHaveBeenCalled();
  });

  it('answers a bad URL with an error and writes nothing', async () => {
    signedIn('CaseyKelly');
    const state = await startScan(previous, form('http://localhost:3000/'));
    expect(state.error).toMatch(/public websites/);
    expect(state.url).toBe('http://localhost:3000/');
    expect(mocks.createScan).not.toHaveBeenCalled();
  });

  it('treats a missing or non-text field as empty', async () => {
    signedIn('CaseyKelly');
    const state = await startScan(previous, new FormData());
    expect(state.error).toMatch(/enter the address/i);
    expect(mocks.createScan).not.toHaveBeenCalled();
  });

  it('queues the scan as the signed-in user, then goes to its page', async () => {
    signedIn('CaseyKelly', 9472412);
    await expect(startScan(previous, form(' https://example.com '))).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(mocks.createScan).toHaveBeenCalledWith({}, 'https://example.com/', {
      login: 'CaseyKelly',
      githubId: 9472412,
    });
  });

  it('keeps the typed text and says so when queueing fails', async () => {
    signedIn('CaseyKelly');
    mocks.createScan.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = await startScan(previous, form('https://example.com/'));
    expect(state).toEqual({
      url: 'https://example.com/',
      error: 'Couldn’t start the scan. Try again in a moment.',
    });
  });
});
