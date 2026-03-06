import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { HeartbeatRunEvent } from "@paperclipai/shared";
import { buildTranscript, getUIAdapter, type TranscriptEntry } from "../adapters";
import { heartbeatsApi, type ActiveRunForIssue, type LiveRunForIssue } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatTokens } from "../lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface IssueRunRailProps {
  issueId: string;
  companyId?: string | null;
  className?: string;
}

type RailRun = LiveRunForIssue;
type RunLogChunk = { ts: string; stream: "stdout" | "stderr" | "system"; chunk: string };

const RAIL_FONT = 'Monaco, ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", "Courier New", monospace';
const RAIL_BG = "#11130f";
const RAIL_PANEL = "#0e100d";
const RAIL_BORDER = "rgba(156, 163, 175, 0.23)";
const RAIL_DIVIDER = "rgba(156, 163, 175, 0.13)";
const RAIL_TEXT = "#e5e7eb";
const RAIL_MUTED = "#94a3b8";
const TONE = {
  tool: "#86efac",
  assistant: "#e5e7eb",
  thinking: "#93c5fd",
  user: "#cbd5e1",
  result: "#22d3ee",
  warn: "#fbbf24",
  error: "#f87171",
  raw: "#9ca3af",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function toIsoString(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.toISOString();
}

function toRailRun(issueId: string, run: ActiveRunForIssue): RailRun {
  return {
    id: run.id,
    status: run.status,
    invocationSource: run.invocationSource,
    triggerDetail: run.triggerDetail,
    startedAt: toIsoString(run.startedAt),
    finishedAt: toIsoString(run.finishedAt),
    createdAt: toIsoString(run.createdAt) ?? new Date().toISOString(),
    agentId: run.agentId,
    agentName: run.agentName,
    adapterType: run.adapterType,
    issueId,
  };
}

function parseLogRows(
  content: string,
  pendingLogLineRef: React.MutableRefObject<string>,
  finalize = false,
): RunLogChunk[] {
  if (!content && !finalize) return [];
  const combined = `${pendingLogLineRef.current}${content}`;
  const split = combined.split("\n");
  pendingLogLineRef.current = split.pop() ?? "";
  if (finalize && pendingLogLineRef.current) {
    split.push(pendingLogLineRef.current);
    pendingLogLineRef.current = "";
  }

  const parsed: RunLogChunk[] = [];
  for (const line of split) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed) as { ts?: unknown; stream?: unknown; chunk?: unknown };
      const stream = raw.stream === "stderr" || raw.stream === "system" ? raw.stream : "stdout";
      const chunk = typeof raw.chunk === "string" ? raw.chunk : "";
      const ts = typeof raw.ts === "string" ? raw.ts : new Date().toISOString();
      if (!chunk) continue;
      parsed.push({ ts, stream, chunk });
    } catch {
      // Ignore malformed rows while logs are still streaming.
    }
  }

  return parsed;
}

function isLiveStatus(status: string) {
  return status === "running" || status === "queued";
}

function isNoiseSystemLine(text: string) {
  return (
    text === "turn started" ||
    text.startsWith("item started:") ||
    text.startsWith("item completed:") ||
    text.startsWith("[paperclip] Loaded agent instructions file:")
  );
}

