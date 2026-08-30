CREATE TYPE "public"."connection_status" AS ENUM('active', 'disabled', 'error');--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"status" "connection_status" DEFAULT 'active' NOT NULL,
	"encrypted_credentials" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "connections_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "connections_tenant_id_provider_name_key" UNIQUE("tenant_id","provider","name")
);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connections_tenant_id_provider_active_key" ON "connections" USING btree ("tenant_id","provider") WHERE "connections"."status" = 'active';--> statement-breakpoint
CREATE INDEX "connections_tenant_id_created_at_idx" ON "connections" USING btree ("tenant_id","created_at" DESC NULLS LAST);