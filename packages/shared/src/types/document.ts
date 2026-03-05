import type { DocumentFormat, DocumentScope } from "../constants.js";

export interface DocumentRevision {
  id: string;
  companyId: string;
  documentId: string;
  revisionNumber: number;
  parentRevisionId: string | null;
  authorAgentId: string | null;
  authorUserId: string | null;
  source: string;
  changeSummary: string | null;
  body: string;
  createdAt: Date;
}

export interface Document {
  id: string;
  companyId: string;
  scope: DocumentScope;
  title: string;
  format: DocumentFormat;
  projectId: string | null;
  approvalId: string | null;
  agentId: string | null;
  day: string | null;
  latestRevisionId: string | null;
  latestRevisionNumber: number | null;
  latestRevision: DocumentRevision | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  lastDeliveredRevisionId: string | null;
  lastWrittenRevisionId: string | null;
  hasUndeliveredChanges: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentDiff {
  documentId: string;
  fromRevision: DocumentRevision | null;
  toRevision: DocumentRevision | null;
  fromBody: string;
  toBody: string;
}

export interface DocumentRevisionResult {
  document: Document;
  revision: DocumentRevision;
}
