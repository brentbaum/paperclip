import { useState } from "react";
import type { TranscriptEntry } from "../adapters";
import { formatTokens } from "../lib/utils";

// ---------------------------------------------------------------------------
// Theme constants
// ---------------------------------------------------------------------------

export const RAIL_FONT = 'Monaco, ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", "Courier New", monospace';
export const RAIL_BG = "#11130f";
export const RAIL_PANEL = "#0e100d";
export const RAIL_BORDER = "rgba(156, 163, 175, 0.23)";
export const RAIL_TEXT = "#e5e7eb";
export const RAIL_MUTED = "#94a3b8";
export const TONE = {
  tool: "#86efac",
  assistant: "#e5e7eb",
  thinking: "#93c5fd",
  user: "#cbd5e1",
  result: "#22d3ee",
  warn: "#fbbf24",
  error: "#f87171",
  raw: "#9ca3af",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isNoiseSystemLine(text: string) {
  return (
    text === "turn started" ||
    text.startsWith("item started:") ||
    text.startsWith("item completed:") ||
    text.startsWith("[paperclip] Loaded agent instructions file:")
  );
}

export function shouldRenderEntry(entry: TranscriptEntry) {
  if (entry.kind === "init") return false;
  if (entry.kind === "system") return !isNoiseSystemLine(entry.text.trim());
  return true;
}

export function normalizeToolResult(content: string): string[] {
  const lines = content.replace(/\r/g, "").split("\n");
  if (lines.length === 0) return [];

  if (lines[0]?.startsWith("command:")) {
    const blankIdx = lines.findIndex((line) => line.trim() === "");
    if (blankIdx >= 0 && blankIdx < lines.length - 1) {
      const outputLines = lines.slice(blankIdx + 1).filter((line) => line.trim() !== "");
      if (outputLines.length > 0) return outputLines;
    }
  }

  return lines.filter((line) => line.trim() !== "");
}

// ---------------------------------------------------------------------------
// TUI-style tool name formatting
// ---------------------------------------------------------------------------

const TOOL_SHORT_NAMES: Record<string, string> = {
  Bash: "Bash",
  Read: "Read",
  Edit: "Edit",
  Write: "Write",
  Grep: "Grep",
  Glob: "Glob",
  Agent: "Agent",
  TodoWrite: "TodoWrite",
  WebFetch: "WebFetch",
  WebSearch: "WebSearch",
  NotebookEdit: "NotebookEdit",
  Skill: "Skill",
  ToolSearch: "ToolSearch",
  AskUserQuestion: "AskUser",
  LSP: "LSP",
  EnterPlanMode: "PlanMode",
  ExitPlanMode: "PlanMode",
};

const READ_LIKE_TOOLS = new Set(["Read", "Grep", "Glob"]);

export function formatToolHeadline(name: string, input: unknown): string {
  const rec = asRecord(input);
  if (!rec) return `${TOOL_SHORT_NAMES[name] ?? name}`;

  if (name === "Bash" && typeof rec.command === "string") {
    const cmd = rec.command.length > 120 ? `${rec.command.slice(0, 117)}...` : rec.command;
    return `Bash(${cmd})`;
  }
  if (name === "Read" && typeof rec.file_path === "string") {
    const fp = rec.file_path.split("/").slice(-2).join("/");
    return `Read(${fp})`;
  }
  if (name === "Grep" && typeof rec.pattern === "string") {
    return `Grep(${rec.pattern})`;
  }
  if (name === "Glob" && typeof rec.pattern === "string") {
    return `Glob(${rec.pattern})`;
  }
  if (name === "Edit" && typeof rec.file_path === "string") {
    const fp = rec.file_path.split("/").slice(-2).join("/");
    return `Edit(${fp})`;
  }
  if (name === "Write" && typeof rec.file_path === "string") {
    const fp = rec.file_path.split("/").slice(-2).join("/");
    return `Write(${fp})`;
  }
  if (name === "Agent" && typeof rec.description === "string") {
    const desc = rec.description.length > 80 ? `${rec.description.slice(0, 77)}...` : rec.description;
    return `Agent(${desc})`;
  }
  if (name === "TodoWrite" && Array.isArray(rec.todos)) {
    const todos = rec.todos as Array<Record<string, unknown>>;
    const ip = todos.filter((t) => t.status === "in_progress").length;
    const done = todos.filter((t) => t.status === "completed").length;
    return `TodoWrite(${todos.length} items, ${done} done, ${ip} active)`;
  }
  if (name === "Skill" && typeof rec.skill === "string") {
    return `Skill(${rec.skill})`;
  }
  if (name === "ToolSearch" && typeof rec.query === "string") {
    return `ToolSearch(${rec.query})`;
  }
  if (name === "WebFetch" && typeof rec.url === "string") {
    const url = rec.url.length > 80 ? `${rec.url.slice(0, 77)}...` : rec.url;
    return `WebFetch(${url})`;
  }
  if (name === "WebSearch" && typeof rec.query === "string") {
    return `WebSearch(${rec.query})`;
  }
  if (name === "NotebookEdit" && typeof rec.notebook_path === "string") {
    const fp = rec.notebook_path.split("/").slice(-2).join("/");
    return `NotebookEdit(${fp})`;
  }
  if (name === "AskUserQuestion" && typeof rec.question === "string") {
    const q = rec.question.length > 80 ? `${rec.question.slice(0, 77)}...` : rec.question;
    return `AskUser(${q})`;
  }
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const toolName = parts[parts.length - 1] ?? name;
    const server = parts.length > 2 ? parts.slice(1, -1).join("/") : "";
    return server ? `${server}/${toolName}` : toolName;
  }

  return TOOL_SHORT_NAMES[name] ?? name;
}

