import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AdapterExecutionResult, AdapterInvocationMeta } from "../adapters/index.js";
import { runningProcesses } from "../adapters/index.js";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
  parseObject,
} from "../adapters/utils.js";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

export interface RemoteWorkerResultLine extends AdapterExecutionResult {
  type: "result";
}

type RemoteWorkerLogLine = {
  type: "log";
  stream: "stdout" | "stderr";
  chunk: string;
};

type RemoteWorkerMetaLine = {
  type: "meta";
  payload: Record<string, unknown>;
};

type RemoteWorkerStatusLine = {
  type: "status";
  message: string;
};

type RemoteWorkerLine =
  | RemoteWorkerLogLine
  | RemoteWorkerMetaLine
  | RemoteWorkerResultLine
  | RemoteWorkerStatusLine;

export type RemoteExecutionTargetTestResult = {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  errorMessage: string | null;
};

export type RemoteArchiveMaterialization = {
  archivePath: string;
  targetKind: "path" | "worktree";
  targetPath?: string;
};

type RemoteRuntimePathSync = {
  localPath: string;
  remotePath: string;
  remoteExtractDir: string;
  remoteArchivePath: string;
  dereferenceSymlinks: boolean;
  materialization: RemoteArchiveMaterialization;
};

export function quotePosix(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function quoteRemoteShellWord(value: string) {
  if (value === "~") return '"$HOME"';
  if (value.startsWith("~/")) {
    return `"$HOME/${value
      .slice(2)
      .replace(/["\\$`]/g, "\\$&")}"`;
  }
  return quotePosix(value);
}

function readPort(metadata: Record<string, unknown>) {
  const candidate = asNumber(metadata.sshPort, 22);
  if (!Number.isFinite(candidate)) return 22;
  const port = Math.floor(candidate);
  return port > 0 ? port : 22;
}

function resolveRemoteHomeDir(user: string, metadata: Record<string, unknown> | null | undefined) {
  const parsed = parseObject(metadata);
  const configured = asString(parsed.remoteHomePath, "").trim();
  if (configured) return configured;
  return `/home/${user}`;
}

export function resolveRemoteAdapterHomeSync(input: {
  adapterType: string;
  env: Record<string, string>;
  targetUser: string;
  targetMetadata: Record<string, unknown> | null | undefined;
}) {
  const remoteHomeDir = resolveRemoteHomeDir(input.targetUser, input.targetMetadata);
  if (input.adapterType === "codex_local") {
    const localPath =
      (typeof input.env.CODEX_HOME === "string" && input.env.CODEX_HOME.trim().length > 0
        ? input.env.CODEX_HOME.trim()
        : typeof process.env.CODEX_HOME === "string" && process.env.CODEX_HOME.trim().length > 0
          ? process.env.CODEX_HOME.trim()
          : path.join(os.homedir(), ".codex"));
    return {
      localPath,
      remotePath: `${remoteHomeDir}/.codex`,
      envOverrides: { CODEX_HOME: `${remoteHomeDir}/.codex` },
    };
  }
  if (input.adapterType === "claude_local") {
    const localPath =
      (typeof input.env.CLAUDE_HOME === "string" && input.env.CLAUDE_HOME.trim().length > 0
        ? input.env.CLAUDE_HOME.trim()
        : typeof process.env.CLAUDE_HOME === "string" && process.env.CLAUDE_HOME.trim().length > 0
          ? process.env.CLAUDE_HOME.trim()
          : path.join(os.homedir(), ".claude"));
    return {
      localPath,
      remotePath: `${remoteHomeDir}/.claude`,
      envOverrides: typeof input.env.CLAUDE_HOME === "string" ? { CLAUDE_HOME: `${remoteHomeDir}/.claude` } : {},
    };
  }
  return null;
}

