# Agent guide

Instructions for AI coding agents (Claude Code, Codex, and others) working in this repo. Humans
may find it useful too. [`README.md`](README.md) covers what Curbcut is; this file covers how to
work on it.

## Read first

- **[`docs/project-plan.md`](docs/project-plan.md)** is the design reference: decisions,
  architecture, data model, agent and eval design, milestones. Read the sections relevant to your
  task before implementing, and check changes against it when reviewing.
- The GitHub issue you're working on. Issues carry acceptance criteria and a milestone, and the
  code often cites them (`(#22)`).

## Keep the plan current

If your change alters a requirement or design (a new table or column, a schema change, a
different tool guardrail, a moved milestone, an answered open question), update
`docs/project-plan.md` in the same PR. Follow the rules in its "Keeping this plan current"
section. If the code and the plan disagree and your task doesn't settle which is right, point
it out instead of guessing.

## Commands

Node 22.18+ (`.nvmrc`). Workspaces are npm workspaces; there is no build step.

```bash
npm install
npm run check              # format:check, lint, typecheck, tests (what CI runs)
npm run format             # fix formatting
npm test                   # vitest only
npm run scan:sample-site   # axe scan of fixtures/sample-site against its manifest (CI runs this too)
npm run evals -- --reference  # eval harness self-check, no LLM calls (CI runs this too)
```

Run `npm run check` before calling work done.

## Layout and ownership

| Path                   | What                                     | Owner   |
| ---------------------- | ---------------------------------------- | ------- |
| `apps/web`             | Next.js app: UI, route handlers, auth    | Casey   |
| `apps/worker`          | Job runner: scans and agent runs         | Casey   |
| `packages/core`        | Zod schemas: the shared contract         | Both    |
| `packages/agent`       | LLM provider, prompts, agent loop, tools | Casey   |
| `packages/db`          | Drizzle schema and migrations            | Casey   |
| `packages/evals`       | Eval dataset, runner, scorers            | Upasana |
| `fixtures/sample-site` | React app with deliberate a11y bugs      | Upasana |
| `e2e`                  | Playwright end-to-end tests              | Upasana |

Workspace packages export TypeScript source directly. Next.js compiles them via
`transpilePackages`; the worker runs with `tsx`.

## Rules that matter

- **`packages/core` is the contract.** Every shared shape is a Zod schema there, exported with
  its inferred type under the same name, and objects are strict. Don't redefine these shapes
  elsewhere; import them. A `core` change needs review from whoever didn't write it.
- **Human approval gates writes.** `apply_patch` and `open_pr` must refuse to run without an
  approval record the model can't create. Never add a path around that.
- **Secrets never reach a prompt.** Respect the file denylist and the redaction step; GitHub
  tokens live only in the worker and are never logged.
- **Sandboxed tools.** Paths from the model are relative (`RelativePath`) and must still be
  resolved and checked to stay under the repo root. Search results stay capped.
- **Budgets.** LLM calls go through the provider so cost is recorded and the budget guard runs.
  Tests use replay mode, never live API calls.
- **Only scan http/https URLs**, and reject private network addresses.
- **Deliberately broken code is fixture data.** `fixtures/sample-site/src` and
  `packages/evals/dataset` are full of a11y bugs on purpose and are excluded from lint and
  formatting. Don't "fix" them unless the task is about the fixture, and keep the sample site's
  `issues.manifest.json` in sync with any change there. Repo-mode eval cases run against the
  sample site, so a change there also bumps the dataset's `datasetVersion`.
- **Our own UI is accessible.** New UI must pass axe with zero violations and work with only a
  keyboard. Prefer native elements to ARIA. `jsx-a11y` strict is on for `.tsx`.
- **Prompt changes are judged by evals**, not by a demo. Log them in `docs/prompt-log.md` with
  their eval results once that file exists (M2).

## Style

- TypeScript strict; ESM; Prettier (single quotes, 100 columns). Lint is type-aware, so handle
  every promise.
- Match the surrounding code: short doc comments that say why, citing the issue number where
  relevant.
- Keep diffs scoped to the task.

## Pull requests

Use [`.github/pull_request_template.md`](.github/pull_request_template.md): link the issue, say
what and why, how to test, and tick the checklist. Every PR needs the other person's review.
