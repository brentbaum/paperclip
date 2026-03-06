import fs from "node:fs/promises";
import path from "node:path";
import type { AgentFileContent, AgentFileEntry } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";

const DEFAULT_INSTRUCTIONS_PATH_KEYS: Record<string, string> = {
  claude_local: "instructionsFilePath",
  codex_local: "instructionsFilePath",
};
const KNOWN_INSTRUCTIONS_PATH_KEYS = ["instructionsFilePath", "agentsMdPath"] as const;
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);
const MAX_AGENT_FILE_BYTES = 512 * 1024;
const PREFERRED_NAMES = ["AGENTS.md", "CLAUDE.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md", "README.md"];

type AllowedRoot = {
  label: string;
  path: string;
  realPath: string | null;
};

type AgentFileContext = {
  id: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isMarkdownPath(filePath: string): boolean {
  return MARKDOWN_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function existingRealPath(targetPath: string): Promise<string | null> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return null;
  }
}

function resolveInstructionsFilePath(agent: AgentFileContext): string | null {
  const adapterConfig = asRecord(agent.adapterConfig) ?? {};
  const cwd = asNonEmptyString(adapterConfig.cwd);
  const resolveConfiguredPath = (value: string) => {
    if (path.isAbsolute(value)) return path.resolve(value);
    if (cwd && path.isAbsolute(cwd)) return path.resolve(cwd, value);
    return path.resolve(value);
  };
  const preferredKey = DEFAULT_INSTRUCTIONS_PATH_KEYS[agent.adapterType];
  if (preferredKey) {
    const configured = asNonEmptyString(adapterConfig[preferredKey]);
    if (configured) return resolveConfiguredPath(configured);
  }
  for (const key of KNOWN_INSTRUCTIONS_PATH_KEYS) {
    const configured = asNonEmptyString(adapterConfig[key]);
    if (configured) return resolveConfiguredPath(configured);
  }
  return null;
}

async function listMarkdownFiles(root: AllowedRoot): Promise<string[]> {
  try {
    const entries = await fs.readdir(root.path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && isMarkdownPath(entry.name))
      .map((entry) => path.resolve(root.path, entry.name));
  } catch {
    return [];
  }
}

function fileNamePriority(filePath: string): number {
  const index = PREFERRED_NAMES.indexOf(path.basename(filePath));
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function compareFiles(left: AgentFileEntry, right: AgentFileEntry): number {
  if (left.isInstructionsFile !== right.isInstructionsFile) return left.isInstructionsFile ? -1 : 1;
  const leftPriority = fileNamePriority(left.name);
  const rightPriority = fileNamePriority(right.name);
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  if (left.rootLabel !== right.rootLabel) return left.rootLabel.localeCompare(right.rootLabel);
  return left.relativePath.localeCompare(right.relativePath);
}

async function buildAllowedRoots(agent: AgentFileContext): Promise<{ roots: AllowedRoot[]; instructionsFilePath: string | null }> {
  const workspacePath = resolveDefaultAgentWorkspaceDir(agent.id);
  const instructionsFilePath = resolveInstructionsFilePath(agent);
  const rootMap = new Map<string, AllowedRoot>();

  const addRoot = async (label: string, targetPath: string) => {
    const resolvedPath = path.resolve(targetPath);
    if (rootMap.has(resolvedPath)) return;
    const stat = await fs.stat(resolvedPath).catch(() => null);
    if (!stat || !stat.isDirectory()) return;
    rootMap.set(resolvedPath, {
      label,
      path: resolvedPath,
      realPath: await existingRealPath(resolvedPath),
    });
  };

  await addRoot("Workspace", workspacePath);
  if (instructionsFilePath) {
    await addRoot("Instructions", path.dirname(instructionsFilePath));
  }

  return { roots: [...rootMap.values()], instructionsFilePath };
}

async function buildEntry(
  filePath: string,
  roots: AllowedRoot[],
  instructionsFilePath: string | null,
): Promise<AgentFileEntry | null> {
  if (!isMarkdownPath(filePath)) return null;

  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) return null;
  if (stat.size > MAX_AGENT_FILE_BYTES) return null;

  const realPath = await existingRealPath(filePath);
  if (!realPath) return null;

  const root = roots.find((candidate) => {
    if (isWithinRoot(filePath, candidate.path)) return true;
    if (candidate.realPath && isWithinRoot(realPath, candidate.realPath)) return true;
    return false;
  });
  if (!root) return null;

  return {
    path: filePath,
    name: path.basename(filePath),
    relativePath: path.relative(root.path, filePath),
    rootLabel: root.label,
    isInstructionsFile: Boolean(instructionsFilePath && path.resolve(instructionsFilePath) === path.resolve(filePath)),
    sizeBytes: stat.size,
    updatedAt: stat.mtime,
  };
}

async function resolveAllowedFile(agent: AgentFileContext, requestedPath: string) {
  const candidatePath = path.resolve(requestedPath);
  if (!isMarkdownPath(candidatePath)) {
    throw unprocessable("Only markdown files are supported");
  }

  const { roots, instructionsFilePath } = await buildAllowedRoots(agent);
  if (roots.length === 0) {
    throw notFound("No agent markdown roots available");
  }

  const entry = await buildEntry(candidatePath, roots, instructionsFilePath);
  if (!entry) {
    throw notFound("Agent file not found");
  }
  return { entry, roots, instructionsFilePath };
}

export function agentFileService() {
  return {
    listFiles: async (agent: AgentFileContext): Promise<AgentFileEntry[]> => {
      const { roots, instructionsFilePath } = await buildAllowedRoots(agent);
      if (roots.length === 0) return [];

      const fileSet = new Set<string>();
      if (instructionsFilePath) fileSet.add(path.resolve(instructionsFilePath));
      for (const root of roots) {
        const files = await listMarkdownFiles(root);
        for (const filePath of files) fileSet.add(filePath);
      }

      const entries = await Promise.all(
        [...fileSet].map((filePath) => buildEntry(filePath, roots, instructionsFilePath)),
      );

      return entries.filter((entry): entry is AgentFileEntry => Boolean(entry)).sort(compareFiles);
    },

    readFile: async (agent: AgentFileContext, requestedPath: string): Promise<AgentFileContent> => {
      const { entry } = await resolveAllowedFile(agent, requestedPath);
      const body = await fs.readFile(entry.path, "utf8");
      return {
        ...entry,
        body,
      };
    },

    writeFile: async (agent: AgentFileContext, requestedPath: string, body: string): Promise<AgentFileContent> => {
      const { entry } = await resolveAllowedFile(agent, requestedPath);
      const sizeBytes = Buffer.byteLength(body, "utf8");
      if (sizeBytes > MAX_AGENT_FILE_BYTES) {
        throw unprocessable(`File exceeds ${MAX_AGENT_FILE_BYTES} bytes`);
      }
      await fs.writeFile(entry.path, body, "utf8");
      const updatedBody = await fs.readFile(entry.path, "utf8");
      const stat = await fs.stat(entry.path);
      return {
        ...entry,
        body: updatedBody,
        sizeBytes: stat.size,
        updatedAt: stat.mtime,
      };
    },
  };
}
