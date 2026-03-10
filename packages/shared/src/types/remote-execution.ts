import type { AgentAdapterType, RemoteExecutionLeaseStatus } from "../constants.js";

export interface RemoteExecutionTarget {
  id: string;
  companyId: string;
  name: string;
  host: string;
  user: string;
  workerPath: string;
  apiUrl: string | null;
  supportedAdapters: AgentAdapterType[];
  maxConcurrentLeases: number;
  metadata: Record<string, unknown> | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RemoteExecutionLease {
  id: string;
  companyId: string;
  issueId: string;
  agentId: string;
  adapterType: AgentAdapterType;
  executionTargetId: string;
  status: RemoteExecutionLeaseStatus;
  remoteRoot: string;
  repoUrl: string;
  baseRef: string;
  branchName: string;
  pullRequestUrl: string | null;
  pullRequestNumber: number | null;
  lastPushedCommitSha: string | null;
  sessionState: Record<string, unknown> | null;
  lastRunId: string | null;
  expiresAt: Date | null;
  destroyedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
