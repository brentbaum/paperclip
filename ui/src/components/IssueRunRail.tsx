import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import type { HeartbeatRunEvent } from "@paperclipai/shared";
import { buildTranscript, getUIAdapter } from "../adapters";
import { agentsApi } from "../api/agents";
import { heartbeatsApi, type ActiveRunForIssue, type LiveRunForIssue } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  RAIL_FONT, RAIL_BG, RAIL_PANEL, RAIL_BORDER, RAIL_TEXT, RAIL_MUTED, TONE,
  shouldRenderEntry, groupTranscript, extractFooterModel,
  TranscriptBody,
} from "./RunTranscript";

interface IssueRunRailProps {
  issueId: string;
  companyId?: string | null;
  className?: string;
  /** A historical run to display in the rail (e.g. clicked from a comment). */
  pinnedRun?: RailRun | null;
}

export type RailRun = LiveRunForIssue;
type RunLogChunk = { ts: string; stream: "stdout" | "stderr" | "system"; chunk: string };

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


function isFailedStatus(status: string) {
  return status === "failed" || status === "timed_out";
}

export function IssueRunPane({ run }: { run: RailRun }) {
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
          // For live/queued runs, a missing log is expected (run hasn't started output yet)
          if (isLive) {
            setLogError(null);
          } else {
            setLogError(error instanceof Error ? error.message : "Failed to load run log");
          }
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
    : isLive && visibleTranscript.length === 0 ? "starting…" : "";

  const queryClient = useQueryClient();
  const retryRun = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {};
      if (run.issueId) payload.issueId = run.issueId;
      const result = await agentsApi.wakeup(run.agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "retry_failed_run",
        payload,
      });
      if (!("id" in result)) {
        throw new Error("Retry was skipped because the agent is not currently invokable.");
      }
      return result;
    },
    onSuccess: () => {
      if (run.issueId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(run.issueId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(run.issueId) });
      }
    },
  });

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
        {visibleTranscript.length === 0 && !logError ? (
          <div className="flex items-center gap-2 py-4 text-[12px]" style={{ color: RAIL_MUTED }}>
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
            {isLive ? "Starting run…" : logLoading ? "Loading transcript…" : "Waiting for agent output…"}
          </div>
        ) : null}

        <TranscriptBody displayItems={displayItems} />

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
        {isFailedStatus(run.status) ? (
          <button
            onClick={() => retryRun.mutate()}
            disabled={retryRun.isPending}
            className="flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors hover:bg-white/10 disabled:opacity-50"
            style={{ color: TONE.error }}
          >
            <RotateCcw className="h-3 w-3" />
            {retryRun.isPending ? "Retrying…" : "Retry"}
          </button>
        ) : (
          <span className="truncate text-right">{workingDir}</span>
        )}
      </div>
      {retryRun.isError && (
        <div className="border-t px-3 py-1.5 text-[11px]" style={{ borderColor: RAIL_BORDER, color: TONE.error }}>
          {retryRun.error instanceof Error ? retryRun.error.message : "Failed to retry run"}
        </div>
      )}
    </div>
  );
}

export function IssueRunRail({ issueId, className, pinnedRun }: IssueRunRailProps) {
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
    if (pinnedRun) {
      deduped.set(pinnedRun.id, pinnedRun);
    }
    for (const run of liveRuns ?? []) {
      deduped.set(run.id, run);
    }
    if (activeRun) {
      deduped.set(activeRun.id, toRailRun(issueId, activeRun));
    }
    return [...deduped.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [activeRun, issueId, liveRuns, pinnedRun]);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  // Auto-select pinned run when it changes
  useEffect(() => {
    if (pinnedRun) {
      setSelectedRunId(pinnedRun.id);
    }
  }, [pinnedRun]);

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
