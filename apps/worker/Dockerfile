# The worker image (#5). Build from the repo root, since the worker uses the
# workspace packages:
#   docker build -f apps/worker/Dockerfile -t curbcut-worker .
# Deploy with the command at the top of fly.toml.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Dependencies first, so a source change doesn't reinstall them. npm needs
# every workspace's package.json to read the lockfile, but installs only the
# worker's dependencies.
COPY package.json package-lock.json .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/agent/package.json packages/agent/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/evals/package.json packages/evals/
COPY fixtures/sample-site/package.json fixtures/sample-site/
RUN npm ci --workspace @curbcut/worker --omit=dev \
    && npx playwright install --with-deps --only-shell chromium \
    && npm cache clean --force

COPY tsconfig.base.json ./
COPY packages/core/ packages/core/
COPY packages/db/ packages/db/
COPY apps/worker/ apps/worker/

# Chromium runs as this user too, so it never has root.
USER node
WORKDIR /app/apps/worker
EXPOSE 8080
# Node directly, not through npm or npx, so it receives the stop signal itself.
CMD ["node", "--import", "tsx", "src/index.ts"]
