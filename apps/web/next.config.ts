import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// The repo keeps one .env at the root (see README), but Next only reads env
// files from apps/web. Load the root one too, like the db scripts do.
// Variables already set in the environment win.
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const config: NextConfig = {
  // Stop `next dev` from writing apps/web/AGENTS.md; the root AGENTS.md is the guide.
  agentRules: false,
  // Workspace packages ship TypeScript source, so Next compiles them.
  transpilePackages: ['@curbcut/core', '@curbcut/agent', '@curbcut/db'],
};

export default config;
