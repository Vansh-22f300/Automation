CREATE TYPE "public"."workflow_run_status" AS ENUM('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_tenant_id_source_dedupe_key_key" UNIQUE("tenant_id","source","dedupe_key"),
	CONSTRAINT "events_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"status" "workflow_run_status" DEFAULT 'queued' NOT NULL,
	"current_step_key" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_tenant_id_workflow_id_fkey" FOREIGN KEY ("tenant_id","workflow_id") REFERENCES "public"."workflows"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_tenant_id_workflow_version_id_fkey" FOREIGN KEY ("tenant_id","workflow_version_id") REFERENCES "public"."workflow_versions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_tenant_id_event_id_fkey" FOREIGN KEY ("tenant_id","event_id") REFERENCES "public"."events"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_tenant_id_source_received_at_idx" ON "events" USING btree ("tenant_id","source","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workflow_runs_tenant_id_created_at_idx" ON "workflow_runs" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_one_active_per_tenant_source_idx" ON "workflow_versions" USING btree ("tenant_id",("trigger_config" ->> 'source')) WHERE "workflow_versions"."is_active";--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_tenant_id_id_key" UNIQUE("tenant_id","id");