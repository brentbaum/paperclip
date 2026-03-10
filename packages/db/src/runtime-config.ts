import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { paperclipConfigSchema, type PaperclipConfig } from "@paperclipai/shared";

export type DatabaseTarget =
  | {
      kind: "external";
      connectionString: string;
    }
  | {
      kind: "embedded";
      connectionString: string;
      dataDir: string;
      port: number;
    };

function expandHomePrefix(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : null;
}

export function resolvePaperclipHomeDir(): string {
  const envHome = process.env.PAPERCLIP_HOME?.trim();
  if (envHome) return path.resolve(expandHomePrefix(envHome));
  return path.resolve(os.homedir(), ".paperclip");
}

export function resolvePaperclipInstanceId(): string {
  const raw = process.env.PAPERCLIP_INSTANCE_ID?.trim() || "default";
  if (!/^[a-zA-Z0-9_-]+$/.test(raw)) {
    throw new Error(`Invalid PAPERCLIP_INSTANCE_ID '${raw}'.`);
  }
  return raw;
}

export function resolvePaperclipInstanceRoot(): string {
  return path.resolve(resolvePaperclipHomeDir(), "instances", resolvePaperclipInstanceId());
}

export function resolveDefaultConfigPath(): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "config.json");
}

export function resolveDefaultEmbeddedPostgresDir(): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "db");
}

export function readPaperclipConfig(configPath = resolveDefaultConfigPath()): PaperclipConfig | null {
  if (!existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    return paperclipConfigSchema.parse(raw);
  } catch {
    return null;
  }
}

export function resolveEmbeddedPostgresPort(config: PaperclipConfig | null): number {
  return asPositiveInt(config?.database.embeddedPostgresPort) ?? 54329;
}

export function resolveEmbeddedPostgresDataDir(config: PaperclipConfig | null): string {
  const configured = config?.database.embeddedPostgresDataDir?.trim();
  if (configured) return path.resolve(expandHomePrefix(configured));
  return resolveDefaultEmbeddedPostgresDir();
}

export function resolveDatabaseTarget(
  config: PaperclipConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): DatabaseTarget {
  const envUrl = env.DATABASE_URL?.trim();
  if (envUrl) {
    return { kind: "external", connectionString: envUrl };
  }

  if (config?.database.mode === "postgres") {
    const configuredUrl = config.database.connectionString?.trim();
    if (configuredUrl) {
      return { kind: "external", connectionString: configuredUrl };
    }
  }

  const port = resolveEmbeddedPostgresPort(config);
  return {
    kind: "embedded",
    connectionString: `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`,
    dataDir: resolveEmbeddedPostgresDataDir(config),
    port,
  };
}
