CREATE TYPE "public"."workflow_step_run_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "workflow_step_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"step_type" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"status" "workflow_step_run_status" NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer
);
--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD CONSTRAINT "workflow_step_runs_tenant_id_run_id_fkey" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."workflow_runs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_step_runs_one_success_per_attempt_idx" ON "workflow_step_runs" USING btree ("run_id","step_key","attempt") WHERE "workflow_step_runs"."status" = 'succeeded';--> statement-breakpoint
CREATE INDEX "workflow_step_runs_run_id_started_at_idx" ON "workflow_step_runs" USING btree ("run_id","started_at");