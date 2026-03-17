import { Router } from "express";
import type { Db } from "@paperclipai/db";
// TODO: Restore scoped document routes once the document service and DB schema
// support scope-based documents (getOrCreateIssuePlanDocument, getOrCreateProjectDocument,
// getOrCreateApprovalDocument, getOrCreateAgentDailyDocument, getById, listRevisions,
// getRevision, getDiff, createRevision). These methods were lost during a merge and the
// underlying DB schema (documents.scope, documents.projectId, documents.approvalId,
// documents.agentId, documents.issueId, documents.day, documentAgentStates table) does
// not exist in the current schema.

export function documentRoutes(_db: Db) {
  const router = Router();
  return router;
}
