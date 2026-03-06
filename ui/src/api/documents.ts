import type {
  Document,
  DocumentDiff,
  DocumentRevision,
  DocumentRevisionResult,
} from "@paperclipai/shared";
import { api } from "./client";

export const documentsApi = {
  get: (documentId: string) => api.get<Document>(`/documents/${encodeURIComponent(documentId)}`),
  listRevisions: (documentId: string) =>
    api.get<DocumentRevision[]>(`/documents/${encodeURIComponent(documentId)}/revisions`),
  getDiff: (documentId: string, from?: string | null, to?: string | null) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const query = params.toString();
    return api.get<DocumentDiff>(
      `/documents/${encodeURIComponent(documentId)}/diff${query ? `?${query}` : ""}`,
    );
  },
  createRevision: (
    documentId: string,
    data: {
      baseRevisionId?: string | null;
      body: string;
      changeSummary?: string | null;
      source?: string;
    },
  ) => api.post<DocumentRevisionResult>(`/documents/${encodeURIComponent(documentId)}/revisions`, data),
  getProjectDocument: (projectId: string) =>
    api.get<Document>(`/projects/${encodeURIComponent(projectId)}/document`),
  getApprovalDocument: (approvalId: string) =>
    api.get<Document>(`/approvals/${encodeURIComponent(approvalId)}/document`),
  getAgentDailyDocument: (agentId: string, day?: string) =>
    api.get<Document>(
      `/agents/${encodeURIComponent(agentId)}/daily-document${day ? `?day=${encodeURIComponent(day)}` : ""}`,
    ),
  getIssuePlanDocument: (issueId: string) =>
    api.get<Document>(`/issues/${encodeURIComponent(issueId)}/plan-document`),
};
