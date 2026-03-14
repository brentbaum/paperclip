#!/usr/bin/env node
import { spawn } from "node:child_process";

const requestedMode = process.argv[2];
const mode =
  requestedMode === "watch" || requestedMode === "built"
    ? requestedMode
    : "dev";
const cliArgs = process.argv.slice(3);
const SELF_RESTART_EXIT_CODE = 75;

const tailscaleAuthFlagNames = new Set([
  "--tailscale-auth",
  "--authenticated-private",
]);

let tailscaleAuth = false;
const forwardedArgs = [];

for (const arg of cliArgs) {
  if (tailscaleAuthFlagNames.has(arg)) {
    tailscaleAuth = true;
    continue;
  }
  forwardedArgs.push(arg);
}

if (process.env.npm_config_tailscale_auth === "true") {
  tailscaleAuth = true;
}
if (process.env.npm_config_authenticated_private === "true") {
  tailscaleAuth = true;
}

const env = {
  ...process.env,
};

if (tailscaleAuth) {
  env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
  env.PAPERCLIP_DEPLOYMENT_EXPOSURE = "private";
  env.PAPERCLIP_AUTH_BASE_URL_MODE = "auto";
  env.HOST = "0.0.0.0";
  console.log("[paperclip] dev mode: authenticated/private (tailscale-friendly) on 0.0.0.0");
} else {
  console.log("[paperclip] dev mode: local_trusted (default)");
}

const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
let activeChild = null;
let requestedSignal = null;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    requestedSignal = signal;
    if (activeChild) {
      activeChild.kill(signal);
      return;
    }
    process.exit(0);
  });
}

function spawnPnpm(args, childEnv) {
  return new Promise((resolve) => {
    const child = spawn(
      pnpmBin,
      args,
      { stdio: "inherit", env: childEnv },
    );
    activeChild = child;

    child.on("exit", (code, signal) => {
      if (activeChild === child) {
        activeChild = null;
      }
      resolve({ code, signal });
    });
  });
}

function exitForResult(result) {
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exit(result.code ?? 0);
}

async function run() {
  if (mode === "watch") {
    const result = await spawnPnpm(
      ["--filter", "@paperclipai/server", "dev:watch", ...forwardedArgs],
      {
        ...env,
        PAPERCLIP_UI_DEV_MIDDLEWARE: "true",
      },
    );
    exitForResult(result);
    return;
  }

  if (mode !== "built") {
    const result = await spawnPnpm(
      ["--filter", "@paperclipai/server", "dev", ...forwardedArgs],
      {
        ...env,
        PAPERCLIP_UI_DEV_MIDDLEWARE: "true",
      },
    );
    exitForResult(result);
    return;
  }

  console.log("[paperclip] built mode: build workspace, run compiled server, allow self-restart");
  while (!requestedSignal) {
    const buildResult = await spawnPnpm(["build"], env);
    if (requestedSignal || buildResult.code !== 0 || buildResult.signal) {
      exitForResult(buildResult);
      return;
    }

    const serverResult = await spawnPnpm(
      ["--filter", "@paperclipai/server", "start:built", ...forwardedArgs],
      {
        ...env,
        SERVE_UI: "true",
        PAPERCLIP_ALLOW_SELF_RESTART: "true",
        PAPERCLIP_SELF_RESTART_EXIT_CODE: String(SELF_RESTART_EXIT_CODE),
      },
    );

    if (requestedSignal) {
      exitForResult(serverResult);
      return;
    }

    if (serverResult.code === SELF_RESTART_EXIT_CODE) {
      console.log("[paperclip] restart requested; rebuilding and relaunching");
      continue;
    }

    exitForResult(serverResult);
    return;
  }
}

await run();
