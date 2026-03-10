import { describe, expect, it, vi } from "vitest";
import { executeWithProcessRunner as executeCodexWithProcessRunner } from "@paperclipai/adapter-codex-local/server";
import { executeWithProcessRunner as executeClaudeWithProcessRunner } from "@paperclipai/adapter-claude-local/server";

function buildBaseContext(overrides: {
  adapterType: "codex_local" | "claude_local";
  config?: Record<string, unknown>;
}): Parameters<typeof executeCodexWithProcessRunner>[0] {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Agent",
      adapterType: overrides.adapterType,
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: "node",
      cwd: process.cwd(),
      ...(overrides.config ?? {}),
    },
    context: {},
    onLog: async () => {},
  };
}

describe("remote adapter transport reuse", () => {
  it("codex executeWithProcessRunner uses injected process runner", async () => {
    const runner = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "done" },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 1, output_tokens: 2, cached_input_tokens: 3 },
        }),
      ].join("\n"),
      stderr: "",
    }));

    const result = await executeCodexWithProcessRunner(
      buildBaseContext({ adapterType: "codex_local" }),
      runner,
    );

    expect(runner).toHaveBeenCalledTimes(1);
    expect(result.errorMessage ?? null).toBeNull();
    expect(result.sessionId).toBe("thread-1");
    expect(result.summary).toContain("done");
  });

  it("claude executeWithProcessRunner uses injected process runner", async () => {
    const runner = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "claude-session-1",
          model: "claude-sonnet",
        }),
        JSON.stringify({
          type: "result",
          session_id: "claude-session-1",
          result: "all good",
          usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 1 },
          total_cost_usd: 0.01,
        }),
      ].join("\n"),
      stderr: "",
    }));

    const result = await executeClaudeWithProcessRunner(
      buildBaseContext({ adapterType: "claude_local" }),
      runner,
    );

    expect(runner).toHaveBeenCalledTimes(1);
    expect(result.errorMessage ?? null).toBeNull();
    expect(result.sessionId).toBe("claude-session-1");
    expect(result.summary).toContain("all good");
  });
});
