ALTER TABLE "llm_usage" DROP CONSTRAINT "llm_usage_step_run_id_key";--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "round" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_step_run_round_key" UNIQUE("step_run_id","round");