export function buildRemoteBranchName(input: {
  issueIdentifier: string | null;
  issueId: string;
  agentName: string;
}) {
  const rawBase = (input.issueIdentifier ?? input.issueId).trim();
  const safeBase = rawBase
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const safeAgent = input.agentName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const branch = `paperclip/${safeBase || "issue"}${safeAgent ? `-${safeAgent}` : ""}`;
  return branch.slice(0, 96);
}

export function buildRemoteRoot(input: { companyId: string; issueId: string }) {
  return `~/paperclip-remote/leases/${input.companyId}/${input.issueId}`;
}

export function buildRemoteRepoCheckoutPath(input: {
  targetUser: string;
  targetMetadata: Record<string, unknown> | null | undefined;
  repoUrl: string;
}) {
  const remoteHomeDir = resolveRemoteHomeDir(input.targetUser, input.targetMetadata);
  const base = path.basename(input.repoUrl, ".git").replace(/[^a-zA-Z0-9_-]/g, "_");
  const hash = createHash("sha256").update(input.repoUrl).digest("hex").slice(0, 8);
  return `${remoteHomeDir}/paperclip-remote/${base}-${hash}`;
}

export function encodeClaudeProjectPath(projectPath: string) {
  return projectPath.replace(/[\\/]+/g, "-").replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export function buildSshInvocation(input: {
  host: string;
  user: string;
  workerPath: string;
  metadata: Record<string, unknown> | null | undefined;
}) {
  const sshArgs = buildSshBaseArgs(input);
  const destination = `${input.user}@${input.host}`;
  const metadata = parseObject(input.metadata);
  const remoteNodePath = asString(metadata.nodePath, "node").trim() || "node";
  const remoteCommand = `${quoteRemoteShellWord(remoteNodePath)} ${quoteRemoteShellWord(input.workerPath)}`;

  return {
    command: "ssh",
    args: [...sshArgs, destination, remoteCommand],
  };
}

function buildSshBaseArgs(input: {
  metadata: Record<string, unknown> | null | undefined;
}) {
  const metadata = parseObject(input.metadata);
  const args: string[] = [];
  args.push("-o", "BatchMode=yes");
  args.push("-p", String(readPort(metadata)));
  if (asBoolean(metadata.forwardAgent, true)) {
    args.push("-A");
  }

  const keyPath = asString(metadata.privateKeyPath, "").trim();
  if (keyPath) {
    args.push("-i", keyPath);
  }

  const strictHostKeyChecking = asBoolean(metadata.strictHostKeyChecking, false);
  if (!strictHostKeyChecking) {
    args.push("-o", "StrictHostKeyChecking=no");
    args.push("-o", "UserKnownHostsFile=/dev/null");
  } else {
    const knownHostsPath = asString(metadata.knownHostsPath, "").trim();
    if (knownHostsPath) {
      args.push("-o", `UserKnownHostsFile=${knownHostsPath}`);
    }
  }

  const extraSshArgs = asStringArray(metadata.sshArgs);
  if (extraSshArgs.length > 0) args.push(...extraSshArgs);

  return args;
}

function buildSshScriptInvocation(input: {
  host: string;
  user: string;
  metadata: Record<string, unknown> | null | undefined;
  script: string;
}) {
  const sshArgs = buildSshBaseArgs(input);
  const destination = `${input.user}@${input.host}`;
  return {
    command: "ssh",
    args: [...sshArgs, destination, `/bin/sh -lc ${quotePosix(input.script)}`],
  };
}

export function parseRemoteWorkerLine(line: string): RemoteWorkerLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = asString(parsed.type, "");
  if (type === "log") {
    const stream = asString(parsed.stream, "");
    const chunk = asString(parsed.chunk, "");
    if ((stream === "stdout" || stream === "stderr") && chunk.length > 0) {
      return { type: "log", stream, chunk };
    }
    return null;
  }
  if (type === "meta") {
    return {
      type: "meta",
      payload: parseObject(parsed.payload),
    };
  }
  if (type === "status") {
    const message = asString(parsed.message, "");
    return { type: "status", message };
  }
  if (type === "result") {
    const usageRaw =
      typeof parsed.usage === "object" && parsed.usage !== null && !Array.isArray(parsed.usage)
        ? (parsed.usage as Record<string, unknown>)
        : null;
    const usage =
      usageRaw &&
      typeof usageRaw.inputTokens === "number" &&
      typeof usageRaw.outputTokens === "number"
        ? {
            inputTokens: usageRaw.inputTokens,
            outputTokens: usageRaw.outputTokens,
            cachedInputTokens:
              typeof usageRaw.cachedInputTokens === "number"
                ? usageRaw.cachedInputTokens
                : 0,
          }
        : undefined;
    const result: RemoteWorkerResultLine = {
      type: "result",
      exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : null,
      signal: typeof parsed.signal === "string" ? parsed.signal : null,
      timedOut: parsed.timedOut === true,
      errorMessage: typeof parsed.errorMessage === "string" ? parsed.errorMessage : undefined,
      errorCode: typeof parsed.errorCode === "string" ? parsed.errorCode : undefined,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      sessionDisplayId:
        typeof parsed.sessionDisplayId === "string" ? parsed.sessionDisplayId : undefined,
      sessionParams:
        typeof parsed.sessionParams === "object" &&
        parsed.sessionParams !== null &&
        !Array.isArray(parsed.sessionParams)
          ? (parsed.sessionParams as Record<string, unknown>)
          : undefined,
      provider: typeof parsed.provider === "string" ? parsed.provider : undefined,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      billingType:
        parsed.billingType === "api" || parsed.billingType === "subscription"
          ? parsed.billingType
          : undefined,
      costUsd: typeof parsed.costUsd === "number" ? parsed.costUsd : undefined,
      usage,
      summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
      resultJson:
        typeof parsed.resultJson === "object" && parsed.resultJson !== null
          ? (parsed.resultJson as Record<string, unknown>)
          : undefined,
      clearSession: parsed.clearSession === true ? true : undefined,
    };
    return result;
  }
  return null;
}

