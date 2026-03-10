#!/usr/bin/env node
/**
 * Paperclip Remote Worker
 *
 * Receives a task payload on stdin, executes `claude -p` in a git worktree,
 * and streams NDJSON progress back on stdout.
 *
 * Protocol (stdin):  Single JSON object, newline-terminated
 * Protocol (stdout): NDJSON lines:
 *   { "type": "log",    "stream": "stdout"|"stderr", "chunk": "..." }
 *   { "type": "meta",   "payload": { ... } }
 *   { "type": "result", ...AdapterExecutionResult }
 *
 * Stderr is used for worker-level diagnostics only.
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkerTask {
  runId: string;
  adapterType?: string;
  prompt?: string;
  repoUrl?: string;
  repoRef?: string;
  worktreeName?: string;
  cwd?: string;
  env?: Record<string, string>;
  claudeArgs?: string[];
  command?: string;
  args?: string[];
  stdin?: string;
  graceSec?: number;
  sessionId?: string;
  sessionState?: Record<string, unknown> | null;
  timeoutSec?: number;
  dangerouslySkipPermissions?: boolean;
  materializations?: Array<{
    archivePath: string;
    targetKind: "path" | "worktree";
    targetPath?: string;
  }>;
}

interface NdjsonLine {
  type: "log" | "meta" | "result" | "status";
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024; // 4MB cap on captured stdout/stderr

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emit(line: NdjsonLine) {
  process.stdout.write(JSON.stringify(line) + "\n");
}

function emitLog(stream: "stdout" | "stderr", chunk: string) {
  emit({ type: "log", stream, chunk });
}

function emitStatus(message: string) {
  emit({ type: "status", message });
}

function emitResult(result: Record<string, unknown>) {
  emit({ type: "result", ...result });
}

function diag(msg: string) {
  process.stderr.write(`[worker] ${msg}\n`);
}

function git(args: string[], opts?: { cwd?: string }): string {
  return execFileSync("git", args, {
    encoding: "utf-8",
    cwd: opts?.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function appendWithCap(prev: string, chunk: string, cap = MAX_CAPTURE_BYTES): string {
  const combined = prev + chunk;
  return combined.length > cap ? combined.slice(combined.length - cap) : combined;
}

/** Hash a repo URL to create a unique directory name, avoiding collisions. */
function repoSlug(repoUrl: string): string {
  const base = path.basename(repoUrl, ".git").replace(/[^a-zA-Z0-9_-]/g, "_");
  const hash = crypto.createHash("sha256").update(repoUrl).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

function expandHomePath(input: string): string {
  if (input === "~") return process.env.HOME ?? "/tmp";
  if (input.startsWith("~/")) {
    return path.join(process.env.HOME ?? "/tmp", input.slice(2));
  }
  return input;
}

function extractArchive(archivePath: string, targetDir: string) {
  fs.mkdirSync(targetDir, { recursive: true });
  emitStatus(`Extracting ${archivePath} into ${targetDir}`);
  execFileSync("tar", ["-xzf", expandHomePath(archivePath), "-C", targetDir], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function materializeArchives(
  materializations: WorkerTask["materializations"],
  workDir: string,
) {
  for (const materialization of materializations ?? []) {
    if (!materialization || typeof materialization.archivePath !== "string") continue;
    const targetDir =
      materialization.targetKind === "worktree"
        ? workDir
        : materialization.targetPath
          ? expandHomePath(materialization.targetPath)
          : null;
    if (!targetDir) continue;
    extractArchive(materialization.archivePath, targetDir);
  }
}

// ---------------------------------------------------------------------------
// Worktree management
// ---------------------------------------------------------------------------

function ensureRepo(repoUrl: string, baseDir: string): string {
  const repoDir = path.join(baseDir, repoSlug(repoUrl));

  if (fs.existsSync(path.join(repoDir, ".git"))) {
    emitStatus(`Fetching latest from ${repoUrl}`);
    git(["fetch", "--all", "--prune"], { cwd: repoDir });
    return repoDir;
  }

  emitStatus(`Cloning ${repoUrl}`);
  git(["clone", repoUrl, repoDir]);
  return repoDir;
}

function createWorktree(repoDir: string, name: string, ref: string): string {
  const worktreeDir = path.join(path.dirname(repoDir), "worktrees", name);
  const branchName = name.replace(/[^a-zA-Z0-9._/-]/g, "-");

  if (fs.existsSync(worktreeDir)) {
    emitStatus(`Reusing existing worktree at ${worktreeDir}`);
    try {
      git(["checkout", branchName], { cwd: worktreeDir });
      try {
        git(["pull", "--ff-only"], { cwd: worktreeDir });
      } catch {
        // pull may fail if detached or no upstream - that's ok
      }
    } catch {
      // If checkout fails, the worktree is stale - remove and recreate
      git(["worktree", "remove", "--force", worktreeDir], { cwd: repoDir });
    }
  }

  if (!fs.existsSync(worktreeDir)) {
    emitStatus(`Creating worktree ${name} from ${ref}`);
    // Resolve the ref, falling back to HEAD if not found
    let resolvedRef = ref;
    try {
      git(["rev-parse", "--verify", ref], { cwd: repoDir });
    } catch {
      try {
        git(["rev-parse", "--verify", `origin/${ref}`], { cwd: repoDir });
        try {
          git(["branch", ref, `origin/${ref}`], { cwd: repoDir });
        } catch {
          // branch may already exist
        }
      } catch {
        diag(`Ref ${ref} not found, falling back to HEAD`);
        resolvedRef = "HEAD";
      }
    }
    const branchExists = (() => {
      try {
        git(["show-ref", "--verify", `refs/heads/${branchName}`], { cwd: repoDir });
        return true;
      } catch {
        return false;
      }
    })();

    if (branchExists) {
      git(["worktree", "add", worktreeDir, branchName], { cwd: repoDir });
    } else {
      git(["worktree", "add", "-b", branchName, worktreeDir, resolvedRef], { cwd: repoDir });
    }
  }

  return worktreeDir;
}

// ---------------------------------------------------------------------------
// Claude execution
// ---------------------------------------------------------------------------

async function runClaude(task: WorkerTask, cwd: string): Promise<void> {
  const args = [
    "--print", "-",
    "--output-format", "stream-json",
    "--verbose",
  ];

  // Only skip permissions if explicitly requested (default: true for backward compat)
  if (task.dangerouslySkipPermissions !== false) {
    args.push("--dangerously-skip-permissions");
  }

  if (task.sessionId) {
    args.push("--resume", task.sessionId);
  }

  if (task.claudeArgs) {
    args.push(...task.claudeArgs);
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(task.env ?? {}),
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  };
  // Remove CLAUDECODE so child processes don't think they're nested
  delete env.CLAUDECODE;

  emitStatus(`Running claude in ${cwd}`);
  emit({
    type: "meta",
    payload: {
      adapterType: "ssh_remote",
      command: "claude",
      cwd,
      commandArgs: args,
    },
  });

  return new Promise<void>((resolve) => {
    const child: ChildProcess = spawn("claude", args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    // Send prompt on stdin
    if (child.stdin) {
      child.stdin.write(task.prompt);
      child.stdin.end();
    }

    let timeout: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;

    if (task.timeoutSec && task.timeoutSec > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 15000);
      }, task.timeoutSec * 1000);
    }

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout = appendWithCap(stdout, text);
      emitLog("stdout", text);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = appendWithCap(stderr, text);
      emitLog("stderr", text);
    });

    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      emitResult({
        exitCode: -1,
        signal: null,
        timedOut: false,
        errorMessage: `Failed to start claude: ${err.message}`,
        resultJson: { stdout, stderr },
      });
      resolve();
    });

    child.on("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);

      // Try to extract session ID from the stream-json output
      let sessionId: string | null = null;
      let usage: Record<string, unknown> | null = null;
      let costUsd: number | null = null;
      let model: string | null = null;
      let summary: string | null = null;

      try {
        for (const line of stdout.split("\n")) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === "result") {
              sessionId = obj.session_id ?? sessionId;
              summary = obj.result ?? summary;
              costUsd = obj.total_cost_usd ?? costUsd;
              model = obj.model ?? model;
              if (obj.usage) {
                usage = {
                  inputTokens: obj.usage.input_tokens ?? 0,
                  outputTokens: obj.usage.output_tokens ?? 0,
                  cachedInputTokens: obj.usage.cache_read_input_tokens ?? 0,
                };
              }
            }
            if (obj.session_id) sessionId = obj.session_id;
          } catch {
            // not JSON, skip
          }
        }
      } catch {
        // parsing failed, continue
      }

      emitResult({
        exitCode: code,
        signal,
        timedOut,
        errorMessage: timedOut
          ? `Timed out after ${task.timeoutSec}s`
          : (code ?? 0) !== 0
            ? `Claude exited with code ${code ?? -1}`
            : null,
        sessionId,
        sessionParams: sessionId ? { sessionId, cwd } : null,
        sessionDisplayId: sessionId,
        provider: "anthropic",
        model,
        billingType: "subscription",
        costUsd,
        usage,
        summary,
        resultJson: { stdout, stderr },
      });
      resolve();
    });
  });
}

