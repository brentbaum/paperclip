ALTER TABLE "documents" ADD COLUMN "issue_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "execution_mode" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "execution_target_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "viewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_issue_id_unique" ON "documents" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issues_company_execution_mode_idx" ON "issues" USING btree ("company_id","execution_mode");