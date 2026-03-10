CREATE TABLE "remote_execution_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"adapter_type" text NOT NULL,
	"execution_target_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"remote_root" text NOT NULL,
	"repo_url" text NOT NULL,
	"base_ref" text DEFAULT 'main' NOT NULL,
	"branch_name" text NOT NULL,
	"pull_request_url" text,
	"pull_request_number" integer,
	"last_pushed_commit_sha" text,
	"session_state" jsonb,
	"last_run_id" uuid,
	"expires_at" timestamp with time zone,
	"destroyed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remote_execution_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"user" text DEFAULT 'brewuser' NOT NULL,
	"worker_path" text DEFAULT '~/paperclip-remote-worker/dist/worker.js' NOT NULL,
	"api_url" text,
	"supported_adapters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_concurrent_leases" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "remote_execution_leases" ADD CONSTRAINT "remote_execution_leases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_execution_leases" ADD CONSTRAINT "remote_execution_leases_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_execution_leases" ADD CONSTRAINT "remote_execution_leases_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_execution_leases" ADD CONSTRAINT "remote_execution_leases_execution_target_id_remote_execution_targets_id_fk" FOREIGN KEY ("execution_target_id") REFERENCES "public"."remote_execution_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_execution_leases" ADD CONSTRAINT "remote_execution_leases_last_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_execution_targets" ADD CONSTRAINT "remote_execution_targets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "remote_execution_leases_company_issue_idx" ON "remote_execution_leases" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "remote_execution_leases_company_status_idx" ON "remote_execution_leases" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "remote_execution_leases_target_status_idx" ON "remote_execution_leases" USING btree ("execution_target_id","status");--> statement-breakpoint
CREATE INDEX "remote_execution_targets_company_idx" ON "remote_execution_targets" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "remote_execution_targets_company_archived_idx" ON "remote_execution_targets" USING btree ("company_id","archived_at");