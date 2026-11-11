# Judge calibration

The LLM judge, scorer (d), scores fixes 1–5 against the rubric in [`src/scorers/judge.ts`](../src/scorers/judge.ts) (#15). This folder holds the fixes a person labels against the same rubric, so we can check that the judge agrees with them. The target is the judge within 1 point of the label on 80% of items.

```bash
npm run evals:calibrate                  # judge every labelled item and report agreement
```

The judge follows `LLM_MODE` like the runner: `record` calls Haiku (15 calls, about a cent) and saves the answers to `LLM_RECORDINGS_DIR`, and `replay` (the default) serves them for free.

## Layout

```
labels.json              the items and their labels
items/<id>/<file>.tsx    the file as the fix leaves it, for the case's input
```

Each item names a dataset case (a fix case) and the case version it was written for. Its diff is computed from the case's input, so it can't drift. A `reference` item is the case's `expected/` file; a `variant` is a different fix, some fine and some flawed on purpose. ESLint and Prettier skip `items/`.

## Labelling

Set each item's `label` to `{ "score": 1-5, "reason": "..." }`, scoring the diff against the rubric in `judge.ts`, without running the judge first. A test checks every item against the dataset, so a case change that leaves an item stale fails CI: update the item, bump its `caseVersion`, and relabel it.

Label against the judge prompt's rubric, not the agent's eventual output. Once `proposeFix` lands (#9), swap some variants for real proposals.
