# Dataset changelog

One entry per `datasetVersion`, newest first. Results from different versions aren't compared, so say what changed and what that does to the numbers.

## v2

Grew the dataset from 20 to 51 cases and adopted the plan's categories (#14). `keyboard` has 7 cases, one over its target, because `scrollable-region-focusable-release-notes` joined once scorer (b) stopped failing its usual fix.

- **Added 31 cases**, version 1.
- **Replaced the six categories with the plan's nine**, so the PR comment's rows match the plan's targets. Moved cases keep their id, and any whose `case.json` changed went to version 2. `no-change` and `needs-human` now hold every case with those outcomes, so `button-name-hidden-text-is-correct`, `image-alt-empty-alt-is-correct`, `label-visually-hidden-is-correct` and `link-name-unclear-destination` left their topic categories. No input, reference fix, or expected outcome changed in an existing case.
- **Tagged 15 cases `smoke`**, spread across all nine categories.

Comparing with v1: per-case results for existing cases are still comparable, but category totals are not.

## v1

The seed set: 20 cases, including 3 no-change and 1 unsure (#12).
