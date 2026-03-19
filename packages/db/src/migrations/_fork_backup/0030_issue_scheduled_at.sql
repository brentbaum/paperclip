ALTER TABLE "issues" ADD COLUMN "scheduled_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "issues_scheduled_at_idx" ON "issues" ("scheduled_at") WHERE "scheduled_at" IS NOT NULL;