function buildRemoteArchivePath(remoteRoot: string, label: string, localPath: string) {
  const hash = createHash("sha256").update(`${label}:${localPath}`).digest("hex").slice(0, 12);
  return `${remoteRoot}/archives/${label}-${hash}.tar.gz`;
}

async function localPathExists(candidate: string | null | undefined) {
  if (!candidate) return false;
  return fs
    .stat(candidate)
    .then(() => true)
    .catch(() => false);
}

export async function uploadLocalPathAsRemoteArchive(input: {
  target: {
    host: string;
    user: string;
    metadata: Record<string, unknown> | null;
  };
  localPath: string;
  remoteArchivePath: string;
  exclude?: string[];
  dereferenceSymlinks?: boolean;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}) {
  const stats = await fs.stat(input.localPath);
  const sourceDir = stats.isDirectory() ? input.localPath : path.dirname(input.localPath);
  const sourceEntry = stats.isDirectory() ? "." : path.basename(input.localPath);
  const tarArgs = [
    ...(input.dereferenceSymlinks ? ["-h"] : []),
    "-C",
    sourceDir,
    "-czf",
    "-",
    ...(input.exclude ?? []).flatMap((pattern) => ["--exclude", pattern]),
    sourceEntry,
  ];
  const ssh = buildSshScriptInvocation({
    host: input.target.host,
    user: input.target.user,
    metadata: input.target.metadata,
    script: `set -eu; mkdir -p ${quoteRemoteShellWord(path.posix.dirname(input.remoteArchivePath))}; cat > ${quoteRemoteShellWord(input.remoteArchivePath)}`,
  });

  await input.onLog?.(
    "stderr",
    `[paperclip] Syncing ${input.localPath} to ${input.target.user}@${input.target.host}:${input.remoteArchivePath}\n`,
  );

  return await new Promise<void>((resolve, reject) => {
    const tarChild = spawn("tar", tarArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const sshChild = spawn(ssh.command, ssh.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    let stderrBuffer = "";
    const handleError = (err: unknown) => {
      tarChild.kill("SIGKILL");
      sshChild.kill("SIGKILL");
      reject(err);
    };

    tarChild.stdout.on("error", handleError);
    sshChild.stdin.on("error", handleError);
    tarChild.stdout.pipe(sshChild.stdin);

    tarChild.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderrBuffer += text;
      void input.onLog?.("stderr", text);
    });
    sshChild.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderrBuffer += text;
      void input.onLog?.("stderr", text);
    });

    tarChild.on("error", handleError);
    sshChild.on("error", handleError);

    let tarExited = false;
    let sshExited = false;
    let tarCode: number | null = null;
    let sshCode: number | null = null;

    const maybeResolve = () => {
      if (!tarExited || !sshExited) return;
      if ((tarCode ?? 1) !== 0) {
        reject(new Error(`tar archive upload failed with exit code ${tarCode ?? -1}: ${stderrBuffer.trim()}`));
        return;
      }
      if ((sshCode ?? 1) !== 0) {
        reject(new Error(`remote archive upload failed with exit code ${sshCode ?? -1}: ${stderrBuffer.trim()}`));
        return;
      }
      resolve();
    };

    tarChild.on("close", (code) => {
      tarExited = true;
      tarCode = code;
      maybeResolve();
    });
    sshChild.on("close", (code) => {
      sshExited = true;
      sshCode = code;
      maybeResolve();
    });
  });
}

