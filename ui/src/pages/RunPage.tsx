import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { HeartbeatRunEvent } from "@paperclipai/shared";
import { buildTranscript, getUIAdapter } from "../adapters";
import { heartbeatsApi } from "../api/heartbeats";
import { agentsApi } from "../api/agents";
import { activityApi } from "../api/activity";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { Identity } from "../components/Identity";
import { PageSkeleton } from "../components/PageSkeleton";
import {
  RAIL_FONT, RAIL_BG, RAIL_PANEL, RAIL_BORDER, RAIL_TEXT, RAIL_MUTED, TONE,
  shouldRenderEntry, groupTranscript, extractFooterModel,
  TranscriptBody,
} from "../components/RunTranscript";

type RunLogChunk = { ts: string; stream: "stdout" | "stderr" | "system"; chunk: string };

function parseLogRows(
  content: string,
  pendingRef: React.MutableRefObject<string>,
  finalize = false,
): RunLogChunk[] {
  if (!content && !finalize) return [];
  const combined = `${pendingRef.current}${content}`;
  const split = combined.split("\n");
  pendingRef.current = split.pop() ?? "";
  if (finalize && pendingRef.current) {
    split.push(pendingRef.current);
    pendingRef.current = "";
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
      // ignore malformed
    }
  }
  return parsed;
}

