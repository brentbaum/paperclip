import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import {
  collectRemoteAgentContextFiles,
  HEARTBEAT_ORPHAN_REAP_STALE_THRESHOLD_MS,
  inferRepoFromWorkingDirectory,
  resolveGitIdentityForRemoteCommit,
  resolveRemoteRepoForExecution,
  resolveRuntimeSessionParamsForWorkspace,
  shouldReapRunAsOrphan,
  shouldResetTaskSessionForWake,
  type ResolvedWorkspaceForRun,
} from "../services/heartbeat.ts";

function buildResolvedWorkspace(overrides: Partial<ResolvedWorkspaceForRun> = {}): ResolvedWorkspaceForRun {
  return {
    cwd: "/tmp/project",
    source: "project_primary",
    projectId: "project-1",
    workspaceId: "workspace-1",
    repoUrl: null,
    repoRef: null,
    workspaceHints: [],
    warnings: [],
    ...overrides,
  };
}

describe("resolveRuntimeSessionParamsForWorkspace", () => {
  it("migrates fallback workspace sessions to project workspace when project cwd becomes available", () => {
    const agentId = "agent-123";
    const fallbackCwd = resolveDefaultAgentWorkspaceDir(agentId);

    const result = resolveRuntimeSessionParamsForWorkspace({
      agentId,
      previousSessionParams: {
        sessionId: "session-1",
        cwd: fallbackCwd,
        workspaceId: "workspace-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({ cwd: "/tmp/new-project-cwd" }),
    });

    expect(result.sessionParams).toMatchObject({
      sessionId: "session-1",
      cwd: "/tmp/new-project-cwd",
      workspaceId: "workspace-1",
    });
    expect(result.warning).toContain("Attempting to resume session");
  });

  it("does not migrate when previous session cwd is not the fallback workspace", () => {
    const result = resolveRuntimeSessionParamsForWorkspace({
      agentId: "agent-123",
      previousSessionParams: {
        sessionId: "session-1",
        cwd: "/tmp/some-other-cwd",
        workspaceId: "workspace-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({ cwd: "/tmp/new-project-cwd" }),
    });

    expect(result.sessionParams).toEqual({
      sessionId: "session-1",
      cwd: "/tmp/some-other-cwd",
      workspaceId: "workspace-1",
    });
    expect(result.warning).toBeNull();
  });

  it("does not migrate when resolved workspace id differs from previous session workspace id", () => {
    const agentId = "agent-123";
    const fallbackCwd = resolveDefaultAgentWorkspaceDir(agentId);

    const result = resolveRuntimeSessionParamsForWorkspace({
      agentId,
      previousSessionParams: {
        sessionId: "session-1",
        cwd: fallbackCwd,
        workspaceId: "workspace-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({
        cwd: "/tmp/new-project-cwd",
        workspaceId: "workspace-2",
      }),
    });

    expect(result.sessionParams).toEqual({
      sessionId: "session-1",
      cwd: fallbackCwd,
      workspaceId: "workspace-1",
    });
    expect(result.warning).toBeNull();
  });
});

describe("inferRepoFromWorkingDirectory", () => {
  it("infers repo metadata from a configured agent cwd inside a git checkout", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-heartbeat-git-"));
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "paperclip@example.com"], {
      cwd: repoDir,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Paperclip"], {
      cwd: repoDir,
      stdio: "ignore",
    });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:test/ifs-companion.git"], {
      cwd: repoDir,
      stdio: "ignore",
    });
    await fs.writeFile(path.join(repoDir, "README.md"), "hello\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });

    const nestedCwd = path.join(repoDir, "packages", "app");
    await fs.mkdir(nestedCwd, { recursive: true });

    const inferred = await inferRepoFromWorkingDirectory(nestedCwd);
    const expectedRepoRoot = await fs.realpath(repoDir);

    expect(inferred).toMatchObject({
      repoRoot: expectedRepoRoot,
      repoUrl: "git@github.com:test/ifs-companion.git",
      repoRef: "main",
    });
  });
});

