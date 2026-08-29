CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_id_run_id_fkey" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."workflow_runs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_pending_run_at_idx" ON "jobs" USING btree ("run_at") WHERE "jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "jobs_running_lease_expires_at_idx" ON "jobs" USING btree ("lease_expires_at") WHERE "jobs"."status" = 'running';--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_tenant_id_id_key" UNIQUE("tenant_id","id");