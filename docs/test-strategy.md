# Test strategy

How we check that Curbcut works and that its fixes are good. This is v1 (#11), written during M1, so much of it is still planned. The status columns say which checks run today and which issue adds the rest.

[`project-plan.md`](project-plan.md) stays the source of truth for eval design and thresholds. This doc says how the checks fit together, and it links to the plan rather than restating its reasoning. When a check lands or changes, update its row here in the same PR.

## Two questions, two kinds of check

Curbcut has ordinary code and a model, and they fail differently.

- **Does the code do what we wrote?** Unit, integration, E2E, and accessibility tests answer this. They're deterministic, cost nothing, and must always pass.
- **Is the model's work good?** Evals answer this. They score outcomes across a dataset, cost money when run live, and pass or fail on thresholds, because a single wrong answer isn't a bug in the way a failed test is.

Tests never call a live LLM. They use the provider's replay mode or a stub.

## Test levels

| Level          | What it checks                                                                                                                                                                | Tools                                                     | Where it lives                                          | Status                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| Unit           | Logic with no outside services: schemas, the address guard, issue normalization, LLM pricing and repair, eval scorers                                                         | Vitest                                                    | `*.test.ts` next to the code                            | Running                                              |
| Integration    | Code against the real thing it depends on: the job queue and schema on Postgres, the scanner on Chromium, and (later) tools on a real checkout of a repo                      | Vitest, Postgres, Playwright                              | `*.test.ts` next to the code                            | Running; tool tests planned (#26)                    |
| Fixture checks | The test data itself: the sample site reports exactly its seeded issues, every eval case is valid and reproduces its issue, and the reference fixes all pass                  | `scan:sample-site`, `evals:validate`, `evals --reference` | `packages/evals`, `fixtures/sample-site`                | Running                                              |
| Eval           | The fixer's output, with scorers (a) to (e) from the [eval design](project-plan.md#eval-design)                                                                               | Eval runner, Vite harness, axe, `tsc`, ESLint             | `packages/evals`                                        | Runner running on the reference fixer; live needs #9 |
| E2E            | The main flows through the real app: sign-in gate, URL scan, issue list, diff review, open PR. Uses LLM replay and a dedicated test repo                                      | Playwright                                                | `e2e/`                                                  | Planned (#29)                                        |
| Accessibility  | Our own app: axe on every page and key state (loading, error, results, diff review), plus `jsx-a11y` strict on every `.tsx` file and a manual keyboard and screen-reader pass | axe during E2E, ESLint, release checklist                 | `e2e/`, `eslint.config.js`, `docs/release-checklist.md` | ESLint running; axe gate planned (#30); manual (#34) |

We don't require a line-coverage percentage ([decision](project-plan.md#decisions)). The risk list below decides what must be tested, and evals measure the part coverage can't.

`evals:validate` isn't its own CI step. The same validation runs in `dataset.test.ts`, so `npm run check` covers it.

## What runs where and when

| Check                                      | Locally                        | Every PR and push to `main` | PRs touching `packages/agent/**` or prompts | Weekly or manual | Before a release | Status                     |
| ------------------------------------------ | ------------------------------ | --------------------------- | ------------------------------------------- | ---------------- | ---------------- | -------------------------- |
| Format, lint, typecheck, Vitest            | `npm run check`                | Yes                         | Yes                                         |                  | Yes              | Running                    |
| Migrations match the schema                | `npm run db:generate`          | Yes                         | Yes                                         |                  |                  | Running                    |
| Committed migrations unchanged             |                                | PRs only                    | Yes                                         |                  |                  | Running                    |
| Sample-site scan against its manifest      | `npm run scan:sample-site`     | Yes                         | Yes                                         |                  | Yes              | Running                    |
| Eval harness self-check (`--reference`)    | `npm run evals -- --reference` | Yes                         | Yes                                         |                  | Yes              | Running                    |
| Worker image builds                        | `docker build`                 | Yes                         | Yes                                         |                  |                  | Running                    |
| Evals, replay tier (all cases, $0)         | Planned                        | Yes                         | See gap 4                                   |                  |                  | Planned (#17)              |
| Evals, smoke tier (about 15 cases, $1 cap) |                                |                             | Yes                                         |                  |                  | Planned (#17)              |
| Evals, full tier (all cases, $3 cap)       |                                |                             |                                             | Yes              | Yes              | Planned (#17)              |
| E2E with the accessibility gate            | Planned                        | Yes, under 10 minutes       | Yes                                         |                  | Yes              | Planned (#29, #30)         |
| Hand axe run, until the gate lands (#30)   | When adding UI                 | UI PRs only                 | UI PRs only                                 |                  |                  | Required, starting with #8 |
| Manual keyboard and screen-reader pass     | When adding UI                 |                             |                                             |                  | Yes              | Planned (#34)              |

What's different on your machine:

- **Without `DATABASE_URL`, the Postgres tests skip** (`worker`, `explain`, `schema`, `ledger`), so `npm run check` can pass locally and fail in CI. To run them, point `DATABASE_URL` at a migrated database.
- **The scanner tests, the sample-site scan, and the eval harness need Chromium:** `npx playwright install chromium`.

The eval gates are in the [thresholds table](project-plan.md#eval-design). Until #17 lands, nothing gates on model quality, because there's no live fixer yet to measure.

## Test data

- **`fixtures/sample-site`** is a React app with seeded bugs. Its `issues.manifest.json` must stay in sync with the code, and a change there also bumps the dataset's `datasetVersion`, because repo-mode cases run against it.
- **`packages/evals/dataset`** holds the eval cases. Results from different dataset versions aren't compared.
- **LLM recordings** are keyed on a hash of the whole request. Any change to a prompt, model, or input is a replay miss, and the call fails rather than reaching the API.
- **GitHub flows** use a dedicated test repo (#29), never a real project.

## Risks

Roughly in order of how much damage each would do.

| Risk                                                                | How it's tested                                                                                                                                                                                                                                                              | Status                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| The agent writes to a repo without human approval                   | `apply_patch` and `open_pr` refuse without an approval record for those specific patches, and the model can't create one (integration); approve and reject flows (E2E)                                                                                                       | Planned (#27, #29); see gap 2                       |
| A secret from a user's repo reaches a prompt                        | A test plants a fake secret and fails if any recorded LLM request contains it; denylisted files are never returned. For page HTML in explanations, tests plant secrets (passwords, hidden inputs, URL tokens, a type cut off by truncation) and check none reaches a request | Explanations running; repo files planned (#21, #26) |
| A GitHub token is logged or leaks                                   | A test fails if the token appears in captured logs                                                                                                                                                                                                                           | Planned (#27); see gap 2                            |
| A model-supplied path escapes the repo                              | `read_file` rejects `../`, absolute paths, and symlinks that leave the repo; `propose_patch` rejects diffs touching other files                                                                                                                                              | Planned (#26)                                       |
| A scan reaches a private network (SSRF)                             | `guard.test.ts` covers address and URL checks; `scanner.test.ts` drives real Chromium through the proxy, including private targets                                                                                                                                           | Running                                             |
| A stranger uses the app and spends our LLM budget                   | `access.test.ts` and `routes.test.ts` cover the allowlist and session checks; the E2E sign-in gate covers the real flow                                                                                                                                                      | Running; E2E planned (#29)                          |
| A bug or runaway loop overspends                                    | Provider tests refuse calls past the monthly budget and unpriced models; agent limits (25 steps, cost cap, 5 minutes); eval tiers stop at their cap as incomplete                                                                                                            | Budget running; limits and caps planned (#22, #17)  |
| A prompt or model change makes fixes worse                          | Eval gates: pass rate and at most a 5-point drop against the latest `main` run, with a score diff posted on the PR                                                                                                                                                           | Planned (#9, #16, #17)                              |
| The model "fixes" code that was already correct                     | No-change cases: any diff fails scorer (c), and no-change accuracy is gated at 90%                                                                                                                                                                                           | Scorer running; gate planned (#14, #17)             |
| A fix doesn't resolve the issue, or adds a new one                  | Scorer (a) compares axe results on the input and the patched file; on a real PR, the re-scan compares fingerprints                                                                                                                                                           | Scorer running; re-scan planned (#28)               |
| A fix breaks the build                                              | Scorer (b) on eval fixtures, gated at zero build breaks. User repos get no build check in v1, so their own CI is the backstop                                                                                                                                                | Scorer running; gate planned (#17)                  |
| A rendered issue is mapped to the wrong source file                 | Repo-mode cases record the correct files, and a scorer reports mapping accuracy                                                                                                                                                                                              | Planned (#25); see gap 5                            |
| The re-scan misreports what was fixed                               | Unit tests on fingerprint comparison, including the order-dependent `:2` suffixes the [plan](project-plan.md#data-model) warns about; a manual run before release                                                                                                            | Planned (#28, #34); see gap 1                       |
| The job queue loses or double-runs work                             | `worker.test.ts` runs the worker against real Postgres                                                                                                                                                                                                                       | Running                                             |
| Our own app has accessibility bugs                                  | `jsx-a11y` strict now; a hand axe run on each UI PR until axe on every page and state becomes a merge gate; manual pass before release                                                                                                                                       | Partly running (#30, #34); see gap 3                |
| The judge's scores can't be trusted                                 | Calibrated against 15 hand labels, with agreement within 1 point reported (target 80%+, from #15)                                                                                                                                                                            | Planned (#15)                                       |
| An axe upgrade quietly changes results                              | The sample-site scan and `--reference` both fail if a seeded issue or case input stops reporting as expected                                                                                                                                                                 | Running                                             |
| The render harness or E2E is flaky, and people stop trusting checks | `--reference` must score 100%, so any harness flake shows up on every PR; E2E uses replay and uploads traces on failure                                                                                                                                                      | Harness running; E2E planned (#29)                  |
| Packages drift from the shared contract                             | Schemas are strict and tested in `packages/core`, and CI fails if the database schema and its migrations disagree                                                                                                                                                            | Running                                             |

## Quality metrics

The eval gates come from the plan's [thresholds](project-plan.md#eval-design) and are starting values, to be tuned after the first full run in M2. The other targets come from the plan's scorers and milestones, or from the rule the check itself enforces.

| Metric                             | Target                          | Blocks merge | Source                                 |
| ---------------------------------- | ------------------------------- | ------------ | -------------------------------------- |
| Eval pass rate                     | ≥ 70% in M2, ≥ 85% by M5        | Yes          | Full or smoke tier                     |
| Drop against the latest `main` run | No more than 5 points           | Yes          | Compare command (#16)                  |
| Build breaks, scorer (b)           | 0                               | Yes          | Eval runner                            |
| No-change accuracy                 | ≥ 90%                           | Yes          | Eval runner                            |
| Harness self-check (`--reference`) | 100%                            | Yes          | CI, running now                        |
| Sample-site scan                   | All seeded issues, nothing else | Yes          | CI, running now                        |
| axe violations in our own app      | 0                               | Yes          | E2E (#30)                              |
| E2E duration                       | Under 10 minutes                | No           | CI (#29)                               |
| Cost per case                      | Within the tier's cap           | Warn only    | Eval runner                            |
| p95 latency                        | Tracked                         | Warn only    | Eval runner                            |
| Judge agreement with hand labels   | ≥ 80% within 1 point            | No           | Calibration (#15)                      |
| Mapping accuracy                   | Tracked, see gap 5              | No           | Repo-mode evals (#25)                  |
| Monthly LLM spend                  | $20, including evals            | Budget guard | Provider ledger (running), view in #31 |

How they're reported:

- **Today:** the CI check on the PR, plus the runner's summary table and JSON report in `packages/evals/reports/` (gitignored).
- **On a PR (#17):** a comment with the score diff against `main`, broken out by category.
- **Over time (#16, #18):** `eval_runs` and `eval_results`, charted on the `/evals` page, which also compares any two runs case by case.
- **For prompt changes:** before and after numbers in `docs/prompt-log.md` (M2).
- **For a release (#34):** the results recorded in `docs/release-checklist.md`.
- **For spend (#31):** month-to-date spend against the budget in the app.

## Gaps

Things the issues and plan didn't cover when this was written. We went through them on #52, so each one now says what we agreed. Where it names an issue, that issue still needs updating to match.

1. **Re-scan has no E2E coverage.** M4's "done when" includes a re-scan that confirms the fixes, but #29's flows stop at opening a PR, and waiting on a preview deploy is slow. Agreed: unit tests on the comparison in #28, and a manual run in the release checklist (#34).
2. **Two rules had no assigned test.** #27 tests that the tools refuse without an approval record, but nothing tested AGENTS.md's stricter rule that the model can't create that record, or that GitHub tokens are never logged. Agreed: add both to #27.
3. **Our own app's axe gate arrives after our first UI.** M1's "done when" says our app passes axe, but the gate (#30) is in M4, and until then the only automated check is `jsx-a11y`. Agreed: a hand axe run is required on every UI PR, starting with #8, until the gate lands. This is now in the [plan](project-plan.md#m1--url-scan-explanations-seed-evals-weekends-12).
4. **Replay and prompt changes don't fit together yet. Still open, and must be decided before #17 is built.** Recordings are keyed on the whole request, so a prompt PR misses every recording in the replay tier. The proposal is for #17 to skip the replay tier when prompts changed, since the smoke tier covers those PRs, and to re-record after merge. This needs deciding along with where the recordings live.
5. **Mapping accuracy has no target.** The plan tracks it but sets no threshold. Agreed: set one after the first repo-mode run.
6. **The plan's `eval_runs.trigger` says `nightly`, but the full tier is weekly.** Agreed: fix it in #16, and update the plan there.
7. **The dataset and the plan use different categories.** The dataset README has six (`images`, `names`, `forms`, `aria`, `contrast`, `structure`), while the plan's targets use nine, including keyboard and no-change. Agreed: reconcile them in #14, because the PR comment reports by category.
