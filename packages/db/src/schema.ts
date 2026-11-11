// Drizzle schema for the M1 tables and the M2 eval tables. After changing it, run `npm run db:generate`
// and commit the new migration in `drizzle/`; CI fails if they drift apart.
// Follows the data model in the project plan. Enums that also exist in
// `@curbcut/core` take their values from there, so the database and the Zod
// schemas can't disagree. Flexible payloads (job input, agent steps,
// explanation bodies) are jsonb, validated by the core schemas on the way in
// and out.
import {
  AgentStep,
  Impact,
  PatchOutcome,
  RunEndReason,
  type IssueExplanation,
} from '@curbcut/core';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
  uuid,
} from 'drizzle-orm/pg-core';

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** Spend in US dollars. numeric, not float, so per-call costs add up exactly. */
const costUsd = numeric('cost_usd', { precision: 12, scale: 6, mode: 'number' })
  .notNull()
  .default(0);

/** Token counts split by direction, since they're priced differently. */
const tokens = {
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
};

/**
 * Budgets and limits (#6, #22) sum these columns, so a negative value from a
 * pricing bug would quietly let a run overspend.
 */
const nonNegative = (name: string, ...columns: AnyPgColumn[]) =>
  check(
    name,
    sql.join(
      columns.map((c) => sql`${c} >= 0`),
      sql` AND `,
    ),
  );

// ---------------------------------------------------------------------------
// Enums

/** Zod types `.options` as a plain array; pgEnum wants a non-empty tuple. */
const values = <T extends string>(options: readonly T[]) => options as [T, ...T[]];

export const impact = pgEnum('impact', values(Impact.options));
export const runEndReason = pgEnum('run_end_reason', values(RunEndReason.options));

export const jobType = pgEnum('job_type', ['scan', 'explain', 'fix', 'rescan']);
export const jobStatus = pgEnum('job_status', ['queued', 'running', 'succeeded', 'failed']);
export const scanStatus = pgEnum('scan_status', ['queued', 'running', 'completed', 'failed']);
/** Where a completed scan's explanations stand (#7). Its own enum: a scan can be done while explaining isn't. */
export const explainStatus = pgEnum('explain_status', [
  'pending',
  'running',
  'completed',
  'failed',
]);
/**
 * A run waiting for a human is `awaiting_approval`, not ended, so it can resume
 * (#27). Only `ended` runs have an `end_reason`.
 */
export const agentRunStatus = pgEnum('agent_run_status', ['running', 'awaiting_approval', 'ended']);
/** `pipeline`: the fixed scan and explain steps (M1). `agent`: the tool loop (#22). */
export const agentRunKind = pgEnum('agent_run_kind', ['pipeline', 'agent']);
export const agentStepType = pgEnum(
  'agent_step_type',
  values(AgentStep.options.map((o) => o.shape.type.value)),
);

// ---------------------------------------------------------------------------
// Job queue (#5)

/**
 * Work for the worker. Claimed with `SELECT ... FOR UPDATE SKIP LOCKED` on
 * `status = 'queued' AND run_at <= now()`. A failed attempt, or a job stuck in
 * `running` with an old `locked_at`, is requeued with a later `run_at` for
 * backoff until `attempts` reaches `max_attempts`.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: jobType('type').notNull(),
    /** Type-specific input, e.g. `{ scanId }`. */
    payload: jsonb('payload').notNull(),
    status: jobStatus('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    /** Not claimable before this time. */
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    error: text('error'),
    createdAt,
  },
  (t) => [
    index('jobs_claim_idx')
      .on(t.runAt)
      .where(sql`${t.status} = 'queued'`),
    index('jobs_stale_idx')
      .on(t.lockedAt)
      .where(sql`${t.status} = 'running'`),
    check('jobs_attempts_check', sql`${t.attempts} >= 0 AND ${t.maxAttempts} >= 1`),
  ],
);

// ---------------------------------------------------------------------------
// Scans and issues (#5, #7, #8)