describe("resolveRemoteRepoForExecution", () => {
  it("falls back to the configured agent cwd when resolved workspace repo metadata is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-remote-repo-"));
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });
    execFileSync("git", ["init", "-b", "develop"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "paperclip@example.com"], {
      cwd: repoDir,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Paperclip"], {
      cwd: repoDir,
      stdio: "ignore",
    });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:test/remote-repo.git"], {
      cwd: repoDir,
      stdio: "ignore",
    });
    await fs.writeFile(path.join(repoDir, "README.md"), "remote\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
    const expectedRepoRoot = await fs.realpath(repoDir);

    const result = await resolveRemoteRepoForExecution({
      resolvedWorkspace: buildResolvedWorkspace({
        cwd: resolveDefaultAgentWorkspaceDir("agent-123"),
        repoUrl: null,
        repoRef: null,
      }),
      previousSessionParams: null,
      runtimeSessionParams: { cwd: resolveDefaultAgentWorkspaceDir("agent-123") },
      agentAdapterConfig: { cwd: repoDir },
    });

    expect(result).toMatchObject({
      repoUrl: "git@github.com:test/remote-repo.git",
      repoRef: "develop",
      repoRoot: expectedRepoRoot,
      sourceCwd: repoDir,
    });
  });

  it("keeps the resolved repo URL while still finding a local repo root for remote seeding", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-remote-repo-root-"));
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "paperclip@example.com"], {
      cwd: repoDir,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Paperclip"], {
      cwd: repoDir,
      stdio: "ignore",
    });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:test/remote-repo.git"], {
      cwd: repoDir,
      stdio: "ignore",
    });
    await fs.writeFile(path.join(repoDir, "README.md"), "remote\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
    const expectedRepoRoot = await fs.realpath(repoDir);

    const result = await resolveRemoteRepoForExecution({
      resolvedWorkspace: buildResolvedWorkspace({
        cwd: resolveDefaultAgentWorkspaceDir("agent-123"),
        repoUrl: "git@github.com:test/remote-repo.git",
        repoRef: "main",
      }),
      previousSessionParams: null,
      runtimeSessionParams: null,
      agentAdapterConfig: { cwd: repoDir },
    });

    expect(result).toMatchObject({
      repoUrl: "git@github.com:test/remote-repo.git",
      repoRef: "main",
      repoRoot: expectedRepoRoot,
      sourceCwd: repoDir,
    });
  });
});

describe("resolveGitIdentityForRemoteCommit", () => {
  it("prefers repo git identity from the inferred repo root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-identity-"));
    const repoDir = path.join(root, "repo");
    await fs.mkdir(repoDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "founder@example.com"], {
      cwd: repoDir,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Brent Baum"], {
      cwd: repoDir,
      stdio: "ignore",
    });

    const identity = await resolveGitIdentityForRemoteCommit({
      repoRoot: repoDir,
      sourceCwd: repoDir,
      resolvedWorkspace: buildResolvedWorkspace({ cwd: resolveDefaultAgentWorkspaceDir("agent-123") }),
      previousSessionParams: null,
      runtimeSessionParams: null,
      agentAdapterConfig: { cwd: repoDir },
    });

    expect(identity).toEqual({
      name: "Brent Baum",
      email: "founder@example.com",
      source: "repo",
      sourceCwd: repoDir,
    });
  });

  it("returns null when no git identity can be resolved", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-identity-missing-"));
    const readGlobalGitConfig = (key: string) => {
      try {
        return execFileSync("git", ["config", "--global", "--get", key], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        return "";
      }
    };
    const globalName = readGlobalGitConfig("user.name");
    const globalEmail = readGlobalGitConfig("user.email");

    const identity = await resolveGitIdentityForRemoteCommit({
      repoRoot: null,
      sourceCwd: null,
      resolvedWorkspace: buildResolvedWorkspace({ cwd: root, workspaceHints: [] }),
      previousSessionParams: null,
      runtimeSessionParams: null,
      agentAdapterConfig: { cwd: root },
    });

    if (globalName && globalEmail) {
      expect(identity).toEqual({
        name: globalName,
        email: globalEmail,
        source: "global",
        sourceCwd: null,
      });
    } else {
      expect(identity).toBeNull();
    }
  });
});

