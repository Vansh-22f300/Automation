CREATE TABLE "llm_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"step_run_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"total_tokens" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_usage_step_run_id_key" UNIQUE("step_run_id")
);
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_step_run_id_workflow_step_runs_id_fk" FOREIGN KEY ("step_run_id") REFERENCES "public"."workflow_step_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_tenant_id_run_id_fkey" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."workflow_runs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_usage_tenant_id_run_id_idx" ON "llm_usage" USING btree ("tenant_id","run_id");