export const scans = pgTable(
  'scans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Page URLs to scan. M1 scans one URL; an array so crawling can add more
     * without changing what the column means.
     */
    targets: text('targets').array().notNull(),
    /**
     * Saved login to scan behind. Always null in M1; the `auth_profiles` table
     * and its foreign key come with the login feature.
     */
    authProfileId: uuid('auth_profile_id'),
    /** Repo to map and fix issues in. The `repos` table and foreign key come in M3 (#20). */
    repoId: uuid('repo_id'),
    /** For a re-scan, the scan it verifies (#28). */
    parentScanId: uuid('parent_scan_id').references((): AnyPgColumn => scans.id, {
      onDelete: 'set null',
    }),
    status: scanStatus('status').notNull().default('queued'),
    error: text('error'),
    /**
     * The explain job's progress (#7): null if the scan found nothing to
     * explain. `pending` also covers a job being retried, with the last error
     * in `explainError`. `failed` means no more attempts, so the UI should say
     * so rather than wait.
     */
    explainStatus: explainStatus('explain_status'),
    /**
     * Why explaining failed, or what a `completed` run left out (groups the
     * model couldn't answer, whose issues have no explanation).
     */
    explainError: text('explain_error'),
    axeVersion: text('axe_version'),
    /** Totals across the scan's runs (#31). */
    ...tokens,
    costUsd,
    /** Who started the scan. The numeric GitHub user id is stable; logins can be renamed. */
    createdByGithubId: bigint('created_by_github_id', { mode: 'number' }).notNull(),
    /** Their login at the time, for display. */
    createdByLogin: text('created_by_login').notNull(),
    createdAt,
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    check('scans_targets_not_empty', sql`cardinality(${t.targets}) >= 1`),
    index('scans_created_at_idx').on(t.createdAt),
    index('scans_parent_scan_id_idx').on(t.parentScanId),
    nonNegative('scans_totals_check', t.inputTokens, t.outputTokens, t.costUsd),
  ],
);

/** One row per `A11yIssue`. */
export const issues = pgTable(
  'issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    ruleId: text('rule_id').notNull(),
    impact: impact('impact').notNull(),
    help: text('help').notNull(),
    helpUrl: text('help_url').notNull(),
    wcag: text('wcag').array().notNull(),
    pageUrl: text('page_url').notNull(),
    selector: text('selector').notNull(),
    html: text('html').notNull(),
    failureSummary: text('failure_summary'),
    fingerprint: text('fingerprint').notNull(),
    /**
     * Issues in a group share one explanation (#7). Group order (impact, then
     * count) is derived when reading, so it can't disagree within a group.
     */
    groupKey: text('group_key').notNull(),
    /**
     * The group's explanation, set on every issue in the group once it's
     * explained (#7). Null while pending, or if the group couldn't be explained.
     */
    explanationId: uuid('explanation_id').references((): AnyPgColumn => explanations.id, {
      onDelete: 'set null',
    }),
    createdAt,
  },
  (t) => [
    // The fingerprint leaves out the page so crawls can dedupe across pages;
    // within a page it's unique, which also makes a retried job's inserts idempotent.
    uniqueIndex('issues_scan_page_fingerprint_idx').on(t.scanId, t.pageUrl, t.fingerprint),
    // Matching fingerprints across scans when re-scanning (#28).
    index('issues_fingerprint_idx').on(t.fingerprint),
    index('issues_scan_group_idx').on(t.scanId, t.groupKey),
  ],
);

/**
 * Cached `IssueExplanation`s (#7). Not tied to a scan: any issue group with
 * the same cache key reuses the row, so a cache hit costs nothing.
 */
export const explanations = pgTable(
  'explanations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Hash of rule + a hash of the prompt input (the elements' HTML and
     * failure summaries, the rule's summary and criteria) + prompt version +
     * model.
     */
    cacheKey: text('cache_key').notNull().unique(),
    ruleId: text('rule_id').notNull(),
    /** An `IssueExplanation`. */
    body: jsonb('body').$type<IssueExplanation>().notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    ...tokens,
    costUsd,
    createdAt,
  },
  (t) => [nonNegative('explanations_totals_check', t.inputTokens, t.outputTokens, t.costUsd)],
);

// ---------------------------------------------------------------------------
// Agent runs (#6, #22)

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    kind: agentRunKind('kind').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    status: agentRunStatus('status').notNull().default('running'),
    endReason: runEndReason('end_reason'),
    /** Counted against the 25-step limit (#22). */
    stepsUsed: integer('steps_used').notNull().default(0),
    /** Totals across every LLM call in the run, for the cost cap (#6). */
    ...tokens,
    costUsd,
    createdAt,
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    index('agent_runs_scan_id_idx').on(t.scanId),
    // A pause is a status, never an end reason, so a paused run can't look finished.
    check(
      'agent_runs_end_reason_check',
      sql`(${t.status} = 'ended') = (${t.endReason} IS NOT NULL) AND ${t.endReason} IS DISTINCT FROM 'awaiting_approval'`,
    ),
    nonNegative('agent_runs_totals_check', t.stepsUsed, t.inputTokens, t.outputTokens, t.costUsd),
  ],
);

/**
 * One row per `AgentStep`, streamed to the UI (#8, #22). `seq` is the step's
 * `index`; `payload` holds the rest of the step and is parsed with
 * `AgentStep` when read.
 */
