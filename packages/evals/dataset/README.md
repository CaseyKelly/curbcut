# Eval dataset

Each case is one accessibility issue in one React component, with the outcome the agent should reach. The runner (#13) gives the agent the input file and the issue, then scores what it proposes.

```bash
npm run evals:validate                 # check every case and the manifest
npm run evals -- --reference           # check the runner: the reference answers should all pass
npm run evals -- --rescore <report>    # re-score a saved run, for free
npm run evals -- --case <id> --case …  # only these cases
```

The runner scores each case with (a) resolved, (b) build safe, (c) scoped, and (e) cost and latency, prints a summary table, and writes a JSON report to `packages/evals/reports/` (or `--out`). Scoring (a) needs Chromium: `npx playwright install chromium`. The live fixer, which calls `proposeFix`, arrives with #9.

## Layout

```
manifest.json            datasetVersion and the list of case ids
CHANGELOG.md             what changed in each datasetVersion
tsconfig.json            type-checks every input/, expected/ and test.tsx file
cases/<id>/
  case.json              an EvalCase (packages/core)
  input/<file>.tsx       the file as the agent sees it
  expected/<file>.tsx    optional: a reference fix, for fix cases only
  test.tsx               optional: the case's own test, run by scorer (b)
```

- **`case.json`**: `id` matches the folder. `version` starts at 1 and is bumped whenever the case changes. `framework` is `react` (the only one so far). `filePath` names the file under `input/`. `issue` is the axe violation as the scanner reports it (#5). `expectedOutcome` is `fix`, `no_change_needed`, or `unsure`. `allowedLines` (fix cases only) are the 1-based input lines a fix may touch. Scorer (c) fails a diff outside them, so leave room for other reasonable fixes, not just the reference one.
- **`input/`**: only the file at `filePath`, nothing else the agent could read. That file is self-contained and default-exports a component taking no props, so the harness can render it on its own. Imports are limited to `react`. Styles live in the file, inline or in a `<style>` element, so contrast cases render the same anywhere. Inputs must compile: the bugs are accessibility bugs, not type errors.
- **`test.tsx`**: a Vitest test, run in jsdom against the patched file, for behaviour axe can't see (the dismiss button still dismisses). It imports the component from `./input/<filePath>`.
- **`expected/`**: the fix we'd want, which the LLM judge (#15) can compare against. It must hold only `filePath`, and every change must fall inside `allowedLines`. An added line counts as inside when a line next to it is allowed.

## Outcomes

- **`fix`**: the issue is real and belongs in this file.
- **`no_change_needed`**: the report is stale and the code is already correct, often in a way an over-eager agent would "improve" (a decorative `alt=""`, a visually hidden label). Any diff fails.
- **`unsure`**: the fix needs information the code doesn't have, such as where an unlabelled icon link goes. The agent should ask rather than guess.

## Categories

Every case has one of the plan's nine categories, and the validator rejects anything else. The PR comment reports by category. The sample site's manifest has its own categories, which aren't these.

| `category`          | What goes in it                                                         | Target |
| ------------------- | ----------------------------------------------------------------------- | ------ |
| `text-alternatives` | Images, SVGs, icon-only buttons, image maps, frame titles               | 8      |
| `form-labels`       | Unlabelled fields, submit inputs with no name, autocomplete tokens      | 7      |
| `aria`              | Invalid roles and attributes, missing required ones, `aria-hidden`      | 7      |
| `keyboard`          | Nested controls, unreachable frames, `div`s with `onClick`              | 6      |
| `no-change`         | Every `no_change_needed` case, whatever its topic                       | 6      |
| `contrast`          | Inline styles, theme tokens, utility classes                            | 5      |
| `structure`         | Lists, definition lists, table headers, `lang` on an element            | 5      |
| `names`             | Links and buttons with no name                                          | 4      |
| `needs-human`       | Every `unsure` case, whatever its topic                                 | 2      |

`no-change` and `needs-human` are outcomes, so they're tied to `expectedOutcome` both ways. Their topic is still in `issue.ruleId`.

**A case's target rule has to be one axe reports**, because scorer (a) fails a fix case whose input doesn't report it. Scans use the WCAG A and AA tags, so `best-practice` rules (`tabindex`, `heading-order`, landmarks) can't be targets. Nor can the document's `lang` and `<title>`, which the harness supplies, or bugs axe has no rule for, like placeholder-only labels and "click here" links. For a bug axe only half sees, such as a `div` with `onClick` and a role, target what axe does report and use `test.tsx` to check the rest (see `aria-required-attr-div-switch`). Check that the test fails on the input and accepts a custom control as well as a native one.

**Check that the obvious fix can pass.** Scorer (b) lints with `jsx-a11y` strict, and a new error counts as a merge-blocking build break. If a case's usual fix breaks a lint rule, either drop the case or, when axe's own fix is what the rule forbids, add the pair to `LINT_EXEMPTIONS` in `src/scorers/build.ts`. The one exemption so far: `tabIndex={0}` for `scrollable-region-focusable`, which trips `no-noninteractive-tabindex`.

## Tags

`smoke` marks the cases in the smoke tier: about 15, with at least one in every category. Keep the spread roughly in line with the targets.

## Adding or changing a case

1. Add the folder and its id in `manifest.json`. When a case changes, bump its `version`. Bump `datasetVersion` whenever any case is added, removed, or changed, so results from different versions aren't compared, and add an entry to `CHANGELOG.md`. Every eval result records both versions.
2. Take `issue` from a real axe run on the input, client-rendered with React (as the scanner sees it, not server-rendered markup) inside `<html lang="en">` with a `<title>` and a `<main>`. For fix and unsure cases, axe should report exactly that one violation. For no-change cases it should report nothing, and `issue` is what an earlier version of the file produced. A fix case's `expected/` file should come back clean.
3. Run `npm run evals:validate` and `npm run typecheck`. CI checks both through `npm run check`, which includes a test that validates this dataset.

Don't comment the bugs in the input files: the agent reads them.

ESLint and Prettier skip this folder because the inputs are broken on purpose.
