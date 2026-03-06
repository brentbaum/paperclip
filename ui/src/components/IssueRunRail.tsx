import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { HeartbeatRunEvent } from "@paperclipai/shared";
import { buildTranscript, getUIAdapter, type TranscriptEntry } from "../adapters";
import { heartbeatsApi, type ActiveRunForIssue, type LiveRunForIssue } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime, formatTokens, relativeTime } from "../lib/utils";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Identity } from "./Identity";
import { StatusBadge } from "./StatusBadge";
import { ExternalLink, Square, TerminalSquare, Wrench } from "lucide-react";

interface IssueRunRailProps {
  issueId: string;
  companyId?: string | null;
  className?: string;
}

type RailRun = LiveRunForIssue;
type RunLogChunk = { ts: string; stream: "stdout" | "stderr" | "system"; chunk: string };

const RAIL_FONT = 'Monaco, ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", "Courier New", monospace';
const RAIL_TEXT = "#d8dee9";
const RAIL_MUTED = "#94a3b8";
const RAIL_BORDER = "rgba(148, 163, 184, 0.18)";
const RAIL_SURFACE = "#353a42";
const RAIL_SURFACE_ALT = "rgba(28, 33, 41, 0.5)";
const RAIL_PANEL = "rgba(20, 24, 31, 0.44)";
const TONE_COLORS = {
  assistant: "#a3be8c",
  thinking: "#8fbcbb",
  tool: "#88c0d0",
  toolLabel: "#ebcb8b",
  result: "#b48ead",
  error: "#bf616a",
  warn: "#ebcb8b",
  info: "#d8dee9",
  user: "#c0c8d2",
  raw: "#94a3b8",
};

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

function formatCommand(payload: Record<string, unknown>) {
  const command = typeof payload.command === "string" ? payload.command : null;
  const commandArgs = Array.isArray(payload.commandArgs)
    ? payload.commandArgs.filter((value): value is string => typeof value === "string")
    : [];
  if (!command) return null;
  return [command, ...commandArgs].join(" ");
}