export const agentSteps = pgTable(
  'agent_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: agentStepType('type').notNull(),
    payload: jsonb('payload').notNull(),
    /** The LLM call that produced this step, if any. */
    ...tokens,
    costUsd,
    createdAt,
  },
  (t) => [
    uniqueIndex('agent_steps_run_seq_idx').on(t.runId, t.seq),
    nonNegative('agent_steps_totals_check', t.seq, t.inputTokens, t.outputTokens, t.costUsd),
  ],
);

// ---------------------------------------------------------------------------
// Eval runs (#16)

/**
 * What started an eval run, matching the eval tiers in the plan: PRs run the
 * replay or smoke tier, and the full tier runs weekly or on a manual dispatch
 * (which also covers the run before a release).
 */
export const evalTrigger = pgEnum('eval_trigger', ['pr', 'weekly', 'manual']);
/** A case's outcome: what the fixer proposed, or `error` if it crashed first. */
export const evalOutcome = pgEnum(
  'eval_outcome',
  values<PatchOutcome | 'error'>([...PatchOutcome.options, 'error']),
);
export const patchOutcome = pgEnum('patch_outcome', values(PatchOutcome.options));

/**
 * One live eval run, saved from the runner's JSON report. Reference
 * self-checks aren't saved, so they can't become a baseline.
 */
export const evalRuns = pgTable(
  'eval_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    gitSha: text('git_sha').notNull(),
    branch: text('branch').notNull(),
    trigger: evalTrigger('trigger').notNull(),
    /** Results from different dataset versions aren't compared. */
    datasetVersion: integer('dataset_version').notNull(),
    model: text('model').notNull(),
    /** The fixer's prompt version; prompts pin their text to it by hash in tests. */
    promptVersion: text('prompt_version').notNull(),
    axeVersion: text('axe_version'),
    /** The report's `RunTotals`, parsed with that schema when read. */
    totals: jsonb('totals').notNull(),
    /** Also in `totals`; a column so the monthly budget can sum it (#6). */
    costUsd,
    /** When the run started (the report's `createdAt`), so the latest run is the newest code. */
    createdAt,
  },
  (t) => [
    // The baseline lookup: the latest run on a branch for a dataset version.
    index('eval_runs_baseline_idx').on(t.branch, t.datasetVersion, t.createdAt),
    index('eval_runs_created_at_idx').on(t.createdAt),
    nonNegative('eval_runs_totals_check', t.costUsd),
  ],
);

/**
 * One row per case in a run: an `EvalResult` plus what the report keeps
 * alongside it, so a stored run can be compared like a report.
 */
export const evalResults = pgTable(
  'eval_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => evalRuns.id, { onDelete: 'cascade' }),
    caseId: text('case_id').notNull(),
    caseVersion: integer('case_version').notNull(),
    category: text('category').notNull(),
    expectedOutcome: patchOutcome('expected_outcome').notNull(),
    outcome: evalOutcome('outcome').notNull(),
    /** Null when the case errored. */
    outcomeCorrect: boolean('outcome_correct'),
    /** Scorers (a) to (c), and repo-mode mapping; null when a scorer didn't run. */
    resolved: boolean('resolved'),
    buildOk: boolean('build_ok'),
    scopeOk: boolean('scope_ok'),
    mappingCorrect: boolean('mapping_correct'),
    /** Scorer (d), with the judge's own versions (#15). All null or all set. */
    judgeScore: integer('judge_score'),
    judgeReason: text('judge_reason'),
    judgeModel: text('judge_model'),
    judgePromptVersion: text('judge_prompt_version'),
    /** What a crashed case threw. */
    error: text('error'),
    /** A `PatchProposal`, so a stored run can be inspected and rescored. */
    proposal: jsonb('proposal'),
    /** Why a scorer failed. */
    notes: text('notes')
      .array()
      .notNull()
      .default(sql`'{}'`),
    /** Scorer (e). */
    costUsd,
    latencyMs: integer('latency_ms').notNull(),
    pass: boolean('pass').notNull(),
  },
  (t) => [
    uniqueIndex('eval_results_run_case_idx').on(t.runId, t.caseId),
    nonNegative('eval_results_totals_check', t.costUsd, t.latencyMs, t.caseVersion),
    check(
      'eval_results_error_check',
      sql`(${t.outcome} = 'error') = (${t.error} IS NOT NULL) AND (${t.outcome} = 'error') = (${t.outcomeCorrect} IS NULL)`,
    ),
    check(
      'eval_results_judge_check',
      sql`(${t.judgeScore} IS NULL) = (${t.judgeReason} IS NULL) AND (${t.judgeScore} IS NULL) = (${t.judgeModel} IS NULL) AND (${t.judgeScore} IS NULL) = (${t.judgePromptVersion} IS NULL) AND ${t.judgeScore} BETWEEN 1 AND 5`,
    ),
  ],
);