export async function planRemoteRuntimePathSync(input: {
  args: string[];
  remoteRoot: string;
}) {
  const nextArgs = [...input.args];
  const syncs: RemoteRuntimePathSync[] = [];
  const pathFlags = new Set(["--add-dir", "--append-system-prompt-file"]);
  for (let idx = 0; idx < nextArgs.length - 1; idx += 1) {
    const flag = nextArgs[idx];
    if (!pathFlags.has(flag)) continue;
    const localPath = nextArgs[idx + 1] ?? "";
    if (!path.isAbsolute(localPath) || !(await localPathExists(localPath))) continue;
    const hash = createHash("sha256").update(localPath).digest("hex").slice(0, 12);
    const remoteExtractDir = `${input.remoteRoot}/runtime/${hash}`;
    const remotePath = `${remoteExtractDir}/${path.basename(localPath)}`;
    const remoteArchivePath = buildRemoteArchivePath(input.remoteRoot, `runtime-${hash}`, localPath);
    syncs.push({
      localPath,
      remotePath: (await fs.stat(localPath)).isDirectory() ? remoteExtractDir : remotePath,
      remoteExtractDir,
      remoteArchivePath,
      dereferenceSymlinks: true,
      materialization: {
        archivePath: remoteArchivePath,
        targetKind: "path",
        targetPath: remoteExtractDir,
      },
    });
    nextArgs[idx + 1] = (await fs.stat(localPath)).isDirectory() ? remoteExtractDir : remotePath;
  }

  return {
    args: nextArgs,
    syncs,
  };
}

