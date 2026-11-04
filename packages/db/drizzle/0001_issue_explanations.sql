CREATE TYPE "public"."explain_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "explanation_id" uuid;--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN "explain_status" "explain_status";--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN "explain_error" text;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_explanation_id_explanations_id_fk" FOREIGN KEY ("explanation_id") REFERENCES "public"."explanations"("id") ON DELETE set null ON UPDATE no action;