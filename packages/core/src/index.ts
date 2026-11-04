// Shared Zod schemas: the contract between the app, the agent, and the evals.
// Every schema is exported with its inferred type under the same name.
// Objects are strict: an unknown key is an error, not silently dropped.
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Building blocks

/** axe-core impact levels, lowest to highest. */
export const Impact = z.enum(['minor', 'moderate', 'serious', 'critical']);
export type Impact = z.infer<typeof Impact>;

/** Model confidence, 0 to 1. */
export const Confidence = z.number().min(0).max(1);
export type Confidence = z.infer<typeof Confidence>;

/** A WCAG success criterion number, e.g. "1.4.3". */
export const WcagCriterion = z.string().regex(/^[1-4]\.\d{1,2}\.\d{1,2}$/);
export type WcagCriterion = z.infer<typeof WcagCriterion>;

/**
 * A file path relative to the repo or case root, so a path from the model can
 * never point outside the root. Rejects rooted paths (`/x`, `\x`, `\\server`),
 * any drive prefix (`C:\x`, `C:x`), and empty, `.` or `..` segments, which
 * also rules out directories like `src/`. Tools must still resolve the path
 * and check it stays under the root (#26).
 */
export const RelativePath = z
  .string()
  .min(1)
  .refine((p) => !/^[\\/]/.test(p) && !/^[A-Za-z]:/.test(p), 'must be relative')
  .refine(
    (p) => !p.split(/[\\/]/).some((s) => s === '' || s === '.' || s === '..'),
    'must name a file, with no empty, "." or ".." segments',
  );
export type RelativePath = z.infer<typeof RelativePath>;

/** A kebab-case id, e.g. "image-alt-decorative". Used for eval cases and manifest entries. */
export const Slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be kebab-case');
export type Slug = z.infer<typeof Slug>;

/** An http or https URL. Other schemes (`javascript:`, `data:`) are rejected. */
export const HttpUrl = z.url({ protocol: /^https?$/ });
export type HttpUrl = z.infer<typeof HttpUrl>;

// ---------------------------------------------------------------------------
// Scanning

/**
 * The axe tags every scan runs with: WCAG 2.1 A and AA. The worker's scanner
 * (#5) and the sample-site scan both use this, so evals and production check
 * the same rules.
 */
export const AXE_WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;
export type AxeWcagTag = (typeof AXE_WCAG_TAGS)[number];

/** One axe violation on one element, normalized by the scanner (#5). */
export const A11yIssue = z.strictObject({
  ruleId: z.string().min(1),
  impact: Impact,
  /** axe `help`: a one-line summary of the rule. */
  help: z.string().min(1),
  helpUrl: HttpUrl,
  wcag: z.array(WcagCriterion),
  pageUrl: HttpUrl,
  /** CSS selector for the element, from axe `target`. */
  selector: z.string().min(1),
  /** The element's outer HTML as axe reported it. */
  html: z.string(),
  failureSummary: z.string().optional(),
  /** Stable across scans: used to tell resolved, still present, and new issues apart (#28). */
  fingerprint: z.string().min(1),
});
export type A11yIssue = z.infer<typeof A11yIssue>;

/** `jobs.payload` for a `scan` job: the web app enqueues it, the worker runs it (#5). */
export const ScanJobPayload = z.strictObject({ scanId: z.uuid() });
export type ScanJobPayload = z.infer<typeof ScanJobPayload>;

/** Plain-language explanation of an issue group, produced by the model (#7). */
export const IssueExplanation = z.strictObject({
  whatsWrong: z.string().min(1),
  whoItAffects: z.string().min(1),
  whyItMatters: z.string().min(1),
  confidence: Confidence,
});
export type IssueExplanation = z.infer<typeof IssueExplanation>;

// ---------------------------------------------------------------------------
// Fixing

export const PatchOutcome = z.enum(['fix', 'no_change_needed', 'unsure']);
export type PatchOutcome = z.infer<typeof PatchOutcome>;

/**
 * The result of `proposeFix` (#9). A `fix` must carry the file and a unified
 * diff; `no_change_needed` and `unsure` must not, and `unsure` must ask a
 * question for the reviewer (#24).
 */
export const PatchProposal = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('fix'),
    filePath: RelativePath,
    diff: z.string().min(1),
    explanation: z.string().min(1),
    confidence: Confidence,
  }),
  z.strictObject({
    outcome: z.literal('no_change_needed'),
    explanation: z.string().min(1),
    confidence: Confidence,
  }),
  z.strictObject({
    outcome: z.literal('unsure'),
    question: z.string().min(1),
    explanation: z.string().min(1),
    confidence: Confidence,
  }),
]);
export type PatchProposal = z.infer<typeof PatchProposal>;

// ---------------------------------------------------------------------------
// Agent runs

export const ToolName = z.enum([
  'run_scan',
  'read_file',
  'search_repo',
  'propose_patch',
  'apply_patch',
  'open_pr',
]);
export type ToolName = z.infer<typeof ToolName>;

/** Why a run stopped (#22, #27). */
export const RunEndReason = z.enum([
  'completed',
  'awaiting_approval',
  'max_steps',
  'cost_cap',
  'timeout',
  'error',
]);
export type RunEndReason = z.infer<typeof RunEndReason>;

