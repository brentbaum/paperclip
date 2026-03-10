import { describe, expect, it } from "vitest";
import { countInboxStyleFailedRuns } from "../services/sidebar-badges.js";

describe("countInboxStyleFailedRuns", () => {
  it("matches inbox behavior by ignoring dismissed runs before choosing the latest per agent", () => {
    const count = countInboxStyleFailedRuns([
      {
        agentId: "agent-1",
        status: "failed",
        createdAt: "2026-03-10T18:00:00.000Z",
      },
      {
        agentId: "agent-1",
        status: "succeeded",
        createdAt: "2026-03-10T17:00:00.000Z",
      },
      {
        agentId: "agent-2",
        status: "succeeded",
        createdAt: "2026-03-10T18:30:00.000Z",
      },
      {
        agentId: "agent-2",
        status: "failed",
        createdAt: "2026-03-10T17:30:00.000Z",
      },
      {
        agentId: "agent-3",
        status: "timed_out",
        createdAt: "2026-03-10T18:15:00.000Z",
      },
    ]);

    expect(count).toBe(2);
  });
});
