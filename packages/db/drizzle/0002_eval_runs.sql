CREATE TYPE "public"."eval_outcome" AS ENUM('fix', 'no_change_needed', 'unsure', 'error');--> statement-breakpoint
CREATE TYPE "public"."eval_trigger" AS ENUM('pr', 'weekly', 'manual');--> statement-breakpoint
CREATE TYPE "public"."patch_outcome" AS ENUM('fix', 'no_change_needed', 'unsure');--> statement-breakpoint
CREATE TABLE "eval_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"case_id" text NOT NULL,
	"case_version" integer NOT NULL,
	"category" text NOT NULL,
	"expected_outcome" "patch_outcome" NOT NULL,
	"outcome" "eval_outcome" NOT NULL,
	"outcome_correct" boolean,
	"resolved" boolean,
	"build_ok" boolean,
	"scope_ok" boolean,
	"mapping_correct" boolean,
	"judge_score" integer,
	"judge_reason" text,
	"judge_model" text,
	"judge_prompt_version" text,
	"error" text,
	"proposal" jsonb,
	"notes" text[] DEFAULT '{}' NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"latency_ms" integer NOT NULL,
	"pass" boolean NOT NULL,
	CONSTRAINT "eval_results_totals_check" CHECK ("eval_results"."cost_usd" >= 0 AND "eval_results"."latency_ms" >= 0 AND "eval_results"."case_version" >= 0),
	CONSTRAINT "eval_results_error_check" CHECK (("eval_results"."outcome" = 'error') = ("eval_results"."error" IS NOT NULL) AND ("eval_results"."outcome" = 'error') = ("eval_results"."outcome_correct" IS NULL)),
	CONSTRAINT "eval_results_judge_check" CHECK (("eval_results"."judge_score" IS NULL) = ("eval_results"."judge_reason" IS NULL) AND ("eval_results"."judge_score" IS NULL) = ("eval_results"."judge_model" IS NULL) AND ("eval_results"."judge_score" IS NULL) = ("eval_results"."judge_prompt_version" IS NULL) AND "eval_results"."judge_score" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"git_sha" text NOT NULL,
	"branch" text NOT NULL,
	"trigger" "eval_trigger" NOT NULL,
	"dataset_version" integer NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"axe_version" text,
	"totals" jsonb NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_runs_totals_check" CHECK ("eval_runs"."cost_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_run_id_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "eval_results_run_case_idx" ON "eval_results" USING btree ("run_id","case_id");--> statement-breakpoint
CREATE INDEX "eval_runs_baseline_idx" ON "eval_runs" USING btree ("branch","dataset_version","created_at");--> statement-breakpoint
CREATE INDEX "eval_runs_created_at_idx" ON "eval_runs" USING btree ("created_at");