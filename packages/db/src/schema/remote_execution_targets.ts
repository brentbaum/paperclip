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

export const remoteExecutionTargets = pgTable(
  "remote_execution_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    host: text("host").notNull(),
    user: text("user").notNull().default("brewuser"),
    workerPath: text("worker_path").notNull().default("~/paperclip-remote-worker/dist/worker.js"),
    apiUrl: text("api_url"),
    supportedAdapters: jsonb("supported_adapters").$type<string[]>().notNull().default([]),
    maxConcurrentLeases: integer("max_concurrent_leases").notNull().default(1),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("remote_execution_targets_company_idx").on(table.companyId),
    companyArchivedIdx: index("remote_execution_targets_company_archived_idx").on(
      table.companyId,
      table.archivedAt,
    ),
  }),
);
