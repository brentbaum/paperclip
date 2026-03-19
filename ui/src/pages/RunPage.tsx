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
import { parseLogRows, type RunLogChunk } from "../lib/parseLogRows";
import { StatusBadge } from "../components/StatusBadge";
import { Identity } from "../components/Identity";
import { PageSkeleton } from "../components/PageSkeleton";
import { extractFooterModel } from "../components/RunTranscript";
import { RunTranscriptView } from "../components/transcript/RunTranscriptView";

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
  const modelName = useMemo(
    () => extractFooterModel(transcript, adapterInvokePayload, runMeta.adapterType),
    [adapterInvokePayload, runMeta.adapterType, transcript],
  );
  const workingDir = adapterInvokePayload && typeof adapterInvokePayload.cwd === "string"
    ? adapterInvokePayload.cwd
    : isLive && transcript.length === 0 ? "starting..." : "";

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
  }, [transcript.length]);

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
    <div className="flex flex-col h-[calc(100vh-3rem)]">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-background">
        <Link
          to={`/${companyPrefix}/agents/${runMeta.agentUrlKey}`}
          className="hover:underline no-underline text-inherit"
        >
          <Identity name={runMeta.agentName} size="sm" />
        </Link>
        <span className="text-xs font-mono text-muted-foreground">{runId.slice(0, 8)}</span>
        <StatusBadge status={runStatus} />
        {isLive && (
          <span className="flex items-center gap-1 text-xs text-cyan-600 dark:text-cyan-400">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-400" />
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
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] font-mono hover:bg-accent/20 transition-colors no-underline text-inherit"
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
        className="flex-1 min-h-0 overflow-y-auto px-4 py-3"
      >
        {transcript.length === 0 && !logError ? (
          <div className="flex items-center gap-2 py-8 text-sm justify-center text-muted-foreground">
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            {isLive ? "Starting run..." : logLoading ? "Loading transcript..." : "No transcript available."}
          </div>
        ) : (
          <RunTranscriptView entries={transcript} streaming={isLive} />
        )}

        {logError && transcript.length === 0 ? (
          <div className="flex items-center gap-2 py-8 text-sm justify-center text-muted-foreground">
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
      <div className="flex items-center justify-between gap-4 border-t border-border px-4 py-2 text-[11px] text-muted-foreground bg-background">
        <span className="shrink-0 truncate">model {modelName}</span>
        <span className="truncate text-right">{workingDir}</span>
      </div>
    </div>
  );
}