// ---------------------------------------------------------------------------
// Grouping logic: consecutive Read-like tool_call+tool_result pairs
// collapse into "Read N files" / "Searched for N patterns, read N files"
// ---------------------------------------------------------------------------

export type DisplayItem =
  | { type: "entry"; entry: TranscriptEntry }
  | { type: "group"; label: string; count: number; entries: TranscriptEntry[] };

export function groupTranscript(entries: TranscriptEntry[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i]!;
    if (entry.kind === "tool_call" && READ_LIKE_TOOLS.has(entry.name)) {
      const grouped: TranscriptEntry[] = [];
      let readCount = 0;
      let searchCount = 0;
      let j = i;
      while (j < entries.length) {
        const call = entries[j];
        if (!call || call.kind !== "tool_call" || !READ_LIKE_TOOLS.has(call.name)) break;
        const result = entries[j + 1];
        if (result && result.kind === "tool_result") {
          if (call.name === "Read") readCount++;
          else searchCount++;
          grouped.push(call, result);
          j += 2;
        } else {
          break;
        }
      }
      if (grouped.length > 2) {
        const parts: string[] = [];
        if (searchCount > 0) parts.push(`Searched for ${searchCount} pattern${searchCount > 1 ? "s" : ""}`);
        if (readCount > 0) parts.push(`read ${readCount} file${readCount > 1 ? "s" : ""}`);
        items.push({ type: "group", label: parts.join(", "), count: grouped.length / 2, entries: grouped });
        i = j;
        continue;
      }
    }
    items.push({ type: "entry", entry });
    i++;
  }
  return items;
}

// ---------------------------------------------------------------------------
// Collapsible output component (3-line limit)
// ---------------------------------------------------------------------------

