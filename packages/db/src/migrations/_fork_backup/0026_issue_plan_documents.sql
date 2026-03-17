ALTER TABLE "documents" ADD COLUMN "issue_id" uuid;
DO $$ BEGIN
  ALTER TABLE "documents" ADD CONSTRAINT "documents_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "documents_issue_id_unique" ON "documents" USING btree ("issue_id");
