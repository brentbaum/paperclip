import {
  type AnyPgColumn,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { approvals } from "./approvals.js";
import { agents } from "./agents.js";

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    scope: text("scope").notNull(),
    title: text("title").notNull(),
    format: text("format").notNull().default("markdown"),
    projectId: uuid("project_id").references(() => projects.id),
    approvalId: uuid("approval_id").references(() => approvals.id),
    agentId: uuid("agent_id").references(() => agents.id),
    day: date("day"),
    latestRevisionId: uuid("latest_revision_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    createdByUserId: text("created_by_user_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyScopeArchivedIdx: index("documents_company_scope_archived_idx").on(
      table.companyId,
      table.scope,
      table.archivedAt,
    ),
    projectUniqueIdx: uniqueIndex("documents_project_id_unique").on(table.projectId),
    approvalUniqueIdx: uniqueIndex("documents_approval_id_unique").on(table.approvalId),
    agentDayUniqueIdx: uniqueIndex("documents_agent_day_unique").on(table.agentId, table.day),
  }),
);

export const documentRevisions = pgTable(
  "document_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    documentId: uuid("document_id").notNull().references(() => documents.id),
    revisionNumber: integer("revision_number").notNull(),
    parentRevisionId: uuid("parent_revision_id").references((): AnyPgColumn => documentRevisions.id),
    authorAgentId: uuid("author_agent_id").references(() => agents.id),
    authorUserId: text("author_user_id"),
    source: text("source").notNull(),
    changeSummary: text("change_summary"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    documentRevisionNumberIdx: index("document_revisions_document_revision_number_idx").on(
      table.documentId,
      table.revisionNumber,
    ),
    documentRevisionUniqueIdx: uniqueIndex("document_revisions_document_revision_unique").on(
      table.documentId,
      table.revisionNumber,
    ),
  }),
);

export const documentAgentStates = pgTable(
  "document_agent_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    documentId: uuid("document_id").notNull().references(() => documents.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    lastDeliveredRevisionId: uuid("last_delivered_revision_id").references(() => documentRevisions.id),
    lastWrittenRevisionId: uuid("last_written_revision_id").references(() => documentRevisions.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentDocumentIdx: index("document_agent_states_agent_document_idx").on(
      table.agentId,
      table.documentId,
    ),
    agentDocumentUniqueIdx: uniqueIndex("document_agent_states_agent_document_unique").on(
      table.agentId,
      table.documentId,
    ),
    companyDocumentAgentIdx: index("document_agent_states_company_document_agent_idx").on(
      table.companyId,
      table.documentId,
      table.agentId,
    ),
    deliveredRevisionIdx: index("document_agent_states_last_delivered_idx").on(
      table.lastDeliveredRevisionId,
    ),
  }),
);
