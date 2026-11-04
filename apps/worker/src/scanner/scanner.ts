// Loads a page in Chromium and runs axe with the WCAG 2.1 AA tags (#5). One
// browser is shared across scans; each scan gets a fresh context, so no
// cookies or storage carry over, and its own SSRF-guarding proxy.
import AxeBuilder from '@axe-core/playwright';
import { AXE_WCAG_TAGS, type A11yIssue } from '@curbcut/core';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { PermanentError, UnsafeUrlError } from '../errors';
import { assertScanUrl, type GuardOptions } from '../net/guard';
import { BLOCKED_HEADER, startGuardProxy, type GuardProxy } from '../net/proxy';
import { toA11yIssues } from './normalize';

export interface ScanResult {
  issues: A11yIssue[];
  axeVersion: string;
}

export interface ScannerOptions extends GuardOptions {
  /** Page load timeout. The plan sets 60 s; axe gets the same again. */
  timeoutMs?: number;
}

/** Rejects with `message` if `promise` hasn't settled within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class Scanner {
  private browser: Promise<Browser> | undefined;
  private readonly timeoutMs: number;

  constructor(private readonly options: ScannerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  /** Launches Chromium on first use, and again if it crashed. */
  private async getBrowser(): Promise<Browser> {
    const current = await this.browser?.catch(() => undefined);
    if (current?.isConnected()) return current;
    this.browser = chromium.launch({
      // The worker handles signals itself, so it can release the job first;
      // Playwright's own handlers would exit the process under it.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      // WebRTC can reach local addresses without going through the proxy.
      args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    });
    return this.browser;
  }

  /** Scans one page. Aborting `signal` closes the page, so the scan stops promptly. */
  async scan(url: string, signal?: AbortSignal): Promise<ScanResult> {
    signal?.throwIfAborted();
    await assertScanUrl(url, this.options);
    const proxy = await startGuardProxy(this.options);
    try {
      const browser = await this.getBrowser();
      const context = await browser.newContext({
        // `<-loopback>` stops Chromium sending localhost around the proxy.
        proxy: { server: proxy.url, bypass: '<-loopback>' },
        // A service worker could make requests the page's context doesn't see.
        serviceWorkers: 'block',
      });
      const abort = () => void context.close().catch(() => undefined);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        // An abort during setup fired before the listener existed.
        signal?.throwIfAborted();
        return await this.scanPage(context, proxy, url);
      } catch (err) {
        signal?.throwIfAborted();
        throw err;
      } finally {
        signal?.removeEventListener('abort', abort);
        await context.close().catch(() => undefined);
      }
    } finally {
      await proxy.close();
    }
  }

  private async scanPage(
    context: BrowserContext,
    proxy: GuardProxy,
    url: string,
  ): Promise<ScanResult> {
    const page = await context.newPage();
    page.setDefaultTimeout(this.timeoutMs);

    // The hosts the page itself was loaded from: the target and any redirect
    // hops. A blocked image or script elsewhere isn't a reason to refuse the page.
    const navigationHosts = new Set([new URL(url).hostname]);
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        navigationHosts.add(new URL(request.url()).hostname);
      }
    });
    const refused = () => {
      const host = proxy.blocked.find((h) => navigationHosts.has(h));
      return host && new UnsafeUrlError(`Refused to load ${host}: it is a private address`);
    };

    const response = await page.goto(url, { waitUntil: 'load' }).catch((err: unknown) => {
      // A redirect to a blocked https host fails the tunnel rather than returning a page.
      throw refused() || err;
    });
    if (response?.headers()[BLOCKED_HEADER] === '1') {
      throw refused() || new UnsafeUrlError(`Refused to load ${url}`);
    }
    const status = response?.status() ?? 0;
    if (status >= 400) {
      // A 5xx may be a blip worth retrying; a 4xx won't change.
      const message = `${url} returned HTTP ${status}`;
      throw status < 500 ? new PermanentError(message) : new Error(message);
    }
    // Give client-rendered pages a moment to settle; carry on if they never go quiet.
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);

    const results = await withTimeout(
      new AxeBuilder({ page }).withTags([...AXE_WCAG_TAGS]).analyze(),
      this.timeoutMs,
      `axe did not finish within ${this.timeoutMs / 1000}s`,
    );
    // The page may have navigated to a blocked host after loading (a script
    // or meta refresh), leaving the proxy's 403 page where axe just ran.
    const late = refused();
    if (late) throw late;
    const issues = toA11yIssues(results, url, (ruleId, reason) =>
      console.warn(`skipped a ${ruleId} result on ${url} that doesn't fit A11yIssue: ${reason}`),
    );
    return { issues, axeVersion: results.testEngine.version };
  }

  async close(): Promise<void> {
    const browser = await this.browser?.catch(() => undefined);
    await browser?.close();
  }
}
