import { describe, expect, it } from "vitest";
import {
  AGENT_ADAPTER_TYPES,
  createIssueSchema,
  updateIssueSchema,
  testRemoteExecutionTargetSchema,
  createRemoteExecutionTargetSchema,
  updateRemoteExecutionLeaseSchema,
} from "@paperclipai/shared";

describe("remote execution shared contracts", () => {
  it("does not include ssh in agent adapter types", () => {
    expect(AGENT_ADAPTER_TYPES).not.toContain("ssh");
  });

  it("accepts execution mode fields on issue create", () => {
    const parsed = createIssueSchema.parse({
      title: "Run remotely",
      executionMode: "remote",
      executionTargetId: "11111111-1111-1111-1111-111111111111",
      assigneeAgentId: "22222222-2222-2222-2222-222222222222",
    });

    expect(parsed.executionMode).toBe("remote");
    expect(parsed.executionTargetId).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("accepts execution mode fields on issue update", () => {
    const parsed = updateIssueSchema.parse({
      executionMode: "default",
      executionTargetId: null,
    });

    expect(parsed.executionMode).toBe("default");
    expect(parsed.executionTargetId).toBeNull();
  });

  it("rejects remote create without agent assignee and target", () => {
    expect(() =>
      createIssueSchema.parse({
        title: "bad remote create",
        executionMode: "remote",
      }),
    ).toThrow();
  });

  it("parses remote execution target payloads", () => {
    const parsed = createRemoteExecutionTargetSchema.parse({
      name: "Local Docker target",
      host: "127.0.0.1",
      user: "brewuser",
      apiUrl: "http://127.0.0.1:3100",
      supportedAdapters: ["codex_local"],
      maxConcurrentLeases: 2,
    });
    expect(parsed.supportedAdapters).toEqual(["codex_local"]);
    expect(parsed.maxConcurrentLeases).toBe(2);
  });

  it("parses remote execution target test payloads without create-only fields", () => {
    const parsed = testRemoteExecutionTargetSchema.parse({
      host: "100.122.157.11",
      user: "brewuser",
      workerPath: "~/paperclip-remote-worker/dist/worker.js",
    });

    expect(parsed.host).toBe("100.122.157.11");
    expect(parsed.user).toBe("brewuser");
  });

  it("parses lease patch payloads", () => {
    const parsed = updateRemoteExecutionLeaseSchema.parse({
      status: "destroyed",
      pullRequestUrl: "https://github.com/org/repo/pull/1",
      pullRequestNumber: 1,
    });
    expect(parsed.status).toBe("destroyed");
    expect(parsed.pullRequestNumber).toBe(1);
  });
});
