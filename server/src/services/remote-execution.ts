import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  remoteExecutionTargets,
  remoteExecutionLeases,
  issues,
  agents,
} from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";

function normalizeSupportedAdapters(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function remoteExecutionService(db: Db) {
  return {
    findActiveLease: async (input: {
      companyId: string;
      issueId: string;
      agentId: string;
      adapterType: string;
      executionTargetId: string;
    }) => {
      return db
        .select()
        .from(remoteExecutionLeases)
        .where(
          and(
            eq(remoteExecutionLeases.companyId, input.companyId),
            eq(remoteExecutionLeases.issueId, input.issueId),
            eq(remoteExecutionLeases.agentId, input.agentId),
            eq(remoteExecutionLeases.adapterType, input.adapterType),
            eq(remoteExecutionLeases.executionTargetId, input.executionTargetId),
            eq(remoteExecutionLeases.status, "active"),
            isNull(remoteExecutionLeases.destroyedAt),
          ),
        )
        .orderBy(desc(remoteExecutionLeases.createdAt))
        .then((rows) => rows[0] ?? null);
    },

    ensureActiveLease: async (input: {
      companyId: string;
      issueId: string;
      agentId: string;
      adapterType: string;
      executionTargetId: string;
      remoteRoot: string;
      repoUrl: string;
      baseRef: string;
      branchName: string;
    }) => {
      const existing = await db
        .select()
        .from(remoteExecutionLeases)
        .where(
          and(
            eq(remoteExecutionLeases.companyId, input.companyId),
            eq(remoteExecutionLeases.issueId, input.issueId),
            eq(remoteExecutionLeases.agentId, input.agentId),
            eq(remoteExecutionLeases.adapterType, input.adapterType),
            eq(remoteExecutionLeases.executionTargetId, input.executionTargetId),
            eq(remoteExecutionLeases.status, "active"),
            isNull(remoteExecutionLeases.destroyedAt),
          ),
        )
        .orderBy(desc(remoteExecutionLeases.createdAt))
        .then((rows) => rows[0] ?? null);

      if (existing) {
        return db
          .update(remoteExecutionLeases)
          .set({
            remoteRoot: input.remoteRoot,
            repoUrl: input.repoUrl,
            baseRef: input.baseRef,
            branchName: input.branchName,
            updatedAt: new Date(),
          })
          .where(eq(remoteExecutionLeases.id, existing.id))
          .returning()
          .then((rows) => rows[0] ?? existing);
      }

      return db
        .insert(remoteExecutionLeases)
        .values({
          companyId: input.companyId,
          issueId: input.issueId,
          agentId: input.agentId,
          adapterType: input.adapterType,
          executionTargetId: input.executionTargetId,
          status: "active",
          remoteRoot: input.remoteRoot,
          repoUrl: input.repoUrl,
          baseRef: input.baseRef,
          branchName: input.branchName,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    updateLeaseForRun: async (
      leaseId: string,
      patch: {
        sessionState?: Record<string, unknown> | null;
        lastRunId?: string | null;
        lastPushedCommitSha?: string | null;
        pullRequestUrl?: string | null;
        pullRequestNumber?: number | null;
        status?: "active" | "expired" | "destroyed" | "error";
      },
    ) => {
      return db
        .update(remoteExecutionLeases)
        .set({
          ...patch,
          updatedAt: new Date(),
        })
        .where(eq(remoteExecutionLeases.id, leaseId))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    listTargets: async (companyId: string, opts?: { includeArchived?: boolean }) => {
      const includeArchived = opts?.includeArchived === true;
      return db
        .select()
        .from(remoteExecutionTargets)
        .where(
          includeArchived
            ? eq(remoteExecutionTargets.companyId, companyId)
            : and(
                eq(remoteExecutionTargets.companyId, companyId),
                isNull(remoteExecutionTargets.archivedAt),
              ),
        )
        .orderBy(desc(remoteExecutionTargets.createdAt));
    },

    getTargetById: async (id: string) => {
      return db
        .select()
        .from(remoteExecutionTargets)
        .where(eq(remoteExecutionTargets.id, id))
        .then((rows) => rows[0] ?? null);
    },

    createTarget: async (
      companyId: string,
      input: Omit<typeof remoteExecutionTargets.$inferInsert, "companyId">,
    ) => {
      const values: typeof remoteExecutionTargets.$inferInsert = {
        ...input,
        companyId,
        supportedAdapters: normalizeSupportedAdapters(input.supportedAdapters),
      };
      return db
        .insert(remoteExecutionTargets)
        .values(values)
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    updateTarget: async (
      id: string,
      patch: Partial<typeof remoteExecutionTargets.$inferInsert>,
    ) => {
      const nextPatch: Partial<typeof remoteExecutionTargets.$inferInsert> = {
        ...patch,
        updatedAt: new Date(),
      };
      if (patch.supportedAdapters !== undefined) {
        nextPatch.supportedAdapters = normalizeSupportedAdapters(patch.supportedAdapters);
      }
      return db
        .update(remoteExecutionTargets)
        .set(nextPatch)
        .where(eq(remoteExecutionTargets.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    archiveTarget: async (id: string) => {
      return db
        .update(remoteExecutionTargets)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(eq(remoteExecutionTargets.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    listLeasesForIssue: async (companyId: string, issueId: string) => {
      return db
        .select()
        .from(remoteExecutionLeases)
        .where(
          and(
            eq(remoteExecutionLeases.companyId, companyId),
            eq(remoteExecutionLeases.issueId, issueId),
          ),
        )
        .orderBy(desc(remoteExecutionLeases.createdAt));
    },

    getLeaseById: async (leaseId: string) => {
      return db
        .select()
        .from(remoteExecutionLeases)
        .where(eq(remoteExecutionLeases.id, leaseId))
        .then((rows) => rows[0] ?? null);
    },

    resetLease: async (leaseId: string) => {
      const existing = await db
        .select()
        .from(remoteExecutionLeases)
        .where(eq(remoteExecutionLeases.id, leaseId))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      return db
        .update(remoteExecutionLeases)
        .set({
          status: "destroyed",
          destroyedAt: new Date(),
          updatedAt: new Date(),
          sessionState: null,
          lastRunId: null,
        })
        .where(eq(remoteExecutionLeases.id, leaseId))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    updateLease: async (
      leaseId: string,
      patch: Partial<typeof remoteExecutionLeases.$inferInsert>,
    ) => {
      return db
        .update(remoteExecutionLeases)
        .set({
          ...patch,
          updatedAt: new Date(),
        })
        .where(eq(remoteExecutionLeases.id, leaseId))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    assertRemoteExecutionIssueReady: async (companyId: string, issueId: string) => {
      const issue = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          assigneeAgentId: issues.assigneeAgentId,
          executionMode: issues.executionMode,
          executionTargetId: issues.executionTargetId,
        })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");
      if (issue.executionMode !== "remote") {
        throw unprocessable("Issue is not configured for remote execution");
      }
      if (!issue.assigneeAgentId) {
        throw unprocessable("Remote execution requires an agent assignee");
      }
      if (!issue.executionTargetId) {
        throw unprocessable("Remote execution requires an execution target");
      }

      const [target, assignee] = await Promise.all([
        db
          .select()
          .from(remoteExecutionTargets)
          .where(
            and(
              eq(remoteExecutionTargets.id, issue.executionTargetId),
              eq(remoteExecutionTargets.companyId, companyId),
              isNull(remoteExecutionTargets.archivedAt),
            ),
          )
          .then((rows) => rows[0] ?? null),
        db
          .select({ id: agents.id, adapterType: agents.adapterType })
          .from(agents)
          .where(and(eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, companyId)))
          .then((rows) => rows[0] ?? null),
      ]);

      if (!target) throw unprocessable("Remote execution target not found");
      if (!assignee) throw unprocessable("Assignee agent not found");
      const supported = normalizeSupportedAdapters(target.supportedAdapters);
      if (supported.length > 0 && !supported.includes(assignee.adapterType)) {
        throw unprocessable(`Target does not support adapter type '${assignee.adapterType}'`);
      }
      return { issue, target, assignee };
    },
  };
}
