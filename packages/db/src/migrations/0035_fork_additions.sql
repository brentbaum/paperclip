-- Fork-specific schema additions (consolidated from fork migrations 0024-0030)
-- These add columns and tables needed by fork features: telegram, remote execution,
-- scheduled issues, viewed_at tracking, dismissed runs

-- issues: add viewed_at, execution_mode, execution_target_id, scheduled_at
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "viewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "execution_mode" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "execution_target_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "scheduled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_execution_mode_idx" ON "issues" USING btree ("company_id","execution_mode");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_scheduled_at_idx" ON "issues" USING btree ("scheduled_at") WHERE "scheduled_at" IS NOT NULL;--> statement-breakpoint

-- heartbeat_runs: add dismissed_at
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "dismissed_at" timestamp with time zone;--> statement-breakpoint

-- remote_execution_targets
CREATE TABLE IF NOT EXISTS "remote_execution_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"user" text NOT NULL,
	"worker_path" text DEFAULT '/opt/paperclip' NOT NULL,
	"supported_adapters" text[] DEFAULT '{}' NOT NULL,
	"max_concurrent_leases" integer DEFAULT 2 NOT NULL,
	"ssh_key_secret_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- remote_execution_leases
CREATE TABLE IF NOT EXISTS "remote_execution_leases" (
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
);--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "remote_execution_targets" ADD CONSTRAINT "remote_execution_targets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "remote_execution_leases" ADD CONSTRAINT "remote_execution_leases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "remote_execution_leases" ADD CONSTRAINT "remote_execution_leases_execution_target_id_remote_execution_ta" FOREIGN KEY ("execution_target_id") REFERENCES "public"."remote_execution_targets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "remote_execution_leases" ADD CONSTRAINT "remote_execution_leases_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "remote_execution_leases" ADD CONSTRAINT "remote_execution_leases_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "remote_execution_leases" ADD CONSTRAINT "remote_execution_leases_last_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
