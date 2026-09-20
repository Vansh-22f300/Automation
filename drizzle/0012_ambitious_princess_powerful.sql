CREATE TYPE "public"."tool_effect_state" AS ENUM('pending', 'succeeded', 'failed', 'ambiguous');--> statement-breakpoint
CREATE TABLE "tool_effects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"tool_name" text NOT NULL,
	"ordinal" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider" text NOT NULL,
	"state" "tool_effect_state" DEFAULT 'pending' NOT NULL,
	"owner" uuid,
	"lease_expires_at" timestamp with time zone,
	"result" jsonb,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_effects_tenant_id_idempotency_key_key" UNIQUE("tenant_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "tool_effects" ADD CONSTRAINT "tool_effects_tenant_id_run_id_fkey" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."workflow_runs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_effects_pending_lease_expires_at_idx" ON "tool_effects" USING btree ("lease_expires_at") WHERE "tool_effects"."state" = 'pending';