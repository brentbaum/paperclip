CREATE TABLE "document_agent_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"last_delivered_revision_id" uuid,
	"last_written_revision_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"parent_revision_id" uuid,
	"author_agent_id" uuid,
	"author_user_id" text,
	"source" text NOT NULL,
	"change_summary" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"title" text NOT NULL,
	"format" text DEFAULT 'markdown' NOT NULL,
	"project_id" uuid,
	"approval_id" uuid,
	"agent_id" uuid,
	"day" date,
	"latest_revision_id" uuid,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_agent_states" ADD CONSTRAINT "document_agent_states_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_agent_states" ADD CONSTRAINT "document_agent_states_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_agent_states" ADD CONSTRAINT "document_agent_states_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_agent_states" ADD CONSTRAINT "document_agent_states_last_delivered_revision_id_document_revisions_id_fk" FOREIGN KEY ("last_delivered_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_agent_states" ADD CONSTRAINT "document_agent_states_last_written_revision_id_document_revisions_id_fk" FOREIGN KEY ("last_written_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_parent_revision_id_document_revisions_id_fk" FOREIGN KEY ("parent_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_agent_states_agent_document_idx" ON "document_agent_states" USING btree ("agent_id","document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_agent_states_agent_document_unique" ON "document_agent_states" USING btree ("agent_id","document_id");--> statement-breakpoint
CREATE INDEX "document_agent_states_company_document_agent_idx" ON "document_agent_states" USING btree ("company_id","document_id","agent_id");--> statement-breakpoint
CREATE INDEX "document_agent_states_last_delivered_idx" ON "document_agent_states" USING btree ("last_delivered_revision_id");--> statement-breakpoint
CREATE INDEX "document_revisions_document_revision_number_idx" ON "document_revisions" USING btree ("document_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "document_revisions_document_revision_unique" ON "document_revisions" USING btree ("document_id","revision_number");--> statement-breakpoint
CREATE INDEX "documents_company_scope_archived_idx" ON "documents" USING btree ("company_id","scope","archived_at");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_project_id_unique" ON "documents" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_approval_id_unique" ON "documents" USING btree ("approval_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_agent_day_unique" ON "documents" USING btree ("agent_id","day");