async function runProcess(task: WorkerTask, cwd: string): Promise<void> {
  const command = (task.command ?? "").trim();
  if (!command) {
    emitResult({
      exitCode: -1,
      signal: null,
      timedOut: false,
      errorMessage: "Remote process execution requires command",
      errorCode: "missing_command",
    });
    return;
  }
  const args = Array.isArray(task.args) ? task.args.filter((value) => typeof value === "string") : [];
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(task.env ?? {}),
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  };
  delete env.CLAUDECODE;

  emitStatus(`Running ${command} in ${cwd}`);
  emit({
    type: "meta",
    payload: {
      adapterType: "process",
      command,
      cwd,
      commandArgs: args,
    },
  });

  return new Promise<void>((resolve) => {
    const child: ChildProcess = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    if (child.stdin) {
      if (typeof task.stdin === "string" && task.stdin.length > 0) {
        child.stdin.write(task.stdin);
      }
      child.stdin.end();
    }

    let timeout: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    const graceSec = task.graceSec && task.graceSec > 0 ? task.graceSec : 20;

    if (task.timeoutSec && task.timeoutSec > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, graceSec * 1000);
      }, task.timeoutSec * 1000);
    }

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout = appendWithCap(stdout, text);
      emitLog("stdout", text);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = appendWithCap(stderr, text);
      emitLog("stderr", text);
    });

    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      emitResult({
        exitCode: -1,
        signal: null,
        timedOut: false,
        errorMessage: `Failed to start command: ${err.message}`,
        resultJson: { stdout, stderr },
      });
      resolve();
    });

    child.on("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      emitResult({
        exitCode: code,
        signal,
        timedOut,
        errorMessage: timedOut
          ? `Timed out after ${task.timeoutSec}s`
          : (code ?? 0) !== 0
            ? `Process exited with code ${code ?? -1}`
            : null,
        sessionId:
          typeof task.sessionState?.sessionId === "string"
            ? task.sessionState.sessionId
            : null,
        sessionParams:
          task.sessionState && typeof task.sessionState === "object"
            ? task.sessionState
            : null,
        sessionDisplayId:
          typeof task.sessionState?.sessionId === "string"
            ? task.sessionState.sessionId
            : null,
        resultJson: { stdout, stderr },
      });
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  diag("Worker started, reading task from stdin...");

  const rl = readline.createInterface({ input: process.stdin });
  let inputData = "";

  for await (const line of rl) {
    inputData += line + "\n";
    // Try to parse after each line - task is a single JSON object
    try {
      JSON.parse(inputData);
      break;
    } catch {
      continue;
    }
  }

  let task: WorkerTask;
  try {
    task = JSON.parse(inputData);
  } catch (err) {
    emitResult({
      exitCode: -1,
      signal: null,
      timedOut: false,
      errorMessage: `Failed to parse task JSON: ${err}`,
    });
    process.exit(1);
  }

  diag(`Task received: runId=${task.runId}`);

  let workDir: string;

  try {
    if (task.cwd && fs.existsSync(task.cwd)) {
      // Direct cwd mode - use as-is
      workDir = task.cwd;
    } else if (task.repoUrl) {
      // Worktree mode - clone repo and create worktree
      const baseDir = path.join(
        process.env.HOME ?? "/tmp",
        "paperclip-remote",
      );
      fs.mkdirSync(baseDir, { recursive: true });

      const repoDir = ensureRepo(task.repoUrl, baseDir);
      const ref = task.repoRef ?? "main";
      // Default worktree name uses task key (stable across runs) not run ID
      const worktreeName = task.worktreeName ?? `task-${task.runId.slice(0, 8)}`;
      workDir = createWorktree(repoDir, worktreeName, ref);
    } else if (task.cwd) {
      // cwd specified but doesn't exist - create it
      fs.mkdirSync(task.cwd, { recursive: true });
      workDir = task.cwd;
    } else {
      workDir = process.cwd();
    }
  } catch (err) {
    // Always emit a result even if workspace setup fails
    emitResult({
      exitCode: -1,
      signal: null,
      timedOut: false,
      errorMessage: `Workspace setup failed: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "workspace_setup_failed",
    });
    return;
  }

  emitStatus(`Working directory: ${workDir}`);
  try {
    materializeArchives(task.materializations, workDir);
  } catch (err) {
    emitResult({
      exitCode: -1,
      signal: null,
      timedOut: false,
      errorMessage: `Workspace materialization failed: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "workspace_materialization_failed",
    });
    return;
  }

  try {
    if ((task.adapterType ?? "claude_local") === "process") {
      await runProcess(task, workDir);
    } else {
      await runClaude(task, workDir);
    }
  } catch (err) {
    emitResult({
      exitCode: -1,
      signal: null,
      timedOut: false,
      errorMessage: `Worker error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

main().catch((err) => {
  // Last-resort error handler - always emit a result
  try {
    emitResult({
      exitCode: -1,
      signal: null,
      timedOut: false,
      errorMessage: `Fatal worker error: ${err instanceof Error ? err.message : String(err)}`,
    });
  } catch {
    // stdout may be broken
  }
  diag(`Fatal error: ${err}`);
  process.exit(1);
});