export async function executeRemoteWorkerPayload(input: {
  runId: string;
  target: {
    host: string;
    user: string;
    workerPath: string;
    metadata: Record<string, unknown> | null;
  };
  payload: Record<string, unknown>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onMeta?: (meta: AdapterInvocationMeta) => Promise<void>;
  metaAdapterType?: string;
}) {
  const ssh = buildSshInvocation({
    host: input.target.host,
    user: input.target.user,
    workerPath: input.target.workerPath,
    metadata: input.target.metadata,
  });

  await input.onMeta?.({
    adapterType: input.metaAdapterType ?? "remote_worker",
    command: ssh.command,
    cwd: process.cwd(),
    commandArgs: ssh.args,
    env: {},
  });

  return new Promise<{
    result: RemoteWorkerResultLine | null;
    rawStdout: string;
    rawStderr: string;
  }>((resolve, reject) => {
    const child = spawn(ssh.command, ssh.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    runningProcesses.set(input.runId, { child, graceSec: 20 });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let rawStdout = "";
    let rawStderr = "";
    let lastResult: RemoteWorkerResultLine | null = null;
    let logChain: Promise<void> = Promise.resolve();

    const handleStdoutLine = (line: string) => {
      const parsed = parseRemoteWorkerLine(line);
      if (!parsed) {
        logChain = logChain.then(() => input.onLog("stdout", line + "\n"));
        return;
      }
      if (parsed.type === "log") {
        logChain = logChain.then(() => input.onLog(parsed.stream, parsed.chunk));
        return;
      }
      if (parsed.type === "status") {
        logChain = logChain.then(() => input.onLog("stderr", `[remote] ${parsed.message}\n`));
        return;
      }
      if (parsed.type === "meta") {
        if (input.onMeta) {
          logChain = logChain.then(() =>
            input.onMeta?.(parsed.payload as unknown as AdapterInvocationMeta),
          );
        }
        return;
      }
      if (parsed.type === "result") {
        lastResult = parsed;
      }
    };

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      rawStdout += text;
      stdoutBuffer += text;
      while (true) {
        const idx = stdoutBuffer.indexOf("\n");
        if (idx < 0) break;
        const line = stdoutBuffer.slice(0, idx);
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        handleStdoutLine(line);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      rawStderr += text;
      stderrBuffer += text;
      while (true) {
        const idx = stderrBuffer.indexOf("\n");
        if (idx < 0) break;
        const line = stderrBuffer.slice(0, idx);
        stderrBuffer = stderrBuffer.slice(idx + 1);
        logChain = logChain.then(() => input.onLog("stderr", line + "\n"));
      }
    });

    child.on("error", (err) => {
      runningProcesses.delete(input.runId);
      reject(err);
    });

    child.on("close", () => {
      runningProcesses.delete(input.runId);
      void logChain.finally(() => {
        resolve({
          result: lastResult,
          rawStdout,
          rawStderr,
        });
      });
    });

    child.stdin.write(JSON.stringify(input.payload) + "\n");
    child.stdin.end();
  });
}

export async function runRemoteProcess(input: {
  runId: string;
  target: {
    host: string;
    user: string;
    workerPath: string;
    metadata: Record<string, unknown> | null;
  };
  command: string;
  args: string[];
  cwd?: string;
  repoUrl?: string;
  repoRef?: string;
  worktreeName?: string;
  materializations?: RemoteArchiveMaterialization[];
  env: Record<string, string>;
  stdin?: string;
  timeoutSec: number;
  graceSec: number;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onMeta?: (meta: AdapterInvocationMeta) => Promise<void>;
}) {
  const payload: Record<string, unknown> = {
    runId: input.runId,
    adapterType: "process",
    command: input.command,
    args: input.args,
    env: input.env,
    timeoutSec: input.timeoutSec,
    graceSec: input.graceSec,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.repoUrl ? { repoUrl: input.repoUrl } : {}),
    ...(input.repoRef ? { repoRef: input.repoRef } : {}),
    ...(input.worktreeName ? { worktreeName: input.worktreeName } : {}),
    ...(input.materializations?.length ? { materializations: input.materializations } : {}),
    ...(typeof input.stdin === "string" ? { stdin: input.stdin } : {}),
  };

  const executed = await executeRemoteWorkerPayload({
    runId: input.runId,
    target: input.target,
    payload,
    onLog: input.onLog,
    onMeta: input.onMeta,
    metaAdapterType: "process:remote_ssh",
  });

  if (!executed.result) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: executed.rawStdout,
      stderr: executed.rawStderr,
    } satisfies RunProcessResult;
  }

  const resultJson =
    typeof executed.result.resultJson === "object" && executed.result.resultJson !== null
      ? (executed.result.resultJson as Record<string, unknown>)
      : null;
  const stdout =
    typeof resultJson?.stdout === "string" ? resultJson.stdout : executed.rawStdout;
  const stderr =
    typeof resultJson?.stderr === "string" ? resultJson.stderr : executed.rawStderr;
  return {
    exitCode: executed.result.exitCode ?? 1,
    signal: executed.result.signal ?? null,
    timedOut: executed.result.timedOut,
    stdout,
    stderr,
  } satisfies RunProcessResult;
}

