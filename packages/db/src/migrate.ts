import { existsSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { resolve } from "node:path";
import {
  applyPendingMigrations,
  ensurePostgresDatabase,
  inspectMigrations,
  reconcilePendingMigrationHistory,
} from "./client.js";
import { readPaperclipConfig, resolveDatabaseTarget } from "./runtime-config.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
}) => EmbeddedPostgresInstance;

async function isTcpPortAcceptingConnections(port: number, host = "127.0.0.1"): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const socket = net.connect({ host, port });
    const onFailure = () => {
      socket.destroy();
      resolvePromise(false);
    };

    socket.setTimeout(750);
    socket.once("connect", () => {
      socket.end();
      resolvePromise(true);
    });
    socket.once("error", onFailure);
    socket.once("timeout", onFailure);
  });
}

async function findAvailablePort(startPort: number, host = "127.0.0.1"): Promise<number> {
  let candidate = startPort;
  while (candidate <= 65535) {
    const isBusy = await new Promise<boolean>((resolvePromise) => {
      const server = net.createServer();
      server.unref();
      server.once("error", () => resolvePromise(true));
      server.listen(candidate, host, () => {
        server.close(() => resolvePromise(false));
      });
    });
    if (!isBusy) return candidate;
    candidate += 1;
  }

  throw new Error(`Unable to find an available port starting from ${startPort}`);
}

async function withMigrationConnectionString(
  run: (connectionString: string) => Promise<void>,
): Promise<void> {
  const config = readPaperclipConfig();
  const target = resolveDatabaseTarget(config);
  if (target.kind === "external") {
    await run(target.connectionString);
    return;
  }

  const moduleName = "embedded-postgres";
  let EmbeddedPostgres: EmbeddedPostgresCtor;
  try {
    const mod = await import(moduleName);
    EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
  } catch {
    throw new Error(
      "Embedded PostgreSQL mode requires dependency `embedded-postgres`. Reinstall dependencies or set DATABASE_URL for external Postgres.",
    );
  }

  const configuredPort = target.port;
  let port = configuredPort;
  const dataDir = target.dataDir;
  const clusterVersionFile = resolve(dataDir, "PG_VERSION");
  const clusterAlreadyInitialized = existsSync(clusterVersionFile);
  const postmasterPidFile = resolve(dataDir, "postmaster.pid");

  const isPidRunning = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const getRunningPid = (): number | null => {
    if (!existsSync(postmasterPidFile)) return null;
    try {
      const pidLine = readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim();
      const pid = Number(pidLine);
      if (!Number.isInteger(pid) || pid <= 0) return null;
      if (!isPidRunning(pid)) return null;
      return pid;
    } catch {
      return null;
    }
  };

  let runningPid = getRunningPid();
  if (runningPid && !(await isTcpPortAcceptingConnections(port))) {
    runningPid = null;
    if (existsSync(postmasterPidFile)) {
      rmSync(postmasterPidFile, { force: true });
    }
  }

  let embeddedPostgres: EmbeddedPostgresInstance | null = null;
  let startedByThisProcess = false;
  if (!runningPid) {
    port = await findAvailablePort(configuredPort);
    embeddedPostgres = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "paperclip",
      password: "paperclip",
      port,
      persistent: true,
    });

    if (!clusterAlreadyInitialized) {
      await embeddedPostgres.initialise();
    }

    if (existsSync(postmasterPidFile)) {
      rmSync(postmasterPidFile, { force: true });
    }

    await embeddedPostgres.start();
    startedByThisProcess = true;
  }

  try {
    const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminConnectionString, "paperclip");
    await run(`postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`);
  } finally {
    if (startedByThisProcess) {
      await embeddedPostgres?.stop();
    }
  }
}

await withMigrationConnectionString(async (url) => {
  let before = await inspectMigrations(url);
  if (before.status === "needsMigrations" && before.reason === "pending-migrations") {
    const repair = await reconcilePendingMigrationHistory(url);
    if (repair.repairedMigrations.length > 0) {
      console.log(`Repaired ${repair.repairedMigrations.length} drifted migration journal entr${repair.repairedMigrations.length === 1 ? "y" : "ies"}.`);
      before = await inspectMigrations(url);
    }
  }

  if (before.status === "upToDate") {
    console.log("No pending migrations");
    return;
  }

  console.log(`Applying ${before.pendingMigrations.length} pending migration(s)...`);
  await applyPendingMigrations(url);

  const after = await inspectMigrations(url);
  if (after.status !== "upToDate") {
    throw new Error(`Migrations incomplete: ${after.pendingMigrations.join(", ")}`);
  }
  console.log("Migrations complete");
});