const stepBase = {
  runId: z.string().min(1),
  /** Position in the run, starting at 0. */
  index: z.int().nonnegative(),
  /** Offsets allowed: Postgres `timestamptz` serializes as `+00:00`, not `Z`. */
  createdAt: z.iso.datetime({ offset: true }),
};

/** One row of `agent_steps`, streamed to the UI as the run progresses (#22). */
export const AgentStep = z.discriminatedUnion('type', [
  z.strictObject({ ...stepBase, type: z.literal('thought'), text: z.string() }),
  z.strictObject({
    ...stepBase,
    type: z.literal('tool_call'),
    toolCallId: z.string().min(1),
    tool: ToolName,
    input: z.unknown(),
  }),
  z.strictObject({
    ...stepBase,
    type: z.literal('tool_result'),
    toolCallId: z.string().min(1),
    tool: ToolName,
    output: z.unknown(),
    /** Tool errors are returned to the model rather than thrown. */
    isError: z.boolean(),
  }),
  z.strictObject({
    ...stepBase,
    type: z.literal('end'),
    reason: RunEndReason,
    message: z.string().optional(),
  }),
]);
export type AgentStep = z.infer<typeof AgentStep>;

// ---------------------------------------------------------------------------
// Evals

/** UI frameworks the agent and the evals support. Only React for now. */
export const Framework = z.enum(['react']);
export type Framework = z.infer<typeof Framework>;

/** Inclusive, 1-based line range in the input file. */
export const LineRange = z
  .strictObject({ start: z.int().positive(), end: z.int().positive() })
  .refine((r) => r.end >= r.start, 'end must be >= start');
export type LineRange = z.infer<typeof LineRange>;

/**
 * The fields of `EvalCase` without its cross-field rule. Zod 4 can't `.omit()`
 * or `.pick()` a refined object, so derive shapes from this instead.
 */
export const EvalCaseObject = z.strictObject({
  id: Slug,
  /** Bumped whenever the case changes, so results are only compared like for like (#16). */
  version: z.int().positive(),
  framework: Framework,
  description: z.string().min(1),
  category: z.string().min(1),
  /** e.g. `smoke` for the fast tier (#14). */
  tags: z.array(z.string().min(1)).default([]),
  /** The file under `input/` the issue lives in. */
  filePath: RelativePath,
  issue: A11yIssue,
  expectedOutcome: PatchOutcome,
  /** Lines a fix may touch; scorer (c) fails diffs outside them (#13). */
  allowedLines: z.array(LineRange).min(1).optional(),
  /** Repo mode: the source file(s) the issue maps to (#25). */
  sourceFiles: z.array(RelativePath).min(1).optional(),
});

/** `case.json` in `packages/evals/dataset/cases/<id>/` (#12). */
export const EvalCase = EvalCaseObject.refine(
  (c) => (c.expectedOutcome === 'fix') === (c.allowedLines !== undefined),
  {
    message: 'allowedLines is required when expectedOutcome is "fix", and not allowed otherwise',
    path: ['allowedLines'],
  },
);
export type EvalCase = z.infer<typeof EvalCase>;

/** LLM-as-judge output, scorer (d) (#15). */
export const JudgeVerdict = z.strictObject({
  score: z.int().min(1).max(5),
  reason: z.string().min(1),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

/** Each scorer is optional so a run can skip some (e.g. no judge in the smoke tier). */
export const EvalScores = z.strictObject({
  /** (a) target violation gone and no new violations. */
  resolved: z.boolean().optional(),
  /** (b) tsc, ESLint, and the case's own test pass. */
  buildSafe: z.boolean().optional(),
  /** (c) diff stays within the allowed lines. */
  scoped: z.boolean().optional(),
  /** (d) judge score and reason, with the judge's own versions. */
  judge: JudgeVerdict.extend({
    model: z.string().min(1),
    promptVersion: z.string().min(1),
  }).optional(),
  /** Repo mode: mapped to the right source file (#25). */
  mappingCorrect: z.boolean().optional(),
});
export type EvalScores = z.infer<typeof EvalScores>;

const resultBase = {
  caseId: z.string().min(1),
  /** `datasetVersion` from the dataset manifest and the case's own `version`. */
  datasetVersion: z.int().positive(),
  caseVersion: z.int().positive(),
  /** (e) cost and latency, including whatever a crashed case spent. */
  costUsd: z.number().nonnegative(),
  latencyMs: z.int().nonnegative(),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
};

/**
 * One case's result in an eval run (#13, #16). A case that crashed before
 * producing a proposal has `outcome: 'error'` and no scores, so crashes are
 * counted on their own rather than as one of the proposal outcomes.
 */
export const EvalResult = z.discriminatedUnion('outcome', [
  z.strictObject({
    ...resultBase,
    outcome: PatchOutcome,
    /** Whether the outcome matched the case's `expectedOutcome`. */
    outcomeCorrect: z.boolean(),
    scores: EvalScores,
  }),
  z.strictObject({
    ...resultBase,
    outcome: z.literal('error'),
    error: z.string().min(1),
  }),
]);
export type EvalResult = z.infer<typeof EvalResult>;
