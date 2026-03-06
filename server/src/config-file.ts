import fs from "node:fs";
import { paperclipConfigSchema, type PaperclipConfig } from "@paperclipai/shared";
import { resolvePaperclipConfigPath } from "./paths.js";

export function readConfigFile(): PaperclipConfig | null {
  const configPath = resolvePaperclipConfigPath();

  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return paperclipConfigSchema.parse(raw);
  } catch {
    return null;
  }
}

export function writeConfigFile(config: PaperclipConfig): void {
  const configPath = resolvePaperclipConfigPath();
  const backupPath = `${configPath}.backup`;
  const serialized = JSON.stringify(config, null, 2) + "\n";

  if (fs.existsSync(configPath)) {
    fs.copyFileSync(configPath, backupPath);
    fs.chmodSync(backupPath, 0o600);
  }

  fs.writeFileSync(configPath, serialized, { mode: 0o600 });
}
