import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  executeRemoteRun,
  runRemoteProcess,
} from "../services/remote-execution-runner.js";

const shouldRun =
  process.env.PAPERCLIP_RUN_REMOTE_DOCKER_TEST === "1" &&
  fs.existsSync("/tmp/paperclip-ssh-test-target/id_ed25519");
const target = {
  host: "127.0.0.1",
  user: "brewuser",
  workerPath: "/home/brewuser/paperclip-remote-worker/dist/worker.js",
  metadata: {
    sshPort: 2222,
    privateKeyPath: "/tmp/paperclip-ssh-test-target/id_ed25519",
    strictHostKeyChecking: false,
  },
} as const;

describe.skipIf(!shouldRun)("remote execution docker integration", () => {
  it(
    "executes process adapter payload over SSH worker",
    async () => {
      let stdout = "";
      let stderr = "";
      const { adapterResult } = await executeRemoteRun({
        runId: "run-remote-docker-test",
        adapterType: "process",
        target,
        agent: {
          id: "agent-test",
          companyId: "company-test",
        },
        config: {
          command: "node",
          args: ["-e", "process.stdout.write('ok')"],
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
        },
        onLog: async (stream, chunk) => {
          if (stream === "stdout") stdout += chunk;
          if (stream === "stderr") stderr += chunk;
        },
      });

      expect(adapterResult.errorMessage ?? null).toBeNull();
      expect(adapterResult.exitCode ?? 0).toBe(0);
      expect(stdout).toContain("ok");
      expect(stderr).not.toContain("error");
    },
    45000,
  );

  it(
    "supports lease-style branch push on reused remote worktree",
    async () => {
      const repoUrl = "/home/brewuser/paperclip-test-remotes/lease.git";
      const worktreeName = "lease-test-worktree";
      const branchName = "paperclip/lease-test";

      const init = await runRemoteProcess({
        runId: "remote-repo-init",
        target,
        command: "bash",
        args: [
          "-lc",
          [
            "set -eu",
            "rm -rf \"$HOME/paperclip-test-remotes\"",
            "rm -rf \"$HOME/paperclip-remote\"",
            "mkdir -p \"$HOME/paperclip-test-remotes\"",
            "git init --bare \"$HOME/paperclip-test-remotes/lease.git\"",
            "git clone \"$HOME/paperclip-test-remotes/lease.git\" \"$HOME/paperclip-test-remotes/seed\"",
            "cd \"$HOME/paperclip-test-remotes/seed\"",
            "git config user.email \"paperclip@example.com\"",
            "git config user.name \"Paperclip Bot\"",
            "echo \"init\" > README.md",
            "git add README.md",
            "git commit -m \"init\"",
            "git branch -M main",
            "git push -u origin main",
          ].join("\n"),
        ],
        env: {},
        timeoutSec: 60,
        graceSec: 20,
        onLog: async () => {},
      });
      expect(init.exitCode ?? 1).toBe(0);

      const edit = await runRemoteProcess({
        runId: "remote-repo-edit",
        target,
        command: "bash",
        args: ["-lc", "echo \"change\" >> README.md"],
        repoUrl,
        repoRef: "main",
        worktreeName,
        env: {},
        timeoutSec: 60,
        graceSec: 20,
        onLog: async () => {},
      });
      expect(edit.exitCode ?? 1).toBe(0);

      const push = await runRemoteProcess({
        runId: "remote-repo-push",
        target,
        command: "bash",
        args: [
          "-lc",
          [
            "set -eu",
            "git config user.email \"paperclip@example.com\"",
            "git config user.name \"Paperclip Bot\"",
            "if [ -n \"$(git status --porcelain)\" ]; then",
            "  git add -A",
            "  if ! git diff --cached --quiet; then",
            "    git commit -m \"paperclip lease test\"",
            "  fi",
            "fi",
            "sha=\"$(git rev-parse HEAD)\"",
            "git push -u origin \"HEAD:refs/heads/$PAPERCLIP_BRANCH\"",
            "printf '__PAPERCLIP_SHA__%s\\n' \"$sha\"",
          ].join("\n"),
        ],
        repoUrl,
        repoRef: "main",
        worktreeName,
        env: { PAPERCLIP_BRANCH: branchName },
        timeoutSec: 60,
        graceSec: 20,
        onLog: async () => {},
      });
      expect(push.exitCode ?? 1).toBe(0);
      const marker = push.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.startsWith("__PAPERCLIP_SHA__"));
      const pushedSha = marker?.replace("__PAPERCLIP_SHA__", "").trim() ?? "";
      expect(pushedSha).toMatch(/^[a-f0-9]{40}$/);

      const verify = await runRemoteProcess({
        runId: "remote-repo-verify",
        target,
        command: "bash",
        args: [
          "-lc",
          "git --git-dir \"$HOME/paperclip-test-remotes/lease.git\" rev-parse \"refs/heads/$PAPERCLIP_BRANCH\"",
        ],
        env: { PAPERCLIP_BRANCH: branchName },
        timeoutSec: 60,
        graceSec: 20,
        onLog: async () => {},
      });
      expect(verify.exitCode ?? 1).toBe(0);
      expect(verify.stdout.trim()).toBe(pushedSha);

      const pushAgain = await runRemoteProcess({
        runId: "remote-repo-push-again",
        target,
        command: "bash",
        args: [
          "-lc",
          [
            "set -eu",
            "sha=\"$(git rev-parse HEAD)\"",
            "git push -u origin \"HEAD:refs/heads/$PAPERCLIP_BRANCH\"",
            "printf '__PAPERCLIP_SHA__%s\\n' \"$sha\"",
          ].join("\n"),
        ],
        repoUrl,
        repoRef: "main",
        worktreeName,
        env: { PAPERCLIP_BRANCH: branchName },
        timeoutSec: 60,
        graceSec: 20,
        onLog: async () => {},
      });
      expect(pushAgain.exitCode ?? 1).toBe(0);
    },
    90000,
  );
});
