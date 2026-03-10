import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, heartbeatRuns } from "@paperclipai/db";
import type { SidebarBadges } from "@paperclipai/shared";

const ACTIONABLE_APPROVAL_STATUSES = ["pending", "revision_requested"];
const FAILED_HEARTBEAT_STATUSES = ["failed", "timed_out"];

export function countInboxStyleFailedRuns(
  runs: Array<{ agentId: string; status: string; createdAt: Date | string }>,
) {
  const latestByAgent = new Map<string, string>();
  const sorted = [...runs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  for (const run of sorted) {
    if (!latestByAgent.has(run.agentId)) {
      latestByAgent.set(run.agentId, run.status);
    }
  }

  return [...latestByAgent.values()].filter((status) =>
    FAILED_HEARTBEAT_STATUSES.includes(status),
  ).length;
}

export function sidebarBadgeService(db: Db) {
  return {
    get: async (
      companyId: string,
      extra?: { joinRequests?: number; assignedIssues?: number },
    ): Promise<SidebarBadges> => {
      const actionableApprovals = await db
        .select({ count: sql<number>`count(*)` })
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            inArray(approvals.status, ACTIONABLE_APPROVAL_STATUSES),
          ),
        )
        .then((rows) => Number(rows[0]?.count ?? 0));

      const latestRunByAgent = await db
        .selectDistinctOn([heartbeatRuns.agentId], {
          agentId: heartbeatRuns.agentId,
          runStatus: heartbeatRuns.status,
          createdAt: heartbeatRuns.createdAt,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            isNull(heartbeatRuns.dismissedAt),
          ),
        )
        .orderBy(heartbeatRuns.agentId, desc(heartbeatRuns.createdAt));

      const failedRuns = countInboxStyleFailedRuns(
        latestRunByAgent.map((row) => ({
          agentId: row.agentId,
          status: row.runStatus,
          createdAt: row.createdAt,
        })),
      );

      const joinRequests = extra?.joinRequests ?? 0;
      const assignedIssues = extra?.assignedIssues ?? 0;
      return {
        inbox: actionableApprovals + failedRuns + joinRequests + assignedIssues,
        approvals: actionableApprovals,
        failedRuns,
        joinRequests,
      };
    },
  };
}
