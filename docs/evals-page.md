# `/evals` page spec

The views behind issue #18: what the page shows and how it behaves. Upasana specifies, Casey builds (plan, M2). The plan's [tracking over time](project-plan.md#eval-design) says why the page exists: "That comparison is how a prompt change gets accepted or rejected." Everything here serves that question: **did this change make the fixer better or worse, and on which cases?**

## Scope

Two views, both behind sign-in like every other page:

| Route            | What it answers                                                   | Issue criteria               |
| ---------------- | ----------------------------------------------------------------- | ---------------------------- |
| `/evals`         | How is the fixer doing on `main` over time, metric by metric?     | Chart each metric over time  |
| `/evals/compare` | What changed between two runs, overall, by category, and by case? | Pick two runs, see each case |

Both have to pass our own axe scan with zero violations, work with only a keyboard, and give every chart a text alternative (the third criterion). [Accessibility](#accessibility) says what that means for charts.

Out of scope for #18: a page for a single run (the comparison covers what changed, and the runner's report covers the rest), editing or deleting runs, starting a run from the UI, and cost views beyond eval spend (#31 covers spend as a whole).

## Data

The page reads what #16 stores, and computes comparisons with the same code as the CLI and the PR comment, so the three can never disagree.

- **`eval_runs`**: one row per saved run, with `git_sha`, `branch`, `trigger` (`pr`, `weekly`, `manual`), `dataset_version`, `model`, `prompt_version`, `axe_version`, `totals` (a `RunTotals`, parsed on read), `cost_usd`, and `created_at` (when the run started).
- **`eval_results`**: one row per case, with the outcome, each score, the judge's reason, notes, the proposal (diff included), cost, latency and `pass`.
- **Loading and comparing**: `loadRun`, `latestRun`, and `compareRuns` in `packages/evals/src/store/` (#16). Don't reimplement these in the web app. Export them from `@curbcut/evals` (see [Open questions](#open-questions)).

Follow the scan page's layout: database queries in `apps/web/lib/evals-queries.ts`, the page's own Zod view schemas in `apps/web/lib/evals-view.ts` (no database imports), server components in `apps/web/app/evals/`. Nothing on either view needs client JavaScript: run pickers are a plain `GET` form, and charts are rendered on the server.

**Comparable runs.** Results from different dataset versions aren't compared (test strategy). That rule shapes both views: trends show one dataset version at a time, and the comparison refuses a pair from different versions and says why.

## View 1: `/evals`, trends on `main`

```text
Evals                                             Dataset [v2 ▾]  [Show]
─────────────────────────────────────────────────────────────────────────
Latest main run · 14 Nov · a1b2c3d · weekly · sonnet-5-5 · fix-v2
  Pass rate 84.3% (−2.0 pts)   No-change 100%   Build breaks 0   Cost $1.92

Pass rate                                       ▸ Show data
  100% ┤
   85% ┤- - - - - - - - - - - - - - - - - - - - - -  M5 target
   70% ┤─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  M2 gate
       │      ●───●───●       ●───●
       │  ●───●       ╲───●───╯     prompt fix-v2 ▲
       └──────────────────────────────────────────
(same layout for the other charts)

Runs on main (dataset v2)
  Date    Commit   Trigger  Model       Prompt  Pass   Cost   Compare
  14 Nov  a1b2c3d  weekly   sonnet-5-5  fix-v2  84.3%  $1.92  [with previous]
  ...
```

**Which runs.** Runs with `branch = 'main'` and the chosen `dataset_version`, oldest to newest, at most the latest 50. The dataset picker lists every version that has a main run, newest first, with its run count, and defaults to the newest. PR runs never appear in trends: they'd mix unmerged changes into `main`'s line. Once #17 marks runs that stopped at their cost cap as incomplete, leave those out of the charts (list them in the table, labelled "incomplete"), because a partial run would show up as a fake dip.

**Latest run summary.** The latest run's headline numbers, each with its change from the previous main run, in the same units and wording as the CLI: rates in percent, changes in points.

**Charts.** One small chart per metric, all with the same x axis (runs in order, labelled by date):

| Chart              | From `totals`                          | Reference line                         |
| ------------------ | -------------------------------------- | -------------------------------------- |
| Pass rate          | `passRate`                             | 70% (M2 gate) and 85% (M5 target)      |
| Fix cases          | `byExpected.fix`, as a rate            | none                                   |
| No-change accuracy | `byExpected.no_change_needed`, a rate  | 90% (gate)                             |
| Build breaks       | `buildBreaks`                          | 0 (gate): any point above it is a fail |
| Errors             | `errors`                               | none                                   |
| Cost per run       | `costUsd`, plus `judgeCostUsd` stacked | the tier's cap, once #17 sets it       |
| p95 latency        | `latencyMs.p95`                        | none                                   |

The thresholds come from the plan's [threshold table](project-plan.md#eval-design). Define them once in code (they're shared with #17's gate), not as numbers in the page.

**Marking changes.** A trend is only useful if you can see what caused a step in it. Mark each point where `prompt_version` or `model` differs from the previous run with a labelled tick under the axis ("prompt fix-v2", "model sonnet-5-5"), and give it its own row in the data table. This is how prompt iteration #1 (#19) shows its before and after.

**By category.** Below the charts, a table of each category's pass rate (passed out of cases) for the latest five main runs, newest first. A table, not a heatmap: there are nine categories, and a table is readable without color.

**Run table.** Every run in the trend, newest first: date, commit (short SHA, linked to the commit on GitHub), trigger, model, prompt version, pass rate, cost, and a "Compare with previous" link to the comparison view with the previous run as the base.

**Empty states.**

- No runs at all (true until the live fixer, #9, and the CI workflow, #17, land): say that runs appear here once CI saves them, and give the command that saves one by hand, `npm run evals:save -- <report.json> --trigger manual`.
- One run for this dataset version: show its numbers and table row, with a line saying a trend needs two runs. No single-point charts.

## View 2: `/evals/compare`, two runs case by case

`/evals/compare?base=<run id>&head=<run id>`. Either side can be `main`, meaning the latest main run on the other run's dataset version, as in the CLI. That makes `/evals/compare?base=main&head=<id>` the link #17's PR comment can point at.

```text
Compare runs
  Base [main (latest) ▾]   Head [14 Nov · pr/fix-alt · c4d5e6f ▾]   [Compare]

Head c4d5e6f (pr/fix-alt, fix-v3) against base a1b2c3d (main, fix-v2)
Dataset v2 · 51 shared cases

Metric               Base     Head     Change
Pass rate            84.3%    86.3%    +2.0 pts
No-change accuracy   100.0%   83.3%    −16.7 pts   ✕ below the 90% gate
...

By category  (same columns)

Cases that changed (3)              [Show all 51 cases]
  ▸ Regressed  aria-hidden-focus-duplicate-link-is-correct
        outcome: no_change_needed → fix
  ▸ Fixed      label-missing-email
  ▸ Changed    image-alt-product-photo    (d) judge: 3 → 5
```

**Picking runs.** Two native `<select>`s and a submit button, in a `GET` form, so the URL is the state and can be shared. Each option reads "date · branch · short SHA · prompt version". The lists hold the 100 most recent runs, any branch, newest first, plus a `main (latest)` option at the top. With no runs given, base defaults to `main` and head to the most recent run.

**Header.** For each run: branch, commit (linked), trigger, model, prompt version, dataset version, and date. Then the number of shared cases, and any cases in only one run ("Only in head: …"), as `compareRuns` reports them.

**Metrics.** `compareRuns(base, head).metrics`, in the order it returns them: base, head, and the change. A change gets a word, not just a color: "+2.0 pts", "−1", "no change". Where head crosses one of the plan's gates (pass rate below 70%, a drop of more than 5 points, any build break, no-change accuracy below 90%), the row says so in text ("below the 90% gate"), with an icon as well as color. These are the same checks #17 fails a PR on, so take them from the same code.

**Categories.** `compareRuns(...).categories`: category, base and head as "passed/cases", and the change in points.

**Cases.** Changed cases first, grouped and ordered as `compareRuns` returns them: regressed, then fixed, then changed. Each is a `<details>` element: the summary line shows the change and the case id, and opening it shows, for base and head side by side (stacked on narrow screens):

- outcome, and expected outcome
- scores (a) to (c) as "pass" or "fail", and the judge's score and reason if there is one
- the notes (why a scorer failed)
- the proposal's diff, in a scrollable `<pre>`, or the question for an `unsure` outcome

"Show all cases" (a link that adds `&all=1`) lists unchanged cases too, after the changed ones.

**Errors.** An unknown or malformed run id is a 404, as on the scan page. Two runs on different dataset versions show the message `compareRuns` throws ("results from different dataset versions aren't compared") in place of the results, with the pickers still there. `main` with no main run for that dataset version says so in the same place.

## Accessibility

Our own UI follows the same rules as the code we fix (AGENTS.md: zero axe violations, keyboard only, native elements over ARIA). For this page:

- **Every chart has a data table.** Each chart sits in a `<figure>` with a `<figcaption>` naming the metric, followed by a `<details>` ("Show data") holding a `<table>` with a `<caption>`, `<th scope>` headers, and one row per run: date, commit, prompt version, the value, and the change from the previous run. The table is the real text alternative; the chart is a quick view of it.
- **Every chart has a summary.** The `<svg>` gets `role="img"` and an `aria-label` that says what you'd learn by looking, generated from the data: "Pass rate over 12 runs: from 71% to 84%, latest 84%, above the 70% gate." Mark its contents `aria-hidden` so screen readers don't walk the points.
- **Nothing depends on color.** Threshold lines are dashed and labelled in text. Points where `prompt_version` or `model` changes have a text label. Regressions and gate failures are written out ("regressed", "below the 90% gate"), with an icon besides any red. Lines and points have 3:1 contrast with the background and text 4.5:1, in light and dark mode.
- **No hover-only information.** There are no tooltips; any value you'd hover for is in the data table.
- **Keyboard.** Run pickers are native `<select>`s with labels, the form submits with Enter, and `<details>` opens with Enter or Space. Focus is visible on every control.
- **Structure.** One `<h1>` per page, an `<h2>` for each section (latest run, each chart, by category, runs), and tables for anything tabular.
- **Motion.** No chart animation.
- **Checking it.** Until the axe gate lands (#30), the PR needs a hand axe run on both views, including the empty states and an open `<details>` (plan, M1).

## Building it

Suggested order, so each step is reviewable on its own:

1. Export the store functions from `@curbcut/evals` and read runs in `lib/evals-queries.ts`, with tests against the test database (like `scan-queries.test.ts`).
2. `/evals/compare`: every piece is a table, so it's the quicker one, and it's the link #17 needs.
3. `/evals`: the summary, run table and category table first, then the charts.

**Charts.** Hand-written SVG from a server component is enough here: line charts with a few dozen points, no zooming, no interaction. That keeps the page free of client JavaScript and puts the accessible structure above under our control. A charting library is fine too if it's simpler, as long as it renders on the server or still meets every rule above.

**Tests.** Unit tests for the view-building code (trend points, change markers, gate checks, the `aria-label` summaries), plus a check that `/evals` and `/evals/compare` check the session, which `routes.test.ts` already enforces. E2E for these views is #29's call.

## Open questions

1. **Importing `@curbcut/evals` into the web app.** Its package exports only an empty `index.ts`, and its source imports with `.ts` extensions, which Next may not resolve. Options: a subpath export (say `@curbcut/evals/store`) added to `transpilePackages`, or moving `compareRuns` somewhere both can reach. Casey's call; whichever it is, the CLI, the PR comment and this page must share one implementation.
2. **Judge trend.** A mean judge score per run would be worth charting once the judge runs in CI (#15), but `RunTotals` doesn't carry one yet. Adding it is an evals change (Upasana); add the chart then.
3. **Incomplete runs.** #17 decides how a run that hit its cost cap is marked. This page needs that marker to leave such runs out of the charts.
4. **Where the gate thresholds live.** The page and #17's check both need them. They should be one constant, probably next to `compareRuns`, defined when #17 lands. Until then, the page can show the reference lines without the gate wording.