function prettyContent(content: string) {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

function isLiveStatus(status: string) {
  return status === "running" || status === "queued";
}

function railToneClass(kind: TranscriptEntry["kind"]) {
  switch (kind) {
    case "assistant":
      return TONE_COLORS.assistant;
    case "thinking":
      return TONE_COLORS.thinking;
    case "tool_call":
      return TONE_COLORS.toolLabel;
    case "tool_result":
      return TONE_COLORS.result;
    case "result":
      return TONE_COLORS.result;
    case "stderr":
      return TONE_COLORS.error;
    case "system":
      return TONE_COLORS.warn;
    case "user":
      return TONE_COLORS.user;
    default:
      return TONE_COLORS.raw;
  }
}

function IssueRunPane({ run, issueId }: { run: RailRun; issueId: string }) {
  const queryClient = useQueryClient();
  const [events, setEvents] = useState<HeartbeatRunEvent[]>([]);
  const [logLines, setLogLines] = useState<RunLogChunk[]>([]);
  const [logOffset, setLogOffset] = useState(0);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
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
          const result = await heartbeatsApi.log(
            run.id,
            offset,
            first ? 512_000 : 256_000,
          );
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
  const transcript = useMemo(
    () => buildTranscript(logLines, adapter.parseStdoutLine),
    [adapter, logLines],
  );

  const adapterInvokePayload = useMemo(() => {
    const invokeEvent = events.find((event) => event.eventType === "adapter.invoke");
    const payload =
      invokeEvent && typeof invokeEvent.payload === "object" && invokeEvent.payload !== null && !Array.isArray(invokeEvent.payload)
        ? (invokeEvent.payload as Record<string, unknown>)
        : null;
    return payload;
  }, [events]);

  useEffect(() => {
    if (!isLive) return;
    const body = transcriptBodyRef.current;
    if (!body) return;
    body.scrollTop = body.scrollHeight;
  }, [isLive, transcript.length]);

  const visibleTranscript = transcript.slice(-160);
  const command = adapterInvokePayload ? formatCommand(adapterInvokePayload) : null;
  const workingDir =
    adapterInvokePayload && typeof adapterInvokePayload.cwd === "string" ? adapterInvokePayload.cwd : null;
  const prompt =
    adapterInvokePayload && typeof adapterInvokePayload.prompt === "string"
      ? adapterInvokePayload.prompt
      : null;

  async function handleCancel() {
    setCancelling(true);
    try {
      await heartbeatsApi.cancel(run.id);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(issueId) });
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div
        className="rounded-xl border px-3 py-3 shadow-[0_18px_40px_rgba(15,23,42,0.28)]"
        style={{
          borderColor: RAIL_BORDER,
          background: `linear-gradient(180deg, rgba(255,255,255,0.04), transparent 42%), ${RAIL_PANEL}`,
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            <div className="flex items-center gap-2">
              <Link to={`/agents/${run.agentId}`} className="min-w-0">
                <Identity name={run.agentName} size="sm" className="text-slate-100" />
              </Link>
              {isLive && (
                <span
                  className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.18em]"
                  style={{ borderColor: "rgba(136, 192, 208, 0.35)", color: TONE_COLORS.tool }}
                >
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-70" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
                  </span>
                  Live
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px]" style={{ color: RAIL_MUTED }}>
              <span>{formatDateTime(run.startedAt ?? run.createdAt)}</span>
              <span>•</span>
              <span>{run.invocationSource.replace(/_/g, " ")}</span>
              {run.triggerDetail ? (
                <>
                  <span>•</span>
                  <span className="truncate">{run.triggerDetail}</span>
                </>
              ) : null}
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <StatusBadge status={run.status} />
            <div className="flex items-center gap-2 text-[11px]">
              {isLive && (
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={cancelling}
                  className="inline-flex items-center gap-1 rounded-md border px-2 py-1 transition-colors disabled:opacity-50"
                  style={{
                    borderColor: "rgba(191, 97, 106, 0.32)",
                    color: TONE_COLORS.error,
                    backgroundColor: "rgba(191, 97, 106, 0.08)",
                  }}
                >
                  <Square className="h-2.5 w-2.5" fill="currentColor" />
                  {cancelling ? "Stopping..." : "Stop"}
                </button>
              )}
              <Link
                to={`/agents/${run.agentId}/runs/${run.id}`}
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 transition-colors hover:brightness-110"
                style={{
                  borderColor: "rgba(136, 192, 208, 0.24)",
                  color: TONE_COLORS.tool,
                  backgroundColor: "rgba(136, 192, 208, 0.08)",
                }}
              >
                Open
                <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
          </div>
        </div>
      </div>

      <div
        className="rounded-xl border px-3 py-3"
        style={{
          borderColor: RAIL_BORDER,
          backgroundColor: RAIL_PANEL,
        }}
      >
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.16em]" style={{ color: RAIL_MUTED }}>
            <TerminalSquare className="h-3.5 w-3.5" />
            Transcript
          </div>
          <span className="text-[11px]" style={{ color: RAIL_MUTED }}>
            {visibleTranscript.length} rows
          </span>
        </div>

        {adapterInvokePayload && (command || workingDir || prompt) ? (
          <div
            className="mb-3 rounded-lg border p-2.5 text-[11px]"
            style={{ borderColor: RAIL_BORDER, backgroundColor: RAIL_SURFACE_ALT }}
          >
            <div className="mb-2 flex items-center gap-2 uppercase tracking-[0.16em]" style={{ color: RAIL_MUTED }}>
              <Wrench className="h-3.5 w-3.5" />
              Invocation
            </div>
            {command ? (
              <div className="mb-2">
                <div className="mb-1 text-[10px] uppercase tracking-[0.16em]" style={{ color: RAIL_MUTED }}>
                  Command
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[11px]" style={{ color: TONE_COLORS.assistant }}>
                  {command}
                </pre>
              </div>
            ) : null}
            {workingDir ? (
              <div className="mb-2">
                <div className="mb-1 text-[10px] uppercase tracking-[0.16em]" style={{ color: RAIL_MUTED }}>
                  Working Dir
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[11px]" style={{ color: RAIL_TEXT }}>
                  {workingDir}
                </pre>
              </div>
            ) : null}
            {prompt ? (
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-[0.16em]" style={{ color: RAIL_MUTED }}>
                  Prompt
                </div>
                <pre
                  className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md border p-2 text-[11px]"
                  style={{
                    borderColor: RAIL_BORDER,
                    backgroundColor: "rgba(10, 14, 18, 0.32)",
                    color: RAIL_TEXT,
                  }}
                >
                  {prompt}
                </pre>
              </div>
            ) : null}
          </div>
        ) : null}

        <div
          ref={transcriptBodyRef}
          className="max-h-[62dvh] overflow-y-auto rounded-lg border p-2.5"
          style={{
            borderColor: RAIL_BORDER,
            background: `linear-gradient(180deg, rgba(255,255,255,0.03), transparent 30%), ${RAIL_SURFACE}`,
            color: RAIL_TEXT,
            scrollbarColor: `${TONE_COLORS.tool} transparent`,
          }}
        >
          {logLoading && visibleTranscript.length === 0 ? (
            <div className="text-[11px]" style={{ color: RAIL_MUTED }}>
              Loading run transcript...
            </div>
          ) : null}

          {!logLoading && visibleTranscript.length === 0 && !logError ? (
            <div className="text-[11px]" style={{ color: RAIL_MUTED }}>
              Waiting for transcript output...
            </div>
          ) : null}

          <div className="space-y-2">
            {visibleTranscript.map((entry, index) => (
              <TranscriptRow key={`${entry.ts}-${entry.kind}-${index}`} entry={entry} />
            ))}
          </div>

          {logError ? (
            <div className="mt-3 text-[11px]" style={{ color: TONE_COLORS.error }}>
              {logError}
            </div>
          ) : null}
        </div>
      </div>

      <div
        className="rounded-xl border px-3 py-3"
        style={{
          borderColor: RAIL_BORDER,
          backgroundColor: RAIL_PANEL,
        }}
      >
        <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-[0.16em]" style={{ color: RAIL_MUTED }}>
          <span>Run Stats</span>
          <span>{relativeTime(run.startedAt ?? run.createdAt)}</span>
        </div>
        <RunResultSummary events={events} />
      </div>
    </div>
  );
}

function TranscriptRow({ entry }: { entry: TranscriptEntry }) {
  const time = new Date(entry.ts).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const label =
    entry.kind === "tool_call"
      ? "tool call"
      : entry.kind === "tool_result"
        ? "tool result"
        : entry.kind.replace(/_/g, " ");

  if (entry.kind === "tool_call") {
    return (
      <div className="rounded-md border p-2" style={{ borderColor: RAIL_BORDER, backgroundColor: "rgba(235, 203, 139, 0.06)" }}>
        <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.16em]" style={{ color: railToneClass(entry.kind) }}>
          <span>{time}</span>
          <span>{label}</span>
          <span className="truncate" style={{ color: RAIL_TEXT }}>{entry.name}</span>
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px]" style={{ color: RAIL_TEXT }}>
          {JSON.stringify(entry.input, null, 2)}
        </pre>
      </div>
    );
  }

  if (entry.kind === "tool_result") {
    return (
      <div className="rounded-md border p-2" style={{ borderColor: RAIL_BORDER, backgroundColor: "rgba(180, 142, 173, 0.08)" }}>
        <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.16em]" style={{ color: railToneClass(entry.kind) }}>
          <span>{time}</span>
          <span>{label}</span>
          {entry.isError ? <span style={{ color: TONE_COLORS.error }}>error</span> : null}
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px]" style={{ color: entry.isError ? TONE_COLORS.error : RAIL_TEXT }}>
          {prettyContent(entry.content)}
        </pre>
      </div>
    );
  }

  if (entry.kind === "result") {
    return (
      <div className="rounded-md border p-2" style={{ borderColor: RAIL_BORDER, backgroundColor: "rgba(180, 142, 173, 0.08)" }}>
        <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.16em]" style={{ color: railToneClass(entry.kind) }}>
          <span>{time}</span>
          <span>{label}</span>
        </div>
        <div className="text-[11px]" style={{ color: RAIL_TEXT }}>
          tokens in={formatTokens(entry.inputTokens)} out={formatTokens(entry.outputTokens)} cached={formatTokens(entry.cachedTokens)} cost=${entry.costUsd.toFixed(6)}
        </div>
        {entry.text ? (
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-[11px]" style={{ color: RAIL_TEXT }}>
            {entry.text}
          </pre>
        ) : null}
      </div>
    );
  }

  if (entry.kind === "assistant" || entry.kind === "thinking" || entry.kind === "user") {
    return (
      <div
        className="rounded-md border px-2.5 py-2"
        style={{
          borderColor: RAIL_BORDER,
          backgroundColor:
            entry.kind === "assistant"
              ? "rgba(163, 190, 140, 0.08)"
              : entry.kind === "thinking"
                ? "rgba(143, 188, 187, 0.08)"
                : "rgba(255, 255, 255, 0.03)",
        }}
      >
        <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.16em]" style={{ color: railToneClass(entry.kind) }}>
          <span>{time}</span>
          <span>{label}</span>
        </div>
        <div className="whitespace-pre-wrap break-words text-[11px]" style={{ color: railToneClass(entry.kind) }}>
          {entry.text}
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[68px_minmax(0,1fr)] gap-2 text-[11px]">
      <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: railToneClass(entry.kind) }}>
        <div>{time}</div>
        <div>{label}</div>
      </div>
      <div className="whitespace-pre-wrap break-words" style={{ color: railToneClass(entry.kind) }}>
        {"text" in entry ? entry.text : ""}
      </div>
    </div>
  );
}

