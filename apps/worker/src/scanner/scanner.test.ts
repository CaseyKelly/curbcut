// Runs real Chromium against a local server. Hostnames map to loopback
// addresses through an injected resolver: `site.test` is treated as public
// and `private.test` (127.0.0.2) as private, so the guard can be exercised
// without touching the network.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PermanentError, UnsafeUrlError } from '../errors';
import type { GuardOptions } from '../net/guard';
import { Scanner } from './scanner';

const page = (body: string) =>
  `<!doctype html><html lang="en"><head><title>Test</title></head><body><main>${body}</main></body></html>`;

let server: Server;
let port: number;
const requested: string[] = [];
let scanner: Scanner;

beforeAll(async () => {
  server = createServer((req, res) => {
    requested.push(req.url ?? '');
    const send = (status: number, html: string) =>
      res.writeHead(status, { 'content-type': 'text/html' }).end(html);
    switch (req.url) {
      case '/broken':
        return send(200, page('<img src="/x.png"><button></button>'));
      case '/clean':
        return send(200, page('<h1>All good</h1>'));
      case '/to-private':
        return res.writeHead(302, { location: `http://private.test:${port}/secret` }).end();
      case '/to-private-https':
        return res.writeHead(302, { location: `https://private.test:${port}/secret` }).end();
      case '/hang':
        // Never answers, so a page that loads it never fires `load`.
        return;
      case '/slow-with-private-image':
        return send(
          200,
          page(`<img alt="" src="http://private.test:${port}/secret"><img alt="" src="/hang">`),
        );
      case '/truncated':
        // Promises 1,000 bytes, sends 10, then drops the connection.
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': '1000' });
        res.write(Buffer.alloc(10));
        setTimeout(() => res.destroy(), 50);
        return;
      case '/with-truncated-image':
        return send(200, page('<img alt="" src="/truncated">'));
      case '/navigates-to-private':
        return send(
          200,
          page(
            `<script>setTimeout(() => { location.href = 'http://private.test:${port}/secret'; }, 100);</script>`,
          ),
        );
      case '/embeds-private':
        return send(200, page(`<img alt="" src="http://private.test:${port}/secret">`));
      default:
        return send(404, page('<h1>Not found</h1>'));
    }
  });
  // All interfaces, so a request the guard failed to stop would reach 127.0.0.2 and show up.
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  port = (server.address() as AddressInfo).port;
  scanner = new Scanner(guard);
});

const guard: GuardOptions = {
  resolve: (hostname) =>
    Promise.resolve([
      { address: hostname === 'private.test' ? '127.0.0.2' : '127.0.0.1', family: 4 },
    ]),
  isBlockedAddress: (address) => address === '127.0.0.2',
};

afterAll(async () => {
  await scanner?.close();
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
});

const url = (path: string) => `http://site.test:${port}${path}`;

describe('Scanner', { timeout: 60_000 }, () => {
  it('finds violations and normalizes them', async () => {
    const result = await scanner.scan(url('/broken'));
    expect(result.axeVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.issues.map((i) => i.ruleId).sort()).toEqual(['button-name', 'image-alt']);
    for (const issue of result.issues) expect(issue.pageUrl).toBe(url('/broken'));
  });

  it('returns no issues for a clean page, and the same fingerprints every time', async () => {
    expect((await scanner.scan(url('/clean'))).issues).toEqual([]);
    const [a, b] = await Promise.all([scanner.scan(url('/broken')), scanner.scan(url('/broken'))]);
    expect(a.issues.map((i) => i.fingerprint)).toEqual(b.issues.map((i) => i.fingerprint));
  });

  it('refuses a redirect to a private address', async () => {
    await expect(scanner.scan(url('/to-private'))).rejects.toThrow(UnsafeUrlError);
    await expect(scanner.scan(url('/to-private-https'))).rejects.toThrow(UnsafeUrlError);
    expect(requested).not.toContain('/secret');
  });

  it('blocks subresources on private addresses', async () => {
    await scanner.scan(url('/embeds-private'));
    expect(requested).not.toContain('/secret');
  });

  it('treats a timeout as retryable even if a subresource was blocked', async () => {
    const quick = new Scanner({ ...guard, timeoutMs: 2_000 });
    const err: unknown = await quick.scan(url('/slow-with-private-image')).catch((e: unknown) => e);
    await quick.close();
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentError);
    expect(String(err)).toMatch(/Timeout/);
  });

  it('stops when its signal aborts', async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(new Error('shutting down')), 300);
    const started = Date.now();
    await expect(scanner.scan(url('/slow-with-private-image'), stop.signal)).rejects.toThrow(
      'shutting down',
    );
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('stops when its signal aborts during setup', async () => {
    const stop = new AbortController();
    // Aborts while the target is being resolved, before the page exists.
    const racing = new Scanner({
      ...guard,
      resolve: (hostname) => {
        stop.abort(new Error('shutting down'));
        return guard.resolve!(hostname);
      },
    });
    await expect(racing.scan(url('/slow-with-private-image'), stop.signal)).rejects.toThrow(
      'shutting down',
    );
    await racing.close();
  });

  it('refuses a page that navigates to a private address after loading', async () => {
    await expect(scanner.scan(url('/navigates-to-private'))).rejects.toThrow(UnsafeUrlError);
    expect(requested).not.toContain('/secret');
  });

  it('does not wait on a resource the origin cut off mid-body', async () => {
    const quick = new Scanner({ ...guard, timeoutMs: 5_000 });
    const result = await quick.scan(url('/with-truncated-image'));
    await quick.close();
    expect(result.axeVersion).toBeTruthy();
  });

  it('fails permanently on a 404', async () => {
    await expect(scanner.scan(url('/missing'))).rejects.toThrow(PermanentError);
  });

  it('rejects private targets with the default guard', async () => {
    const strict = new Scanner();
    await expect(strict.scan(`http://127.0.0.1:${port}/broken`)).rejects.toThrow(UnsafeUrlError);
    await expect(strict.scan(`http://localhost:${port}/broken`)).rejects.toThrow(UnsafeUrlError);
    await strict.close();
  });
});
