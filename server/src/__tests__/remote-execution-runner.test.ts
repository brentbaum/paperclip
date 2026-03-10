import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRemoteBranchName,
  buildRemoteRepoCheckoutPath,
  buildSshInvocation,
  encodeClaudeProjectPath,
  parseRemoteWorkerLine,
  planRemoteRuntimePathSync,
  quotePosix,
  resolveRemoteAdapterHomeSync,
} from "../services/remote-execution-runner.js";

describe("remote execution runner helpers", () => {
  it("quotes single quotes for posix shell safely", () => {
    expect(quotePosix("abc")).toBe("'abc'");
    expect(quotePosix("a'b")).toBe("'a'\"'\"'b'");
  });

  it("builds a stable remote branch name", () => {
    const branch = buildRemoteBranchName({
      issueIdentifier: "TEAM-42",
      issueId: "issue-123",
      agentName: "Lead Engineer",
    });
    expect(branch).toBe("paperclip/team-42-lead-engineer");
  });

  it("builds ssh invocation with key, port, and strict host key checking off by default", () => {
    const invocation = buildSshInvocation({
      host: "127.0.0.1",
      user: "brewuser",
      workerPath: "/home/brew user/worker.js",
      metadata: {
        sshPort: 2222,
        privateKeyPath: "/tmp/test-key",
      },
    });

    expect(invocation.command).toBe("ssh");
    expect(invocation.args).toContain("-p");
    expect(invocation.args).toContain("2222");
    expect(invocation.args).toContain("-A");
    expect(invocation.args).toContain("-i");
    expect(invocation.args).toContain("/tmp/test-key");
    expect(invocation.args).toContain("brewuser@127.0.0.1");
    expect(invocation.args).toContain("'node' '/home/brew user/worker.js'");
    expect(invocation.args).toContain("StrictHostKeyChecking=no");
  });

  it("allows disabling ssh agent forwarding explicitly", () => {
    const invocation = buildSshInvocation({
      host: "127.0.0.1",
      user: "brewuser",
      workerPath: "/home/brewuser/worker.js",
      metadata: {
        forwardAgent: false,
      },
    });

    expect(invocation.args).not.toContain("-A");
  });

  it("expands home-relative worker paths on the remote shell", () => {
    const invocation = buildSshInvocation({
      host: "100.122.157.11",
      user: "brewuser",
      workerPath: "~/paperclip-remote-worker/dist/worker.js",
      metadata: null,
    });

    expect(invocation.args).toContain(`'node' "$HOME/paperclip-remote-worker/dist/worker.js"`);
  });

  it("parses worker log/meta/result lines", () => {
    const log = parseRemoteWorkerLine(
      JSON.stringify({ type: "log", stream: "stdout", chunk: "hello\n" }),
    );
    expect(log).toEqual({ type: "log", stream: "stdout", chunk: "hello\n" });

    const meta = parseRemoteWorkerLine(
      JSON.stringify({ type: "meta", payload: { adapterType: "process" } }),
    );
    expect(meta).toEqual({ type: "meta", payload: { adapterType: "process" } });

    const result = parseRemoteWorkerLine(
      JSON.stringify({ type: "result", exitCode: 0, signal: null, timedOut: false }),
    );
    expect(result).toMatchObject({ type: "result", exitCode: 0, timedOut: false });
  });

  it("returns null for non-json stdout lines", () => {
    expect(parseRemoteWorkerLine("plain output")).toBeNull();
  });

  it("plans runtime path sync for claude temp path arguments", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-"));
    const promptFile = path.join(root, "prompt.md");
    const addDir = path.join(root, "skills");
    await fs.writeFile(promptFile, "hello\n", "utf8");
    await fs.mkdir(addDir, { recursive: true });

    const planned = await planRemoteRuntimePathSync({
      args: ["--append-system-prompt-file", promptFile, "--add-dir", addDir],
      remoteRoot: "~/paperclip-remote/leases/company/issue",
    });

    expect(planned.args[1]).not.toBe(promptFile);
    expect(planned.args[3]).not.toBe(addDir);
    expect(planned.args[1]).toContain("~/paperclip-remote/leases/company/issue/runtime/");
    expect(planned.args[3]).toContain("~/paperclip-remote/leases/company/issue/runtime/");
    expect(planned.syncs).toHaveLength(2);
    expect(planned.syncs[0]?.materialization.targetKind).toBe("path");
  });

  it("resolves adapter home sync locations for codex and claude", () => {
    const codex = resolveRemoteAdapterHomeSync({
      adapterType: "codex_local",
      env: {},
      targetUser: "brewuser",
      targetMetadata: null,
    });
    const claude = resolveRemoteAdapterHomeSync({
      adapterType: "claude_local",
      env: {},
      targetUser: "brewuser",
      targetMetadata: null,
    });

    expect(codex?.remotePath).toBe("/home/brewuser/.codex");
    expect(codex?.envOverrides.CODEX_HOME).toBe("/home/brewuser/.codex");
    expect(claude?.remotePath).toBe("/home/brewuser/.claude");
  });

  it("derives stable remote repo and claude project paths", () => {
    const repoPath = buildRemoteRepoCheckoutPath({
      targetUser: "brewuser",
      targetMetadata: null,
      repoUrl: "git@github.com:evolveventures/evolve-ifs-observer.git",
    });
    expect(repoPath).toBe("/home/brewuser/paperclip-remote/evolve-ifs-observer-b99ade2b");
    expect(encodeClaudeProjectPath(repoPath)).toBe(
      "-home-brewuser-paperclip-remote-evolve-ifs-observer-b99ade2b",
    );
  });
});
