import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// One test run for the whole repo. Each workspace keeps its tests next to
// the code as *.test.ts(x); Playwright E2E lives in e2e/ and runs separately.
export default defineConfig({
  // The web app's `@/` imports, as in apps/web/tsconfig.json.
  resolve: { alias: { '@': fileURLToPath(new URL('./apps/web', import.meta.url)) } },
  test: {
    // Next.js keeps routes in apps/web/app and helpers in apps/web/lib, not src.
    include: ['{apps,packages}/*/{src,app,lib}/**/*.test.{ts,tsx}'],
    passWithNoTests: true,
  },
});