export async function testRemoteExecutionTarget(input: {
  runId: string;
  target: {
    host: string;
    user: string;
    workerPath: string;
    metadata: Record<string, unknown> | null;
  };
}) {
  try {
    const result = await runRemoteProcess({
      runId: input.runId,
      target: input.target,
      command: "/bin/sh",
      args: ["-lc", "printf paperclip-remote-target-ok"],
      env: {},
      timeoutSec: 20,
      graceSec: 5,
      onLog: async () => {},
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const ok = result.exitCode === 0 && stdout.includes("paperclip-remote-target-ok");
    return {
      ok,
      exitCode: result.exitCode ?? null,
      timedOut: result.timedOut === true,
      stdout,
      stderr,
      errorMessage: ok
        ? null
        : result.timedOut
          ? "Remote target test timed out"
          : stderr.trim() || stdout.trim() || `Remote target test failed with exit code ${result.exitCode ?? -1}`,
    } satisfies RemoteExecutionTargetTestResult;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      exitCode: null,
      timedOut: false,
      stdout: "",
      stderr: errorMessage,
      errorMessage,
    } satisfies RemoteExecutionTargetTestResult;
  }
}

export async function executeRemoteRun(input: {
  runId: string;
  adapterType: string;
  target: {
    host: string;
    user: string;
    workerPath: string;
    metadata: Record<string, unknown> | null;
  };
  agent: { id: string; companyId: string };
  config: Record<string, unknown>;
  runtime: {
    sessionId: string | null;
    sessionParams: Record<string, unknown> | null;
  };
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onMeta?: (meta: AdapterInvocationMeta) => Promise<void>;
}) {
  if (input.adapterType !== "process") {
    throw new Error(
      `Remote execution does not yet support adapter type "${input.adapterType}". Use adapter "process" for remote runs currently.`,
    );
  }

  const command = asString(input.config.command, "").trim();
  if (!command) {
    throw new Error("Remote process execution requires adapterConfig.command");
  }
  const args = asStringArray(input.config.args);
  const cwd = asString(input.config.cwd, "").trim();
  const envConfig = parseObject(input.config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(input.agent) };
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  const proc = await runRemoteProcess({
    runId: input.runId,
    target: input.target,
    command,
    args,
    cwd: cwd || undefined,
    env,
    timeoutSec: asNumber(input.config.timeoutSec, 0),
    graceSec: asNumber(input.config.graceSec, 20),
    onLog: input.onLog,
    onMeta: input.onMeta,
  });

  if (proc.timedOut) {
    return {
      adapterResult: {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${asNumber(input.config.timeoutSec, 0)}s`,
      },
      lastResultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
      },
    };
  }

  if ((proc.exitCode ?? 0) !== 0) {
    return {
      adapterResult: {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: false,
        errorMessage: `Process exited with code ${proc.exitCode ?? -1}`,
        resultJson: {
          stdout: proc.stdout,
          stderr: proc.stderr,
        },
      },
      lastResultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
      },
    };
  }

  return {
    adapterResult: {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
      },
    },
    lastResultJson: {
      stdout: proc.stdout,
      stderr: proc.stderr,
    },
  };
}
