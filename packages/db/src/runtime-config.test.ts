import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PaperclipConfig } from "@paperclipai/shared";
import { resolveDatabaseTarget } from "./runtime-config.js";

function buildConfig(overrides?: Partial<PaperclipConfig["database"]>): PaperclipConfig {
  return {
    $meta: {
      version: 1,
      updatedAt: "2026-03-10T00:00:00.000Z",
      source: "configure",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: "~/.paperclip/instances/default/db",
      embeddedPostgresPort: 54329,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: "~/.paperclip/instances/default/data/backups",
      },
      ...overrides,
    },
    logging: {
      mode: "file",
      logDir: "~/.paperclip/instances/default/logs",
    },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
      tailscaleServe: false,
    },
    auth: {
      baseUrlMode: "auto",
    },
    storage: {
      provider: "local_disk",
      localDisk: {
        baseDir: "~/.paperclip/instances/default/data/storage",
      },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: {
        keyFilePath: "~/.paperclip/instances/default/secrets/master.key",
      },
    },
  };
}

describe("resolveDatabaseTarget", () => {
  it("prefers DATABASE_URL from the environment", () => {
    const target = resolveDatabaseTarget(buildConfig(), {
      DATABASE_URL: "postgres://env-user:env-pass@db.example.com:5432/paperclip",
    });

    expect(target).toEqual({
      kind: "external",
      connectionString: "postgres://env-user:env-pass@db.example.com:5432/paperclip",
    });
  });

  it("uses configured postgres connection strings when present", () => {
    const target = resolveDatabaseTarget(
      buildConfig({
        mode: "postgres",
        connectionString: "postgres://cfg-user:cfg-pass@localhost:5432/paperclip",
      }),
      {},
    );

    expect(target).toEqual({
      kind: "external",
      connectionString: "postgres://cfg-user:cfg-pass@localhost:5432/paperclip",
    });
  });

  it("falls back to embedded postgres with default paths", () => {
    const expectedRoot = path.resolve(os.homedir(), ".paperclip", "instances", "default");
    const target = resolveDatabaseTarget(null, {});

    expect(target).toEqual({
      kind: "embedded",
      connectionString: "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip",
      dataDir: path.resolve(expectedRoot, "db"),
      port: 54329,
    });
  });

  it("uses embedded config overrides when set", () => {
    const target = resolveDatabaseTarget(
      buildConfig({
        embeddedPostgresPort: 55444,
        embeddedPostgresDataDir: "~/custom-db",
      }),
      {},
    );

    expect(target).toEqual({
      kind: "embedded",
      connectionString: "postgres://paperclip:paperclip@127.0.0.1:55444/paperclip",
      dataDir: path.resolve(os.homedir(), "custom-db"),
      port: 55444,
    });
  });
});