function shouldRenderEntry(entry: TranscriptEntry) {
  if (entry.kind === "init") return false;
  if (entry.kind === "system") return !isNoiseSystemLine(entry.text.trim());
  return true;
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

function extractFooterModel(transcript: TranscriptEntry[], payload: Record<string, unknown> | null, adapterType: string) {
  const initModel = [...transcript]
    .reverse()
    .find((entry): entry is Extract<TranscriptEntry, { kind: "init" }> => entry.kind === "init")
    ?.model;
  if (initModel) return initModel;
  const fromInvoke = extractModelFromCommandArgs(payload);
  if (fromInvoke) return fromInvoke;
  return adapterType;
}

function stringifyUnknown(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeToolResult(content: string): string[] {
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
};

const READ_LIKE_TOOLS = new Set(["Read", "Grep", "Glob"]);

function formatToolHeadline(name: string, input: unknown): string {
  const rec = asRecord(input);
  if (!rec) return `${TOOL_SHORT_NAMES[name] ?? name}`;

  // Bash: show command inline
  if (name === "Bash" && typeof rec.command === "string") {
    const cmd = rec.command.length > 120 ? `${rec.command.slice(0, 117)}...` : rec.command;
    return `Bash(${cmd})`;
  }
  // Read: show file path
  if (name === "Read" && typeof rec.file_path === "string") {
    const fp = rec.file_path.split("/").slice(-2).join("/");
    return `Read(${fp})`;
  }
  // Grep: show pattern
  if (name === "Grep" && typeof rec.pattern === "string") {
    return `Grep(${rec.pattern})`;
  }
  // Glob: show pattern
  if (name === "Glob" && typeof rec.pattern === "string") {
    return `Glob(${rec.pattern})`;
  }
  // Edit: show file
  if (name === "Edit" && typeof rec.file_path === "string") {
    const fp = rec.file_path.split("/").slice(-2).join("/");
    return `Edit(${fp})`;
  }
  // Write: show file
  if (name === "Write" && typeof rec.file_path === "string") {
    const fp = rec.file_path.split("/").slice(-2).join("/");
    return `Write(${fp})`;
  }
  // Agent: show description
  if (name === "Agent" && typeof rec.description === "string") {
    return `Agent(${rec.description})`;
  }

  return TOOL_SHORT_NAMES[name] ?? name;
}

// ---------------------------------------------------------------------------
// Grouping logic: consecutive Read-like tool_call+tool_result pairs
// collapse into "Read N files" / "Searched for N patterns, read N files"
// ---------------------------------------------------------------------------

type DisplayItem =
  | { type: "entry"; entry: TranscriptEntry }
  | { type: "group"; label: string; count: number; entries: TranscriptEntry[] };

function groupTranscript(entries: TranscriptEntry[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i]!;
    // Detect consecutive read-like tool_call/tool_result pairs
    if (entry.kind === "tool_call" && READ_LIKE_TOOLS.has(entry.name)) {
      const grouped: TranscriptEntry[] = [];
      let readCount = 0;
      let searchCount = 0;
      let j = i;
      while (j < entries.length) {
        const call = entries[j];
        if (!call || call.kind !== "tool_call" || !READ_LIKE_TOOLS.has(call.name)) break;
        // Check if next entry is the matching result
        const result = entries[j + 1];
        if (result && result.kind === "tool_result") {
          if (call.name === "Read") readCount++;
          else searchCount++;
          grouped.push(call, result);
          j += 2;
        } else {
          // tool_call without immediate result - don't group
          break;
        }
      }
      if (grouped.length > 2) {
        // Multiple pairs - collapse
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

function CollapsibleOutput({ lines, color }: { lines: string[]; color: string }) {
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

function TranscriptRow({ entry }: { entry: TranscriptEntry }) {
  if (entry.kind === "tool_call") {
    const headline = formatToolHeadline(entry.name, entry.input);

    return (
      <div className="py-1.5">
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
      <div className="py-1.5">
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

function GroupedRow({ item }: { item: DisplayItem & { type: "group" } }) {
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

function IssueRunPane({ run }: { run: RailRun }) {
  const [events, setEvents] = useState<HeartbeatRunEvent[]>([]);
  const [logLines, setLogLines] = useState<RunLogChunk[]>([]);
  const [logOffset, setLogOffset] = useState(0);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const pendingLogLineRef = useRef("");
  const transcriptBodyRef = useRef<HTMLDivElement | null>(null);
  const isLive = isLiveStatus(run.status);

  const { data: initialEvents } = useQuery({
    queryKey: ["issue-run-events", run.id],
    queryFn: () => heartbeatsApi.events(run.id, 0, 200),
  });

  useEffect(() => {
    setEvents(initialEvents ?? []);
  }, [initialEvents]);

  useEffect(() => {
    let cancelled = false;
    pendingLogLineRef.current = "";
    setLogLines([]);
    setLogOffset(0);
    setLogError(null);
    setLogLoading(true);

    const load = async () => {
      try {
        let offset = 0;
        let first = true;
        while (!cancelled) {
          const result = await heartbeatsApi.log(run.id, offset, first ? 512_000 : 256_000);
          if (cancelled) return;
          const rows = parseLogRows(result.content, pendingLogLineRef, result.nextOffset === undefined);
          if (rows.length > 0) {
            setLogLines((prev) => [...prev, ...rows]);
          }
          const next = result.nextOffset ?? offset + result.content.length;
          setLogOffset(next);
          offset = next;
          first = false;
          if (result.nextOffset === undefined || isLive) break;
        }
      } catch (error) {
        if (!cancelled) {
          setLogError(error instanceof Error ? error.message : "Failed to load run log");
        }
      } finally {
        if (!cancelled) setLogLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [isLive, run.id]);

  useEffect(() => {
    if (!isLive) return;
    const interval = window.setInterval(async () => {
      const maxSeq = events.length > 0 ? Math.max(...events.map((event) => event.seq)) : 0;
      try {
        const nextEvents = await heartbeatsApi.events(run.id, maxSeq, 100);
        if (nextEvents.length > 0) {
          setEvents((prev) => [...prev, ...nextEvents]);
        }
      } catch {
        // Ignore transient polling failures for live runs.
      }
    }, 2000);
    return () => window.clearInterval(interval);
  }, [events, isLive, run.id]);

  useEffect(() => {
    if (!isLive) return;
    const interval = window.setInterval(async () => {
      try {
        const result = await heartbeatsApi.log(run.id, logOffset, 256_000);
        const rows = parseLogRows(result.content, pendingLogLineRef, result.nextOffset === undefined);
        if (rows.length > 0) {
          setLogLines((prev) => [...prev, ...rows]);
        }
        if (result.nextOffset !== undefined) {
          setLogOffset(result.nextOffset);
        } else if (result.content.length > 0) {
          setLogOffset((prev) => prev + result.content.length);
        }
      } catch {
        // Ignore transient polling failures for live runs.
      }
    }, 2000);
    return () => window.clearInterval(interval);
  }, [isLive, logOffset, run.id]);

  const adapter = useMemo(() => getUIAdapter(run.adapterType), [run.adapterType]);
  const transcript = useMemo(() => buildTranscript(logLines, adapter.parseStdoutLine), [adapter, logLines]);

  const visibleTranscript = useMemo(
    () => transcript.filter((entry) => shouldRenderEntry(entry)).slice(-220),
    [transcript],
  );

  const displayItems = useMemo(() => groupTranscript(visibleTranscript), [visibleTranscript]);

  const adapterInvokePayload = useMemo(() => {
    const invokeEvent = [...events].reverse().find((event) => event.eventType === "adapter.invoke");
    const payload =
      invokeEvent &&
      typeof invokeEvent.payload === "object" &&
      invokeEvent.payload !== null &&
      !Array.isArray(invokeEvent.payload)
        ? (invokeEvent.payload as Record<string, unknown>)
        : null;
    return payload;
  }, [events]);

  const modelName = useMemo(
    () => extractFooterModel(transcript, adapterInvokePayload, run.adapterType),
    [adapterInvokePayload, run.adapterType, transcript],
  );
  const workingDir = adapterInvokePayload && typeof adapterInvokePayload.cwd === "string"
    ? adapterInvokePayload.cwd
    : "cwd unavailable";

  // Auto-scroll to bottom on new content (always, not just when live)
  const userScrolledUpRef = useRef(false);

  useEffect(() => {
    const body = transcriptBodyRef.current;
    if (!body) return;
    const handleScroll = () => {
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      userScrolledUpRef.current = !atBottom;
    };
    body.addEventListener("scroll", handleScroll, { passive: true });
    return () => body.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    if (userScrolledUpRef.current) return;
    const body = transcriptBodyRef.current;
    if (!body) return;
    body.scrollTop = body.scrollHeight;
  }, [displayItems.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border" style={{ borderColor: RAIL_BORDER }}>
      <div
        ref={transcriptBodyRef}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-1"
        style={{
          background: `linear-gradient(180deg, rgba(255,255,255,0.02), transparent 34%), ${RAIL_PANEL}`,
          color: RAIL_TEXT,
          scrollbarColor: `${TONE.warn} transparent`,
        }}
      >
        {logLoading && visibleTranscript.length === 0 ? (
          <div className="py-2 text-[12px]" style={{ color: RAIL_MUTED }}>
            Streaming transcript...
          </div>
        ) : null}

        {!logLoading && visibleTranscript.length === 0 && !logError ? (
          <div className="py-2 text-[12px]" style={{ color: RAIL_MUTED }}>
            Waiting for agent output...
          </div>
        ) : null}

        <div className="divide-y" style={{ borderColor: RAIL_DIVIDER }}>
          {displayItems.map((item, index) =>
            item.type === "group" ? (
              <GroupedRow key={`group-${index}`} item={item} />
            ) : (
              <TranscriptRow key={`${item.entry.ts}-${item.entry.kind}-${index}`} entry={item.entry} />
            ),
          )}
        </div>

        {logError ? (
          <div className="py-2 text-[12px]" style={{ color: TONE.error }}>
            {logError}
          </div>
        ) : null}
      </div>

      <div
        className="flex items-center justify-between gap-4 border-t px-3 py-2 text-[11px]"
        style={{ borderColor: RAIL_BORDER, backgroundColor: RAIL_BG, color: RAIL_MUTED }}
      >
        <span className="shrink-0 truncate">model {modelName}</span>
        <span className="truncate text-right">{workingDir}</span>
      </div>
    </div>
  );
}

export function IssueRunRail({ issueId, className }: IssueRunRailProps) {
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(issueId),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId),
    enabled: !!issueId,
    refetchInterval: 3000,
  });

  const { data: activeRun } = useQuery({
    queryKey: queryKeys.issues.activeRun(issueId),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId),
    enabled: !!issueId,
    refetchInterval: 3000,
  });

  const runs = useMemo(() => {
    const deduped = new Map<string, RailRun>();
    for (const run of liveRuns ?? []) {
      deduped.set(run.id, run);
    }
    if (activeRun) {
      deduped.set(activeRun.id, toRailRun(issueId, activeRun));
    }
    return [...deduped.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [activeRun, issueId, liveRuns]);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  useEffect(() => {
    if (runs.length === 0) {
      setSelectedRunId(null);
      return;
    }
    if (!selectedRunId || !runs.some((run) => run.id === selectedRunId)) {
      setSelectedRunId(runs[0]!.id);
    }
  }, [runs, selectedRunId]);

  const activeTab = selectedRunId ?? runs[0]?.id ?? "";

  if (runs.length === 0) return null;

  return (
    <aside
      className={cn("min-w-0 overflow-hidden rounded-2xl border shadow-[0_22px_60px_rgba(0,0,0,0.35)] flex flex-col", className)}
      style={{
        fontFamily: RAIL_FONT,
        color: RAIL_TEXT,
        borderColor: RAIL_BORDER,
        background: RAIL_BG,
        maxHeight: "calc(100vh - 3rem)",
      }}
    >
      <Tabs value={activeTab} onValueChange={setSelectedRunId} className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden">
        {runs.length > 1 ? (
          <div className="border-b px-2 py-2" style={{ borderColor: RAIL_BORDER }}>
            <TabsList
              variant="line"
              className="h-auto w-full justify-start gap-1 overflow-x-auto bg-transparent p-0"
            >
              {runs.map((run) => (
                <TabsTrigger
                  key={run.id}
                  value={run.id}
                  className="h-auto shrink-0 rounded-md border border-transparent px-2 py-1.5 text-[11px] data-[state=active]:border-transparent data-[state=active]:bg-white/5"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={cn("h-2 w-2 rounded-full", isLiveStatus(run.status) ? "animate-pulse" : "")}
                      style={{
                        backgroundColor:
                          run.status === "failed" || run.status === "timed_out"
                            ? TONE.error
                            : isLiveStatus(run.status)
                              ? TONE.tool
                              : TONE.result,
                      }}
                    />
                    <span className="truncate">{run.agentName}</span>
                    <span style={{ color: RAIL_MUTED }}>{run.id.slice(0, 6)}</span>
                  </div>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        ) : null}

        {runs.map((run) => (
          <TabsContent key={run.id} value={run.id} className="mt-0 min-h-0 flex-1 flex flex-col overflow-hidden">
            <div className="flex min-h-0 flex-1 flex-col p-2.5 overflow-hidden">
              <IssueRunPane run={run} />
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </aside>
  );
}