export default function RunPage() {
  const { companyPrefix, runId } = useParams<{ companyPrefix: string; runId: string }>();
  const { selectedCompanyId } = useCompany();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, { name: string; adapterType: string; urlKey: string }>();
    for (const a of agents ?? []) map.set(a.id, { name: a.name, adapterType: a.adapterType, urlKey: a.urlKey ?? a.id });
    return map;
  }, [agents]);

  const { data: touchedIssues } = useQuery({
    queryKey: queryKeys.runIssues(runId!),
    queryFn: () => activityApi.issuesForRun(runId!),
    enabled: !!runId,
  });

  // Fetch events to get adapter invoke payload
  const [events, setEvents] = useState<HeartbeatRunEvent[]>([]);
  const [logLines, setLogLines] = useState<RunLogChunk[]>([]);
  const [logOffset, setLogOffset] = useState(0);
  const [logLoading, setLogLoading] = useState(true);
  const [logError, setLogError] = useState<string | null>(null);
  const pendingLogLineRef = useRef("");
  const transcriptBodyRef = useRef<HTMLDivElement | null>(null);

  const { data: initialEvents } = useQuery({
    queryKey: ["run-page-events", runId],
    queryFn: () => heartbeatsApi.events(runId!, 0, 200),
    enabled: !!runId,
  });

  useEffect(() => {
    setEvents(initialEvents ?? []);
  }, [initialEvents]);

  // Derive run metadata from events
  const adapterInvokePayload = useMemo(() => {
    const evt = events.find((e) => e.eventType === "adapter.invoke");
    if (!evt?.payload || typeof evt.payload !== "object" || Array.isArray(evt.payload)) return null;
    return evt.payload as Record<string, unknown>;
  }, [events]);

  const runMeta = useMemo(() => {
    const evt = events.find((e) => e.eventType === "adapter.invoke");
    const agentId = evt?.agentId ?? (events[0]?.agentId ?? "");
    const agent = agentMap.get(agentId);
    return {
      agentId,
      agentName: agent?.name ?? agentId.slice(0, 8),
      adapterType: agent?.adapterType ?? "claude_local",
      agentUrlKey: agent?.urlKey ?? agentId,
    };
  }, [events, agentMap]);

  const statusEvent = useMemo(() => {
    const sorted = [...events].sort((a, b) => b.seq - a.seq);
    return sorted.find((e) => e.eventType === "run.completed" || e.eventType === "run.failed" || e.eventType === "run.started");
  }, [events]);

  const runStatus = useMemo(() => {
    if (!statusEvent) return events.length > 0 ? "running" : "queued";
    if (statusEvent.eventType === "run.completed") return "completed";
    if (statusEvent.eventType === "run.failed") return "failed";
    return "running";
  }, [statusEvent, events]);

  const isLive = runStatus === "running" || runStatus === "queued";

  // Load log
  useEffect(() => {
    if (!runId) return;
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
          const result = await heartbeatsApi.log(runId, offset, first ? 512_000 : 256_000);
          if (cancelled) return;
          const rows = parseLogRows(result.content, pendingLogLineRef, result.nextOffset === undefined);
          if (rows.length > 0) setLogLines((prev) => [...prev, ...rows]);
          const next = result.nextOffset ?? offset + result.content.length;
          setLogOffset(next);
          offset = next;
          first = false;
          if (result.nextOffset === undefined || isLive) break;
        }
      } catch {
        if (!cancelled && !isLive) {
          setLogError("Run log not yet available");
        }
      } finally {
        if (!cancelled) setLogLoading(false);
      }
    };

    void load();
    return () => { cancelled = true; };
  }, [runId, isLive]);

  // Poll events for live runs
  useEffect(() => {
    if (!isLive || !runId) return;
    const interval = setInterval(async () => {
      const maxSeq = events.length > 0 ? Math.max(...events.map((e) => e.seq)) : 0;
      try {
        const next = await heartbeatsApi.events(runId, maxSeq, 100);
        if (next.length > 0) setEvents((prev) => [...prev, ...next]);
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(interval);
  }, [runId, isLive, events]);

  // Poll log for live runs
  useEffect(() => {
    if (!isLive || !runId) return;
    const interval = setInterval(async () => {
      try {
        const result = await heartbeatsApi.log(runId, logOffset, 256_000);
        const rows = parseLogRows(result.content, pendingLogLineRef, result.nextOffset === undefined);
        if (rows.length > 0) setLogLines((prev) => [...prev, ...rows]);
        if (result.nextOffset !== undefined) {
          setLogOffset(result.nextOffset);
        } else if (result.content.length > 0) {
          setLogOffset((prev) => prev + result.content.length);
        }
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(interval);
  }, [runId, isLive, logOffset]);

  const adapter = useMemo(() => getUIAdapter(runMeta.adapterType), [runMeta.adapterType]);
  const transcript = useMemo(() => buildTranscript(logLines, adapter.parseStdoutLine), [logLines, adapter]);
  const visibleTranscript = useMemo(
    () => transcript.filter((entry) => shouldRenderEntry(entry)),
    [transcript],
  );
  const displayItems = useMemo(() => groupTranscript(visibleTranscript), [visibleTranscript]);

  const modelName = useMemo(
    () => extractFooterModel(transcript, adapterInvokePayload, runMeta.adapterType),
    [adapterInvokePayload, runMeta.adapterType, transcript],
  );
  const workingDir = adapterInvokePayload && typeof adapterInvokePayload.cwd === "string"
    ? adapterInvokePayload.cwd
    : isLive && visibleTranscript.length === 0 ? "starting..." : "";

  // Auto-scroll
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

  // Breadcrumbs
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([
      { label: runMeta.agentName, href: `/${companyPrefix}/agents/${runMeta.agentUrlKey}` },
      { label: `Run ${runId?.slice(0, 8) ?? ""}` },
    ]);
  }, [setBreadcrumbs, runMeta.agentName, runMeta.agentUrlKey, companyPrefix, runId]);

  if (!runId) return <PageSkeleton />;

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)]" style={{ fontFamily: RAIL_FONT }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: RAIL_BORDER, backgroundColor: RAIL_BG }}>
        <Link
          to={`/${companyPrefix}/agents/${runMeta.agentUrlKey}`}
          className="hover:underline no-underline text-inherit"
        >
          <Identity name={runMeta.agentName} size="sm" />
        </Link>
        <span className="text-xs font-mono" style={{ color: RAIL_MUTED }}>{runId.slice(0, 8)}</span>
        <StatusBadge status={runStatus} />
        {isLive && (
          <span className="flex items-center gap-1 text-xs" style={{ color: TONE.result }}>
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: TONE.result }} />
              <span className="relative inline-flex rounded-full h-2 w-2" style={{ backgroundColor: TONE.result }} />
            </span>
            Live
          </span>
        )}
        {touchedIssues && touchedIssues.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            {touchedIssues.map((issue) => (
              <Link
                key={issue.issueId}
                to={`/${companyPrefix}/issues/${issue.identifier ?? issue.issueId}`}
                className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-mono hover:bg-accent/20 transition-colors no-underline text-inherit"
                style={{ borderColor: RAIL_BORDER }}
              >
                <StatusBadge status={issue.status} />
                {issue.identifier ?? issue.issueId.slice(0, 8)}
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Transcript body */}
      <div
        ref={transcriptBodyRef}
        className="flex-1 min-h-0 overflow-y-auto px-4 py-2"
        style={{
          background: `linear-gradient(180deg, rgba(255,255,255,0.02), transparent 34%), ${RAIL_PANEL}`,
          color: RAIL_TEXT,
          scrollbarColor: `${TONE.warn} transparent`,
        }}
      >
        {visibleTranscript.length === 0 && !logError ? (
          <div className="flex items-center gap-2 py-8 text-[13px] justify-center" style={{ color: RAIL_MUTED }}>
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            {isLive ? "Starting run..." : logLoading ? "Loading transcript..." : "No transcript available."}
          </div>
        ) : null}

        <TranscriptBody displayItems={displayItems} />

        {logError && visibleTranscript.length === 0 ? (
          <div className="flex items-center gap-2 py-8 text-[13px] justify-center" style={{ color: RAIL_MUTED }}>
            {isLive ? (
              <>
                <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Starting run...
              </>
            ) : (
              logError
            )}
          </div>
        ) : null}
      </div>

      {/* Footer */}
      <div
        className="flex items-center justify-between gap-4 border-t px-4 py-2 text-[11px]"
        style={{ borderColor: RAIL_BORDER, backgroundColor: RAIL_BG, color: RAIL_MUTED }}
      >
        <span className="shrink-0 truncate">model {modelName}</span>
        <span className="truncate text-right">{workingDir}</span>
      </div>
    </div>
  );
}
