// Scorer (a): render the input and the patched file in a Vite harness, run
// axe on both in Playwright, and compare. The page matches how the dataset's
// issues were captured: client-rendered React inside <html lang="en"> with a
// <title> and a <main>.
//
// Comparing against the input's own scan, rather than against the case's
// recorded issue, keeps the check honest if axe's output drifts: the target
// rule must be gone and no rule may gain a node. Nodes are counted rather than
// compared because a fix can move the DOM around, which changes their selectors.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { AXE_WCAG_TAGS, type PatchOutcome } from '@curbcut/core';
import react from '@vitejs/plugin-react';
import { chromium, type Browser } from 'playwright';
import { createServer } from 'vite';
import type { Scored } from './scoped.ts';

/** One file to render: `key` names its page, `filePath` its file under that page. */
export type Page = { key: string; filePath: string; source: string };

/** Violation node counts by rule, or why the page could not be scanned. */
export type PageScan = { counts: Map<string, number> } | { error: string };

const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Eval case</title></head>
  <body><main><div id="root"></div></main><script type="module" src="./main.tsx"></script></body>
</html>
`;

// flushSync so the component is in the DOM before axe runs; render errors
// land in data-error rather than an uncaught exception nobody waits for.
const main = (filePath: string) => `import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import Component from './${filePath}';

const root = createRoot(document.getElementById('root')!, {
  onUncaughtError: (e) => { document.body.dataset.error = String(e); },
});
flushSync(() => root.render(<Component />));
document.body.dataset.rendered ??= 'true';
`;

/** Scans every page in one Vite dev server and one browser. `dir` is scratch space. */
export async function scanPages(
  dir: string,
  pages: Page[],
): Promise<{ scans: Map<string, PageScan>; axeVersion?: string }> {
  for (const p of pages) {
    const pageDir = join(dir, p.key);
    mkdirSync(dirname(join(pageDir, p.filePath)), { recursive: true });
    writeFileSync(join(pageDir, p.filePath), p.source);
    writeFileSync(join(pageDir, 'index.html'), html);
    writeFileSync(join(pageDir, 'main.tsx'), main(p.filePath));
  }

  const scans = new Map<string, PageScan>();
  let axeVersion: string | undefined;
  // Dependencies are fixed up front (case files may only import react), so
  // the server never re-optimizes and reloads a page while axe runs.
  const server = await createServer({
    root: dir,
    configFile: false,
    logLevel: 'silent',
    plugins: [react()],
    server: { port: 0, host: '127.0.0.1' },
    optimizeDeps: {
      noDiscovery: true,
      include: ['react', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'],
    },
  });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    await server.listen();
    const baseUrl = server.resolvedUrls?.local[0];
    if (!baseUrl) throw new Error('Vite did not report a local URL');
    const context = await browser.newContext();
    for (const p of pages) {
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));
      try {
        await page.goto(new URL(`${p.key}/`, baseUrl).href);
        await page
          .waitForFunction(
            () => document.body.dataset.rendered || document.body.dataset.error,
            undefined,
            { timeout: 10_000 },
          )
          .catch(() => undefined);
        const state = await page.evaluate(() => ({ ...document.body.dataset }));
        if (state.error || !state.rendered) {
          const why = state.error ?? pageErrors[0] ?? 'the component never rendered';
          scans.set(p.key, { error: `render failed: ${why}` });
          continue;
        }
        const results = await new AxeBuilder({ page }).withTags([...AXE_WCAG_TAGS]).analyze();
        axeVersion = results.testEngine.version;
        scans.set(p.key, {
          counts: new Map(results.violations.map((v) => [v.id, v.nodes.length])),
        });
      } catch (e) {
        scans.set(p.key, { error: `scan failed: ${(e as Error).message}` });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser?.close();
    await server.close();
  }
  return { scans, axeVersion };
}

/**
 * Resolved when the target rule reports no nodes and no rule has more than in
 * the input. A fix or unsure case's input must still report the target rule,
 * or any diff would pass; a no-change case's input isn't expected to.
 */
export function scoreResolved(
  targetRule: string,
  expected: PatchOutcome,
  before: PageScan,
  after: PageScan,
): Scored {
  if ('error' in before) return { pass: false, notes: [`resolved: input ${before.error}`] };
  if ('error' in after) return { pass: false, notes: [`resolved: patched file ${after.error}`] };
  const notes: string[] = [];
  const target = before.counts.get(targetRule) ?? 0;
  if (target === 0 && expected !== 'no_change_needed') {
    notes.push(`resolved: input no longer reproduces ${targetRule}`);
  }
  if (target > 0 && (after.counts.get(targetRule) ?? 0) > 0) {
    notes.push(`resolved: ${targetRule} is still reported`);
  }
  for (const [rule, n] of after.counts) {
    const was = before.counts.get(rule) ?? 0;
    if (n > was) notes.push(`resolved: new ${rule} violation (${was} -> ${n} nodes)`);
  }
  return { pass: notes.length === 0, notes };
}
