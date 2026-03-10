import { z } from "zod";
import {
  AGENT_ADAPTER_TYPES,
  REMOTE_EXECUTION_LEASE_STATUSES,
} from "../constants.js";

const adapterTypeSchema = z.enum(AGENT_ADAPTER_TYPES);

const remoteExecutionTargetConnectionSchema = z.object({
  host: z.string().trim().min(1),
  user: z.string().trim().min(1).optional().default("brewuser"),
  workerPath: z.string().trim().min(1).optional().default("~/paperclip-remote-worker/dist/worker.js"),
  metadata: z.record(z.unknown()).optional().nullable(),
});

export const testRemoteExecutionTargetSchema = remoteExecutionTargetConnectionSchema.extend({
  apiUrl: z.string().url().optional().nullable(),
});

export type TestRemoteExecutionTarget = z.infer<typeof testRemoteExecutionTargetSchema>;

export const createRemoteExecutionTargetSchema = remoteExecutionTargetConnectionSchema.extend({
  name: z.string().trim().min(1).max(120),
  apiUrl: z.string().url().optional().nullable(),
  supportedAdapters: z.array(adapterTypeSchema).optional().default(["codex_local", "claude_local"]),
  maxConcurrentLeases: z.number().int().positive().max(100).optional().default(1),
});

export type CreateRemoteExecutionTarget = z.infer<typeof createRemoteExecutionTargetSchema>;

export const updateRemoteExecutionTargetSchema = createRemoteExecutionTargetSchema.partial();
export type UpdateRemoteExecutionTarget = z.infer<typeof updateRemoteExecutionTargetSchema>;

export const updateRemoteExecutionLeaseSchema = z.object({
  status: z.enum(REMOTE_EXECUTION_LEASE_STATUSES).optional(),
  pullRequestUrl: z.string().url().optional().nullable(),
  pullRequestNumber: z.number().int().positive().optional().nullable(),
  lastPushedCommitSha: z.string().trim().min(1).optional().nullable(),
  sessionState: z.record(z.unknown()).optional().nullable(),
  expiresAt: z.string().datetime().optional().nullable(),
  destroyedAt: z.string().datetime().optional().nullable(),
});

export type UpdateRemoteExecutionLease = z.infer<typeof updateRemoteExecutionLeaseSchema>;