function RunResultSummary({ events }: { events: HeartbeatRunEvent[] }) {
  const adapterResult = useMemo(() => {
    const resultEvent = [...events].reverse().find((event) => event.eventType === "adapter.result");
    const payload =
      resultEvent && typeof resultEvent.payload === "object" && resultEvent.payload !== null && !Array.isArray(resultEvent.payload)
        ? (resultEvent.payload as Record<string, unknown>)
        : null;
    return payload;
  }, [events]);

  const rows = [
    {
      label: "Exit",
      value:
        adapterResult && typeof adapterResult.exitCode === "number"
          ? String(adapterResult.exitCode)
          : "pending",
    },
    {
      label: "Duration",
      value:
        adapterResult && typeof adapterResult.durationMs === "number"
          ? `${Math.round(adapterResult.durationMs / 1000)}s`
          : "streaming",
    },
    {
      label: "Status",
      value:
        adapterResult && typeof adapterResult.status === "string"
          ? adapterResult.status
          : "live",
    },
  ];

  return (
    <div className="grid grid-cols-3 gap-2">
      {rows.map((row) => (
        <div
          key={row.label}
          className="rounded-lg border px-2.5 py-2"
          style={{ borderColor: RAIL_BORDER, backgroundColor: RAIL_SURFACE_ALT }}
        >
          <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: RAIL_MUTED }}>
            {row.label}
          </div>
          <div className="mt-1 text-[11px]" style={{ color: RAIL_TEXT }}>
            {row.value}
          </div>
        </div>
      ))}
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
      className={cn("min-w-0 overflow-hidden rounded-2xl border shadow-[0_22px_60px_rgba(15,23,42,0.22)]", className)}
      style={{
        fontFamily: RAIL_FONT,
        color: RAIL_TEXT,
        borderColor: "rgba(136, 192, 208, 0.18)",
        background: `radial-gradient(circle at top right, rgba(136, 192, 208, 0.14), transparent 22%), linear-gradient(180deg, rgba(255,255,255,0.06), transparent 18%), ${RAIL_SURFACE}`,
      }}
    >
      <div className="border-b px-4 py-3" style={{ borderColor: RAIL_BORDER }}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.2em]" style={{ color: RAIL_MUTED }}>
              Current Run{runs.length > 1 ? "s" : ""}
            </div>
            <div className="mt-1 text-sm" style={{ color: "#f8fafc" }}>
              Issue execution stream
            </div>
          </div>
          <div className="text-right text-[11px]" style={{ color: RAIL_MUTED }}>
            {runs.length} active
          </div>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setSelectedRunId} className="gap-0">
        {runs.length > 1 ? (
          <div className="border-b px-3 pt-2" style={{ borderColor: RAIL_BORDER }}>
            <TabsList
              variant="line"
              className="h-auto w-full justify-start gap-1 overflow-x-auto bg-transparent pb-1"
            >
              {runs.map((run) => (
                <TabsTrigger
                  key={run.id}
                  value={run.id}
                  className="h-auto shrink-0 rounded-md border border-transparent px-2.5 py-2 data-[state=active]:border-transparent data-[state=active]:bg-transparent"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={cn("h-2 w-2 rounded-full", isLiveStatus(run.status) ? "animate-pulse" : "")}
                      style={{
                        backgroundColor:
                          run.status === "failed" || run.status === "timed_out"
                            ? TONE_COLORS.error
                            : isLiveStatus(run.status)
                              ? TONE_COLORS.tool
                              : TONE_COLORS.assistant,
                      }}
                    />
                    <span className="truncate text-[11px]">{run.agentName}</span>
                    <span className="text-[10px]" style={{ color: RAIL_MUTED }}>
                      {run.id.slice(0, 6)}
                    </span>
                  </div>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        ) : null}

        {runs.map((run) => (
          <TabsContent key={run.id} value={run.id} className="min-h-0">
            <div className="flex min-h-0 flex-col p-3">
              <IssueRunPane run={run} issueId={issueId} />
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </aside>
  );
}