export function CollapsibleOutput({ lines, color }: { lines: string[]; color: string }) {
  const [expanded, setExpanded] = useState(false);
  const MAX_LINES = 3;

  if (lines.length === 0) return null;

  const visible = expanded ? lines : lines.slice(0, MAX_LINES);
  const hasMore = lines.length > MAX_LINES;

  return (
    <div className="space-y-0.5 py-1 pl-6 text-[12px] leading-5" style={{ color }}>
      {visible.map((line, index) => (
        <div key={`${line}-${index}`} className="flex items-start gap-1.5">
          <span className="shrink-0 select-none" style={{ color: RAIL_MUTED }}>⎿</span>
          <span className="break-words">{line}</span>
        </div>
      ))}
      {hasMore && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="ml-4 text-[11px] hover:underline cursor-pointer"
          style={{ color: RAIL_MUTED }}
        >
          {expanded ? "collapse" : `… +${lines.length - MAX_LINES} lines`}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transcript rendering components
// ---------------------------------------------------------------------------

export function TranscriptRow({ entry }: { entry: TranscriptEntry }) {
  if (entry.kind === "tool_call") {
    const headline = formatToolHeadline(entry.name, entry.input);

    return (
      <div className="pt-2 pb-0.5">
        <div className="flex items-start gap-2 text-[13px] leading-5">
          <span className="mt-[2px] shrink-0" style={{ color: TONE.tool }}>⏺</span>
          <span className="break-words" style={{ color: TONE.tool }}>{headline}</span>
        </div>
      </div>
    );
  }

  if (entry.kind === "tool_result") {
    const lines = normalizeToolResult(entry.content);
    const color = entry.isError ? TONE.error : TONE.user;
    if (lines.length === 0) {
      return (
        <div className="py-0.5 pl-6 text-[12px] leading-5">
          <div className="flex items-start gap-1.5">
            <span className="shrink-0 select-none" style={{ color: RAIL_MUTED }}>⎿</span>
            <span style={{ color }}>{entry.isError ? "command failed" : "command completed"}</span>
          </div>
        </div>
      );
    }
    return <CollapsibleOutput lines={lines} color={color} />;
  }

  if (entry.kind === "assistant") {
    const lines = entry.text.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (lines.length === 0) return null;
    return (
      <div className="py-2">
        <div className="flex items-start gap-2 text-[13px] leading-5">
          <span className="mt-[2px] shrink-0" style={{ color: TONE.assistant }}>⏺</span>
          <span style={{ color: TONE.assistant }}>{lines[0]}</span>
        </div>
        {lines.length > 1 ? (
          <div className="space-y-0.5 pl-6 text-[12px] leading-5" style={{ color: TONE.assistant }}>
            {lines.slice(1).map((line, index) => (
              <div key={`${line}-${index}`}>{line}</div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  if (entry.kind === "thinking") {
    return (
      <div className="py-1.5">
        <div className="flex items-start gap-2 text-[13px] leading-5">
          <span className="mt-[2px] shrink-0" style={{ color: TONE.thinking }}>⏺</span>
          <span className="italic" style={{ color: TONE.thinking }}>{entry.text.split(/\r?\n/)[0]}</span>
        </div>
      </div>
    );
  }

  if (entry.kind === "stderr") {
    return (
      <div className="py-1">
        <div className="flex items-start gap-2 text-[12px] leading-5">
          <span className="mt-[2px] shrink-0" style={{ color: TONE.error }}>!</span>
          <span style={{ color: TONE.error }}>{entry.text.split(/\r?\n/)[0]}</span>
        </div>
      </div>
    );
  }

  if (entry.kind === "system") {
    return (
      <div className="py-1">
        <div className="flex items-start gap-2 text-[12px] leading-5">
          <span className="mt-[2px] shrink-0" style={{ color: TONE.warn }}>⏺</span>
          <span style={{ color: TONE.warn }}>{entry.text.split(/\r?\n/)[0]}</span>
        </div>
      </div>
    );
  }

  if (entry.kind === "stdout") {
    return (
      <div className="py-1">
        <div className="flex items-start gap-2 text-[12px] leading-5">
          <span className="mt-[2px] shrink-0" style={{ color: TONE.raw }}>⏺</span>
          <span style={{ color: TONE.raw }}>{entry.text.split(/\r?\n/)[0]}</span>
        </div>
      </div>
    );
  }

  if (entry.kind === "user") {
    return (
      <div className="py-1">
        <div className="flex items-start gap-2 text-[12px] leading-5">
          <span className="mt-[2px] shrink-0" style={{ color: TONE.user }}>⏺</span>
          <span style={{ color: TONE.user }}>{entry.text.split(/\r?\n/)[0]}</span>
        </div>
      </div>
    );
  }

  if (entry.kind === "result") {
    const summary =
      `tokens in=${formatTokens(entry.inputTokens)} ` +
      `out=${formatTokens(entry.outputTokens)} ` +
      `cached=${formatTokens(entry.cachedTokens)} ` +
      `cost=$${entry.costUsd.toFixed(6)}`;
    return (
      <div className="space-y-0.5 py-1.5">
        {entry.text.trim() ? (
          <div className="flex items-start gap-2 text-[13px] leading-5">
            <span className="mt-[2px] shrink-0" style={{ color: TONE.result }}>⏺</span>
            <span style={{ color: TONE.result }}>{entry.text.split(/\r?\n/)[0]}</span>
          </div>
        ) : null}
        <div className="pl-6 text-[11px] leading-5" style={{ color: TONE.result }}>{summary}</div>
        {entry.errors.length > 0 ? (
          <div className="pl-6 text-[12px] leading-5" style={{ color: TONE.error }}>
            {entry.errors.map((err, i) => (
              <div key={i}>! {err}</div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return null;
}

export function GroupedRow({ item }: { item: DisplayItem & { type: "group" } }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="py-1.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-start gap-2 text-[13px] leading-5 cursor-pointer hover:underline"
        style={{ color: TONE.raw }}
      >
        <span className="mt-[2px] shrink-0">⏺</span>
        <span>{item.label} {expanded ? "(collapse)" : "(expand)"}</span>
      </button>
      {expanded && (
        <div className="pl-4 border-l border-white/10 ml-2 mt-1">
          {item.entries.map((entry, index) => (
            <TranscriptRow key={`${entry.ts}-${entry.kind}-${index}`} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Footer model extraction
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function extractModelFromCommandArgs(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  const direct = asString(payload.model);
  if (direct) return direct;

  const args = Array.isArray(payload.commandArgs)
    ? payload.commandArgs.filter((value): value is string => typeof value === "string")
    : [];
  const modelIdx = args.findIndex((arg) => arg === "--model");
  if (modelIdx >= 0 && modelIdx + 1 < args.length) return args[modelIdx + 1] ?? null;
  return null;
}

export function extractFooterModel(transcript: TranscriptEntry[], payload: Record<string, unknown> | null, adapterType: string) {
  const initModel = [...transcript]
    .reverse()
    .find((entry): entry is Extract<TranscriptEntry, { kind: "init" }> => entry.kind === "init")
    ?.model;
  if (initModel) return initModel;
  const fromInvoke = extractModelFromCommandArgs(payload);
  if (fromInvoke) return fromInvoke;
  return adapterType;
}

// ---------------------------------------------------------------------------
// Full transcript body — renders a list of DisplayItems
// ---------------------------------------------------------------------------

export function TranscriptBody({ displayItems }: { displayItems: DisplayItem[] }) {
  return (
    <div className="space-y-1">
      {displayItems.map((item, index) =>
        item.type === "group" ? (
          <GroupedRow key={`group-${index}`} item={item} />
        ) : (
          <TranscriptRow key={`${item.entry.ts}-${item.entry.kind}-${index}`} entry={item.entry} />
        ),
      )}
    </div>
  );
}