describe("collectRemoteAgentContextFiles", () => {
  it("stages only files under agents/ while preserving remote-relative paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-agent-files-"));
    const repoDir = path.join(root, "repo");
    await fs.mkdir(path.join(repoDir, "agents", "founding-engineer"), { recursive: true });
    await fs.mkdir(path.join(repoDir, "memory"), { recursive: true });
    await fs.mkdir(path.join(repoDir, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(repoDir, "agents", "founding-engineer", "CLAUDE.md"), "# Agent\n", "utf8");
    await fs.writeFile(path.join(repoDir, "agents", "founding-engineer", "context.json"), "{\n  \"ok\": true\n}\n", "utf8");
    await fs.writeFile(path.join(repoDir, "AGENTS.md"), "# Top Level\n", "utf8");
    await fs.writeFile(path.join(repoDir, "memory", "MEMORY.md"), "# Memory\n", "utf8");
    await fs.writeFile(path.join(repoDir, "node_modules", "pkg", "README.md"), "# Ignore\n", "utf8");

    const staged = await collectRemoteAgentContextFiles({
      repoRoot: repoDir,
      agentAdapterConfig: { cwd: repoDir },
    });

    expect(staged?.fileCount).toBe(2);
    const agentPromptBody = await fs.readFile(
      path.join(staged!.stagingDir, "agents", "founding-engineer", "CLAUDE.md"),
      "utf8",
    );
    const agentContextBody = await fs.readFile(
      path.join(staged!.stagingDir, "agents", "founding-engineer", "context.json"),
      "utf8",
    );
    expect(agentPromptBody).toContain("# Agent");
    expect(agentContextBody).toContain("\"ok\": true");
    const topLevelExists = await fs
      .stat(path.join(staged!.stagingDir, "AGENTS.md"))
      .then(() => true)
      .catch(() => false);
    expect(topLevelExists).toBe(false);
    const ignoredExists = await fs
      .stat(path.join(staged!.stagingDir, "memory", "MEMORY.md"))
      .then(() => true)
      .catch(() => false);
    expect(ignoredExists).toBe(false);
    await fs.rm(staged!.stagingDir, { recursive: true, force: true });
  });
});

describe("shouldReapRunAsOrphan", () => {
  it("does not reap a freshly updated run", () => {
    const now = new Date("2026-03-10T19:20:00.000Z");
    const run = {
      updatedAt: new Date(now.getTime() - 30_000),
    };

    expect(shouldReapRunAsOrphan(run, now, HEARTBEAT_ORPHAN_REAP_STALE_THRESHOLD_MS)).toBe(false);
  });

  it("reaps a run once it exceeds the stale threshold", () => {
    const now = new Date("2026-03-10T19:20:00.000Z");
    const run = {
      updatedAt: new Date(now.getTime() - HEARTBEAT_ORPHAN_REAP_STALE_THRESHOLD_MS - 1),
    };

    expect(shouldReapRunAsOrphan(run, now, HEARTBEAT_ORPHAN_REAP_STALE_THRESHOLD_MS)).toBe(true);
  });
});

describe("shouldResetTaskSessionForWake", () => {
  it("resets session context on assignment wake", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "issue_assigned" })).toBe(true);
  });

  it("preserves session context on timer heartbeats", () => {
    expect(shouldResetTaskSessionForWake({ wakeSource: "timer" })).toBe(false);
  });

  it("preserves session context on manual on-demand invokes by default", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "manual",
      }),
    ).toBe(false);
  });

  it("resets session context when a fresh session is explicitly requested", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "manual",
        forceFreshSession: true,
      }),
    ).toBe(true);
  });

  it("does not reset session context on mention wake comment", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeReason: "issue_comment_mentioned",
        wakeCommentId: "comment-1",
      }),
    ).toBe(false);
  });

  it("does not reset session context when commentId is present", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeReason: "issue_commented",
        commentId: "comment-2",
      }),
    ).toBe(false);
  });

  it("does not reset for comment wakes", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "issue_commented" })).toBe(false);
  });

  it("does not reset when wake reason is missing", () => {
    expect(shouldResetTaskSessionForWake({})).toBe(false);
  });

  it("does not reset session context on callback on-demand invokes", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "callback",
      }),
    ).toBe(false);
  });
});
