CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "login_attempts_identifier_created_at_idx" ON "login_attempts" USING btree ("identifier","created_at");