# Curbcut: Project Plan

> The reference for what we're building and why. Read it before starting an issue and use it
> when reviewing a PR. When a requirement or design changes, update this file in the same PR as
> the change (see [Keeping this plan current](#keeping-this-plan-current)).
>
> Originally drafted Oct 27, 2026 as a shared doc
> ([Project Plan](https://claude.ai/artifact/SyQS1zdTMTzykLf7SFaAZB)), written when the project
> was still called a11y-fixer. This file is now the source of truth; the shared doc is a
> historical snapshot.

## Decisions

The MVP scans one public URL, fixes React code, and is private to the two of us. Each choice leaves room to add crawling, logins, more frameworks, and public access later without a rewrite.

| Area         | Decision                                                                                                                                                        | Why                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Scan scope   | One public URL per scan. From day one, a scan stores a list of targets and an optional auth profile.                                                            | Crawl and login then just fill that list differently. The data model doesn't change.                                             |
| Frameworks   | React (JSX/TSX) only. Source mapping sits behind a `FrameworkAdapter` interface.                                                                                | Adding Vue, Svelte, or Angular means writing a new adapter and new eval cases.                                                   |
| Access       | GitHub sign-in (Auth.js) with an allowlist of our two GitHub logins. No users table yet.                                                                        | The cheapest way to keep strangers off our LLM budget.                                                                           |
| LLM          | Claude through the Anthropic SDK, behind a small `LLMProvider` interface. Sonnet 5.5 handles the agent and fixes; Haiku 5.5 handles explanations and the judge. | The interface keeps the provider swappable. Evals tell us when a cheaper model is good enough.                                   |
| Budget       | $20/month, enforced twice: a spend limit in the Anthropic console, and a budget guard in code that refuses new LLM work past the cap.                           | Two layers, so a bug can't run up a bill.                                                                                        |
| Build checks | Eval fixtures get typecheck, lint, and render checks. User repos get none in v1.                                                                                | Running other people's builds safely needs a sandbox. The PR's own CI covers it for now.                                         |
| Hosting      | Next.js on Vercel, the worker on Fly.io, Postgres on Neon, Drizzle as the ORM.                                                                                  | Playwright needs a long-running container, which Vercel functions aren't. Drizzle schemas are plain TypeScript with visible SQL. |
| Monorepo     | npm workspaces, no Turborepo.                                                                                                                                   | Idiomatic, with no extra tooling. We can add a build cache if CI gets slow.                                                      |
| Workflow     | Claude writes the first draft of each milestone. We review and rewrite. Every PR needs the other person's review.                                               | Fast drafts, while we still own every line.                                                                                      |
| Repo         | A private repo, `Curbcut` (originally created as `a11y-fixer`). Casey owns it; Upasana is a collaborator with write access.                                     | The setup script in [GitHub setup](#github-setup) creates it.                                                                    |

## Architecture

The web app and the worker never call each other. The web app writes jobs to Postgres. The worker claims them, does the slow work (browser scans and agent runs), and writes steps back, which the web app streams to the browser.

```text
  Browser ──▶ apps/web (Vercel) ──jobs──▶ Postgres (Neon) ◀──claim / steps── apps/worker (Fly.io)
                  ▲                          │                                 │
                  └──── SSE (polls steps) ───┘                                 ├─▶ Playwright + axe
                                                                               ├─▶ Claude API
                                                                               └─▶ GitHub (clone, PR)
```

The worker is the only component that touches Playwright, the cloned repos, GitHub tokens, and the Claude API for user work. That keeps secrets and heavy work out of Vercel. Evals call the same `packages/agent` code from GitHub Actions and store their results in the same database.

## Repo layout and the shared contract

The agent lives in its own package, so the worker and the eval runner call the exact same code and prompts. That is the main seam between Casey's work and Upasana's: an eval score always measures what ships.

```text
Curbcut/
  apps/
    web/              Next.js: UI, route handlers, auth            (Casey)
    worker/           Job runner on Fly: scanner, agent runs       (Casey)
  packages/
    core/             Zod schemas + types shared by everyone       (both)
    agent/            LLM provider, prompts, agent loop, tools     (Casey)
    db/               Drizzle schema + migrations                  (Casey; eval tables Upasana)
    evals/            dataset/, runner, scorers, reports           (Upasana)
  fixtures/
    sample-site/      React app full of deliberate a11y bugs       (Upasana)
  e2e/                Playwright end-to-end tests                  (Upasana)
  docs/               test strategy, release checklist, decisions  (both)
```

The contract is a set of Zod schemas in `packages/core`. Changing one needs approval from both Casey and Upasana (CODEOWNERS lists both; GitHub only enforces one, so by convention whoever didn't write the change approves it).

| Schema                                                                                                                                                                                              | Produced by          | Consumed by                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------- |
| `A11yIssue`: a normalized axe violation (rule, impact, WCAG tags, selector, HTML, fingerprint)                                                                                                      | Scanner              | UI, agent, eval scorer (a)                     |
| `IssueExplanation`: what's wrong, who it affects, why it matters, confidence                                                                                                                        | Explanation pipeline | UI, judge                                      |
| `PatchProposal`: outcome, file, diff, explanation, confidence                                                                                                                                       | Agent                | Diff review UI, every eval scorer              |
| `AgentStep`: a union of `thought`, `tool_call`, `tool_result`, and `end` (with the run's end reason). Per-step tokens and cost are planned for the `agent_steps` table but aren't in the schema yet | Agent loop           | Streaming UI, cost tracking, eval latency/cost |
| `EvalCase`: one dataset entry                                                                                                                                                                       | Upasana's dataset    | Eval runner                                    |
| `EvalResult`: per-case outcome and scores (a) through (e); pass is derived from the scores and stored in `eval_results.pass`                                                                        | Eval runner          | CI comment, evals dashboard                    |

The schemas themselves live in [`packages/core/src/index.ts`](../packages/core/src/index.ts), which is authoritative; this plan doesn't copy them so the two can't drift. The objects are strict, so a field the plan mentions but the schema lacks is rejected until it's added there. Two points from the design:

- `PatchProposal` is a union on `outcome`: `fix` (with `filePath` and a unified `diff`), `no_change_needed`, or `unsure` (with a `question` for the reviewer). `outcome` is how the model says "don't change anything" or "I'm not sure" instead of forcing a bad diff. The eval treats those as correct answers when the case expects them.
- Planned, not yet in `EvalCase`: a per-case `version` bumped when the case changes (see [Eval design](#eval-design)), and a `framework` field once a second framework arrives. Add them to the schema before writing them into `case.json`.

## Data model

The data model is eleven Postgres tables, and the job queue is one of them, so Redis isn't needed. Flexible payloads such as agent steps go in `jsonb` and are validated by the `core` schemas on the way in and out.

| Table           | Holds                     | Key columns                                                                                                                                | Milestone | Owner   |
| --------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ------- |
| `jobs`          | Work queue for the worker | type (scan, explain, fix, rescan), payload, status, attempts, locked_at, error                                                             | M1        | Casey   |
| `scans`         | One scan request          | targets (url[]), auth_profile_id (null for now), repo_id, parent_scan_id (for re-scans), status, axe_version, tokens, cost_usd, created_by | M1        | Casey   |
| `issues`        | Normalized axe violations | scan_id, rule_id, impact, wcag[], selector, html, fingerprint, group_key, priority                                                         | M1        | Casey   |
| `explanations`  | Cached LLM explanations   | cache_key (rule + HTML hash + prompt version + model), body, model, cost                                                                   | M1        | Casey   |
| `agent_runs`    | One agent or pipeline run | scan_id, kind, model, prompt_version, status, steps_used, tokens, cost_usd, timings                                                        | M1        | Casey   |
| `agent_steps`   | Streamed steps for the UI | run_id, seq, type, payload, tokens, cost_usd                                                                                               | M1        | Casey   |
| `repos`         | Connected GitHub repos    | installation_id, owner, name, default_branch                                                                                               | M3        | Casey   |
| `patches`       | Proposed fixes            | run_id, issue_ids[], file_path, proposed_diff, edited_diff, outcome, status (proposed, approved, rejected, applied), confidence            | M3        | Casey   |
| `pull_requests` | PRs we opened             | repo_id, scan_id, branch, number, url, state                                                                                               | M4        | Casey   |
| `eval_runs`     | One eval run              | git_sha, branch, trigger (pr, nightly, manual), dataset_version, model, prompt_hash, totals, cost_usd                                      | M2        | Upasana |
| `eval_results`  | Per-case results          | run_id, case_id, case_version, resolved, build_ok, scope_ok, judge_score, judge_reason, cost_usd, latency_ms, pass                         | M2        | Upasana |

Three details that matter:

- **Fingerprint.** A hash of rule + normalized selector + normalized HTML. It drives three things: the explanation cache, deduplicating issues across pages once crawling arrives, and the before/after comparison on a re-scan.
- **Job claiming.** The worker claims jobs with `SELECT ... FOR UPDATE SKIP LOCKED`, which makes Postgres a safe queue. Jobs stuck in running with an old `locked_at` get retried, up to 3 attempts.
- **Edited diffs.** We store both the model's diff and the human-edited diff. The difference between them is free eval data later.

## Agent design

URL mode is a plain pipeline. Only repo mode needs a real agent loop, because only there does the next step depend on what the model just found. Using an agent where a pipeline would do makes the system slower, more expensive, and harder to evaluate.

**URL mode (pipeline, M1):** scan, then normalize, group, and prioritize the issues, then make one LLM call per rule group with a Zod-validated output. The calls run with limited concurrency and are cached by fingerprint.

**Repo mode (agent loop, M3).** The loop is hand-rolled on the Anthropic Messages API, using tool use and streaming. It's about 150 lines, which is short enough for both of us to own. Each turn works like this:

1. Call the model with the system prompt, the tools, and the history.
2. Stream text and tool calls into `agent_steps` as they arrive.
3. Run each tool call, validating its arguments with Zod first, and append the result.
4. Stop when the model ends its turn, or when a limit is hit. The limits are 25 steps, a per-run cost cap, and 5 minutes of wall-clock time.

| Tool            | What it does                                                                                        | Guardrails                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `run_scan`      | Scans a URL and returns `A11yIssue[]`                                                               | Allowlisted URL schemes, 60 s page timeout                                                   |
| `read_file`     | Reads a file or a line range from the cloned repo                                                   | Paths resolved inside the repo root; no symlinks out; secret files blocked                   |
| `search_repo`   | ripgrep across the repo for strings from the issue's HTML (text, class names, ids, aria attributes) | Result count and size capped                                                                 |
| `propose_patch` | Records a `PatchProposal`                                                                           | The diff must apply cleanly and touch only the named file                                    |
| `apply_patch`   | Applies approved patches to a new branch                                                            | Needs a human approval record the model cannot create; the run pauses in `awaiting_approval` |
| `open_pr`       | Opens a PR with a summary of the fixes                                                              | Same approval gate; runs only after a person approves in the UI                              |

How the production concerns are handled:

- **Streaming to the UI.** The worker writes steps to Postgres. A route handler streams new rows to the browser over Server-Sent Events by polling every 500 ms. That's simpler than WebSockets and works on Vercel.
- **When the model is unsure.** Every structured output carries `confidence`, and a patch can be `unsure` with a question for the user. The UI shows the question instead of a weak diff.
- **Secrets.** File contents pass through a denylist (`.env*`, keys, certificates) and a secret scanner that redacts matches before anything enters a prompt. GitHub tokens live only in the worker. A test replays recorded LLM requests and fails if any of them contains a planted secret.
- **Reliability.** The SDK retries 429 and 5xx errors with backoff. Every call has a timeout. The job queue retries failed jobs. Output that fails Zod validation gets one repair attempt, then the step fails cleanly.
- **Cost.** Every call records its tokens and cost against the scan and the run. A monthly budget guard runs before each call. Prompt caching covers the system prompt and the tool definitions.
- **Record and replay.** The provider has a replay mode that serves saved responses. Unit tests, E2E tests, and local UI work then cost $0 and run deterministically.

## Eval design

Evals score the fixer from Milestone 1 onward. To make that possible, M1 ships a single-file `proposeFix(file, issue)`, and M3's agent calls it through `propose_patch`. That gives Upasana something real to measure five weeks before repo mode exists.

**Dataset.** Each case is a folder under `packages/evals/dataset/cases/<id>/`:

- `case.json`, validated against `EvalCase`
- `input/`, the one React file the case is about (its `filePath`)
- `expected/`, an optional reference fix
- an optional `test.tsx`

**Repo-mode cases** (M3, #25) don't carry their own repo. They run the agent against `fixtures/sample-site`, and `sourceFiles` names the sample-site file(s) the issue maps to. One shared, realistic repo is closer to what the agent will face than ten tiny ones, the sample site's seeded-issue manifest already says where each issue lives, and M3's "done when" is measured on that repo anyway. The cost is coupling: a change to the sample site can change what a repo-mode case measures, so such a change bumps `datasetVersion` and keeps `issues.manifest.json` in sync. If one repo proves too narrow, a second fixture repo can sit beside it.

`manifest.json` holds a `datasetVersion` that is bumped on any change, and every result records both the dataset version and the case version. Git provides the history.

| Category              | Examples                                                       | Cases  |
| --------------------- | -------------------------------------------------------------- | ------ |
| Text alternatives     | `img` without alt, icon-only buttons, SVGs                     | 8      |
| Form labels           | Unlabeled inputs, placeholder used as label                    | 7      |
| ARIA misuse           | Invalid roles, `aria-hidden` on focusable elements             | 7      |
| Keyboard and focus    | `div` with onClick, positive tabindex                          | 6      |
| No change needed      | Already-correct code, decorative `alt=""`, axe false positives | 6      |
| Color contrast        | Tailwind classes, inline styles, theme tokens                  | 5      |
| Structure             | Heading order, landmarks, `lang`, page title                   | 5      |
| Link and button names | "Click here", empty links                                      | 4      |
| Needs a human         | Alt text that depends on the image content                     | 2      |
| **Total (v1)**        |                                                                | **50** |

**Scorers.** Each case gets five scores:

- **(a) Resolved.** Render the patched component with a tiny Vite harness in Playwright and run axe. The target violation must be gone, with no new violations: the target rule reports no nodes, and no rule reports more nodes than on the input. Nodes are counted rather than compared because a fix can move the DOM around, which changes their selectors, so one node swapped for another under a non-target rule goes unnoticed. A fix or unsure case whose input no longer reports its target rule fails (a), so axe drift can't pass a no-op.
- **(b) Build safe.** `tsc --noEmit`, ESLint with `jsx-a11y`, and the case's own test if it has one. Inputs break `jsx-a11y` rules on purpose, so ESLint fails only on errors the patch adds.
- **(c) Scoped.** The diff touches only the entry file and stays near the offending element. For no-change cases, any diff fails.
- **(d) Judge.** Haiku 5.5 scores 1–5 against a written rubric: correct, minimal, idiomatic React, and native elements preferred over ARIA. Upasana hand-labels 15 cases to calibrate it, and we report how often the judge agrees with her.
- **(e) Cost and latency.** Recorded per case, summed and given a p95 per run.

A fix case passes when (a), (b), and (c) all pass and the judge gives 3 or more (until the judge lands in #15, on (a) to (c) alone). A no-change case passes when the outcome is `no_change_needed` or `unsure` with no diff. An unsure case passes only when the outcome is `unsure`. A diff that doesn't apply to the input fails (a), (b), and (c), and counts as a build break.

**Thresholds.** These are starting values, to be tuned after the first full run in M2.

| Gate                            | Threshold                | Blocks merge |
| ------------------------------- | ------------------------ | ------------ |
| Overall pass rate               | ≥ 70% in M2, ≥ 85% by M5 | Yes          |
| Drop versus the latest main run | No more than 5 points    | Yes          |
| Build breaks (b)                | 0                        | Yes          |
| No-change accuracy              | ≥ 90%                    | Yes          |
| Cost per case                   | Within the per-run cap   | Warn only    |
| p95 latency                     | Tracked                  | Warn only    |

**When evals run, within $20/month:**

| Tier   | Cases                         | Trigger                                        | Cost cap   |
| ------ | ----------------------------- | ---------------------------------------------- | ---------- |
| Replay | All, with recorded responses  | Every PR                                       | $0         |
| Smoke  | About 15 cases tagged `smoke` | PRs touching `packages/agent/**` or prompts    | $1 per run |
| Full   | All 50+                       | Weekly cron, manual dispatch, before a release | $3 per run |

The runner stops when it hits its cap and reports the run as incomplete, not failed. The dollar caps are placeholders until M1 measures the real cost per case.

**Tracking over time.** Every live run writes to `eval_runs` and `eval_results`. The CI job posts a PR comment showing the score diff against main, broken out by category. A `/evals` page in the app charts each metric over time and compares any two runs case by case. That comparison is how a prompt change gets accepted or rejected.

## Milestones

The plan is five milestones over six weekends. Each one ends with a review stop. M3 is the riskiest, and if it slips, the buffer comes out of M5's polish scope. Setup tasks marked M1 can start on weeknights.

### M1 · URL scan, explanations, seed evals (weekends 1–2)

| Task                                                                                       | Owner   |
| ------------------------------------------------------------------------------------------ | ------- |
| Repo scaffold, CI (typecheck, lint, unit), CODEOWNERS                                      | Casey   |
| Shared Zod schemas in `packages/core`                                                      | Both    |
| Drizzle schema for jobs, scans, issues, explanations, agent runs and steps                 | Casey   |
| GitHub sign-in with allowlist                                                              | Casey   |
| Worker: Postgres queue + Playwright/axe scanner, deployed to Fly                           | Casey   |
| LLM provider: Claude, structured output, retries, cost tracking, budget guard, replay mode | Casey   |
| Grouping, prioritization, cached explanations                                              | Casey   |
| UI: scan form, live progress, issue list with explanations                                 | Casey   |
| `proposeFix` v0 (single file, returns `PatchProposal`)                                     | Casey   |
| Sample broken site with a manifest of the seeded issues                                    | Upasana |
| Test strategy v1                                                                           | Upasana |
| Seed 20 eval cases, including 3 no-change cases, plus a validation script                  | Upasana |
| Basic eval runner with scorers (a), (b), (c), (e), run locally                             | Upasana |

- **Files:** `apps/web`, `apps/worker`, `packages/{core,agent,db,evals}`, `fixtures/sample-site`, `docs/test-strategy.md`
- **Risks:** the Playwright image size on Fly; noisy axe results on real sites; schema churn while both of us build against it.
- **Done when:** scanning the sample site shows grouped, explained issues in our own app; our app passes axe; the runner prints a scored table for 20 cases.

### M2 · Evals in CI, first prompt iteration (weekend 3)

| Task                                                                       | Owner                                  |
| -------------------------------------------------------------------------- | -------------------------------------- |
| Grow the dataset to 50+ cases, with manifest versioning                    | Upasana                                |
| LLM-as-judge with rubric and calibration against her labels                | Upasana                                |
| `eval_runs` and `eval_results` tables, plus a compare command              | Upasana                                |
| GitHub Actions eval workflow: tiers, cost cap, PR comment, gates           | Upasana                                |
| `/evals` page with trends and a run-vs-run comparison                      | Both (Upasana specifies, Casey builds) |
| Prompt iteration #1, driven by eval failures, with a before/after write-up | Both                                   |

- **Risks:** judge disagreement with the human labels; the eval budget; flaky render harness.
- **Done when:** a prompt PR gets an automatic score-diff comment and is blocked when it regresses; the first iteration is merged with its numbers.

### M3 · Repo mode and diff review (weekend 4, likely spills into 5)

| Task                                                                                       | Owner   |
| ------------------------------------------------------------------------------------------ | ------- |
| GitHub App with minimal permissions, install flow, `repos` table                           | Casey   |
| Repo workspace: shallow clone, secret denylist and redaction, cleanup                      | Casey   |
| Agent loop with `run_scan`, `read_file`, `search_repo`, `propose_patch` and streamed steps | Casey   |
| Issue-to-component mapping (search heuristics + model ranking)                             | Casey   |
| Diff review UI: view, edit, approve, reject; keyboard and screen-reader friendly           | Casey   |
| 10 repo-mode cases against `fixtures/sample-site` + a mapping-accuracy scorer              | Upasana |
| Tool integration tests: path traversal, symlinks, secrets, size limits                     | Upasana |

- **Data model:** adds `repos` and `patches`.
- **Risks:** mapping a rendered DOM element back to its source component is the hardest problem in the project; diff quality on large files.
- **Done when:** on the sample repo, the agent proposes fixes for most issues, a reviewer can edit and approve them, and the mapping-accuracy score is tracked in evals.

### M4 · Apply, PR, re-scan, E2E (weekend 5)

| Task                                                                                     | Owner   |
| ---------------------------------------------------------------------------------------- | ------- |
| `apply_patch` and `open_pr` behind the approval gate                                     | Casey   |
| Re-scan: wait for the PR's preview deploy, then show resolved, remaining, and new issues | Casey   |
| Playwright E2E for sign-in gate, URL scan, review, approve, PR (replay LLM + test repo)  | Upasana |
| axe checks on every page and state of our app as a merge gate                            | Upasana |

- **Data model:** adds `pull_requests`.
- **Risks:** waiting on preview deploys makes re-scan slow; E2E flakiness from real GitHub calls.
- **Done when:** one click goes from approved fixes to an open PR to a re-scan that confirms the fixes, and E2E runs in under 10 minutes on every PR.

### M5 · Polish, deploy, write-ups (weekend 6)

| Task                                                                | Owner   |
| ------------------------------------------------------------------- | ------- |
| Per-scan cost and token view, plus monthly budget view              | Casey   |
| Error-handling pass, including the model-unsure UX                  | Casey   |
| Production deploy (Vercel, Fly, Neon) and a hosted sample site      | Casey   |
| Release criteria and checklist, run for v1.0                        | Upasana |
| README with architecture, agent, evals, current scores, limitations | Both    |
| 3-minute demo video                                                 | Both    |
| Write-up: building the agent                                        | Casey   |
| Write-up: evaluating the agent                                      | Upasana |

- **Done when:** the release checklist passes, the demo is live, and both write-ups are drafted.

## GitHub setup

One script, `setup-github.sh`, created the private repo, then the labels, the 5 milestones, a Projects board, and 38 issues. Each issue has a description, acceptance criteria, an owner, and a milestone. The script runs in two phases, because GitHub only lets you assign issues to collaborators who have accepted their invite.

1. Casey runs `gh auth refresh -s project` once. The project scope lets the script create the board.
2. `OWNER=<casey-login> CASEY_GH=<login> UPASANA_GH=<login> ./setup-github.sh repo` creates the repo (originally `a11y-fixer`, since renamed to `Curbcut`) and invites Upasana with write access (personal repos don't offer maintain).
3. Upasana accepts the invite from their GitHub notifications.
4. Run the same command with `issues` instead of `repo`. It is safe to re-run: existing labels, milestones, and issues are skipped.

| Label                                                   | Meaning                                                                     |
| ------------------------------------------------------- | --------------------------------------------------------------------------- |
| `owner:casey`, `owner:upasana`, `owner:both`            | Who owns the work. Assignees are set too, so the board can group by either. |
| `area:agent`, `ui`, `infra`, `evals`, `testing`, `docs` | Which part of the system                                                    |

| Milestone                     | Issues | Casey | Upasana | Both |
| ----------------------------- | ------ | ----- | ------- | ---- |
| M1: URL scan + explanations   | 13     | 8     | 4       | 1    |
| M2: Evals in CI               | 6      | 0     | 4       | 2    |
| M3: Repo mode + diff review   | 7      | 5     | 2       | 0    |
| M4: Apply, PR, re-scan, E2E   | 4      | 2     | 2       | 0    |
| M5: Polish, deploy, write-ups | 8      | 4     | 2       | 2    |

M1 is heavier for Casey because the app has to exist before there's much to test. To balance it, Upasana drives M2, and her M1 work (the sample site, the dataset, and the runner) doesn't depend on his.

After the script runs, two settings have to be changed by hand in the repo:

- Turn on branch protection for `main`: 1 required review, required status checks, no force pushes.
- Add `ANTHROPIC_API_KEY` as an Actions secret. Set a $20 monthly spend limit on that key in the Anthropic console.

## Later, and what v1 is built to allow

None of these are in the six weekends. Each one has a seam in v1, so adding it later won't mean rewriting what's there.

| Later                     | Seam in v1                                                                                                                                                                 | Rough size                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Crawling                  | `scans.targets` is already an array, and fingerprints deduplicate issues across pages. A crawler only has to fill the list (same origin, with page and depth caps).        | 1 weekend                     |
| Login with credentials    | `scans.auth_profile_id` is reserved. Credentials would be encrypted at rest and used only in the worker, never sent to the LLM. Playwright `storageState` replays a login. | 1–2 weekends, mostly security |
| Vue, Svelte, Angular      | The `FrameworkAdapter` interface, plus a `framework` field on `EvalCase` (not there yet; React is implied today). Each framework needs its own eval cases before it ships. | 1 weekend each                |
| Public access and billing | The allowlist becomes a `users` table. Per-user quotas reuse the cost tracking. Stripe goes in front. A GitHub Marketplace listing is another route.                       | 2+ weekends                   |
| Builds on user repos      | Same sandbox as the eval fixtures, run in Fly Machines or a Vercel Sandbox per job.                                                                                        | 1–2 weekends                  |

Open questions to settle during the build:

- [ ] Is $20/month enough once the full eval tier runs weekly? M1 measures the real cost per case, and we'll decide by M2.
- [x] Where do repo-mode eval cases (M3, #25) keep their source? Settled in #47: `input/` holds only the case's one file, and repo-mode cases point `sourceFiles` into `fixtures/sample-site` (see [Eval design](#eval-design)).
- [ ] Which model for the fixer? We start with Sonnet 5.5 and let the M2 evals check whether Haiku 5.5 is good enough.

## Keeping this plan current

This file describes the intended design. The code is the truth for what exists, and where they disagree one of them is wrong.

- **Changing a requirement or design?** Update the relevant section here in the same PR, and say why in the PR description. Record a new or reversed decision as a row in [Decisions](#decisions) rather than silently editing the old one.
- **Shared schemas** are defined only in `packages/core`. If a `core` change alters the contract table above, update the table.
- **Answering an open question?** Tick it and note the answer and the PR that settled it.
- **Reviewing a PR?** Check it against this plan. A PR that departs from the plan without updating it should be sent back for one or the other.
