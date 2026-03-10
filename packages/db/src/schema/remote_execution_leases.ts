import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { remoteExecutionTargets } from "./remote_execution_targets.js";

export const remoteExecutionLeases = pgTable(
  "remote_execution_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    adapterType: text("adapter_type").notNull(),
    executionTargetId: uuid("execution_target_id")
      .notNull()
      .references(() => remoteExecutionTargets.id),
    status: text("status").notNull().default("active"),
    remoteRoot: text("remote_root").notNull(),
    repoUrl: text("repo_url").notNull(),
    baseRef: text("base_ref").notNull().default("main"),
    branchName: text("branch_name").notNull(),
    pullRequestUrl: text("pull_request_url"),
    pullRequestNumber: integer("pull_request_number"),
    lastPushedCommitSha: text("last_pushed_commit_sha"),
    sessionState: jsonb("session_state").$type<Record<string, unknown>>(),
    lastRunId: uuid("last_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    destroyedAt: timestamp("destroyed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdx: index("remote_execution_leases_company_issue_idx").on(
      table.companyId,
      table.issueId,
    ),
    companyStatusIdx: index("remote_execution_leases_company_status_idx").on(
      table.companyId,
      table.status,
    ),
    targetStatusIdx: index("remote_execution_leases_target_status_idx").on(
      table.executionTargetId,
      table.status,
    ),
  }),
);
