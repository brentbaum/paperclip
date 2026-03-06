import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Document, DocumentRevision } from "@paperclipai/shared";
import { documentsApi } from "../api/documents";
import { queryKeys } from "../lib/queryKeys";
import { MarkdownEditor } from "./MarkdownEditor";
import { MarkdownBody } from "./MarkdownBody";
import { Button } from "@/components/ui/button";
import { cn, formatDateTime } from "../lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Check, History, RotateCcw } from "lucide-react";

type DiffLine = {
  kind: "equal" | "remove" | "add";
  text: string;
};

function buildDiffLines(fromBody: string, toBody: string): DiffLine[] {
  const from = fromBody.split("\n");
  const to = toBody.split("\n");
  const dp = Array.from({ length: from.length + 1 }, () =>
    Array<number>(to.length + 1).fill(0),
  );
  for (let i = from.length - 1; i >= 0; i -= 1) {
    for (let j = to.length - 1; j >= 0; j -= 1) {
      dp[i][j] =
        from[i] === to[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < from.length && j < to.length) {
    if (from[i] === to[j]) {
      lines.push({ kind: "equal", text: from[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      lines.push({ kind: "remove", text: from[i]! });
      i += 1;
    } else {
      lines.push({ kind: "add", text: to[j]! });
      j += 1;
    }
  }
  while (i < from.length) {
    lines.push({ kind: "remove", text: from[i]! });
    i += 1;
  }
  while (j < to.length) {
    lines.push({ kind: "add", text: to[j]! });
    j += 1;
  }
  return lines;
}

interface IssuePlanRailProps {
  issueId: string;
  onApprove?: (body: string) => void;
  onRequestChanges?: (feedback: string) => void;
  className?: string;
}

export function IssuePlanRail({
  issueId,
  onApprove,
  onRequestChanges,
  className,
}: IssuePlanRailProps) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [feedback, setFeedback] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [compareFrom, setCompareFrom] = useState<string | null>(null);
  const [compareTo, setCompareTo] = useState<string | null>(null);

  const { data: planDoc, isLoading } = useQuery({
    queryKey: queryKeys.documents.issuePlan(issueId),
    queryFn: () => documentsApi.getIssuePlanDocument(issueId),
    enabled: !!issueId,
  });

  const { data: revisions } = useQuery({
    queryKey: planDoc ? queryKeys.documents.revisions(planDoc.id) : ["noop"],
    queryFn: () => documentsApi.listRevisions(planDoc!.id),
    enabled: !!planDoc?.id,
  });

  const diffQuery = useQuery({
    queryKey: planDoc ? queryKeys.documents.diff(planDoc.id, compareFrom, compareTo) : ["noop-diff"],
    queryFn: () => documentsApi.getDiff(planDoc!.id, compareFrom, compareTo),
    enabled: Boolean(planDoc?.id && compareTo),
  });

  const diffLines = useMemo(() => {
    if (!diffQuery.data) return [];
    return buildDiffLines(diffQuery.data.fromBody, diffQuery.data.toBody);
  }, [diffQuery.data]);

  useEffect(() => {
    if (planDoc?.latestRevision?.body !== undefined) {
      setDraft(planDoc.latestRevision.body);
    }
  }, [planDoc?.latestRevision?.body, planDoc?.id]);

  useEffect(() => {
    if (!planDoc || !revisions) return;
    const nextTo = planDoc.latestRevisionId ?? revisions[0]?.id ?? null;
    const nextFrom = revisions[1]?.id ?? revisions[0]?.parentRevisionId ?? null;
    setCompareTo((c) => c ?? nextTo);
    setCompareFrom((c) => c ?? nextFrom);
  }, [planDoc, revisions]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!planDoc) throw new Error("No plan document");
      await documentsApi.createRevision(planDoc.id, {
        baseRevisionId: planDoc.latestRevisionId,
        body: draft,
        source: "user_edit",
      });
    },
    onSuccess: async () => {
      setEditing(false);
      if (planDoc) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.documents.issuePlan(issueId) });
        await queryClient.invalidateQueries({ queryKey: queryKeys.documents.revisions(planDoc.id) });
      }
    },
  });

  const isDirty = draft !== (planDoc?.latestRevision?.body ?? "");
  const body = planDoc?.latestRevision?.body ?? "";
  const hasContent = body.trim().length > 0;

  if (isLoading) {
    return (
      <div className={cn("rounded-2xl border border-border/50 bg-background p-4", className)}>
        <p className="text-xs text-muted-foreground">Loading plan...</p>
      </div>
    );
  }

  if (!planDoc || !hasContent) return null;

  return (
    <>
      <aside className={cn("rounded-2xl border border-border/50 bg-background shadow-sm overflow-hidden", className)}>
        <div className="border-b border-border/50 px-4 py-2 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground font-medium">
            Plan
          </span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-xs" onClick={() => setHistoryOpen(true)} title="History">
              <History className="h-3.5 w-3.5" />
            </Button>
            {!editing && (
              <Button variant="ghost" size="sm" className="text-xs h-6" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
          </div>
        </div>

        {editing ? (
          <div className="flex flex-col">
            <MarkdownEditor
              value={draft}
              onChange={setDraft}
              placeholder="Write plan..."
              bordered={false}
              className="px-3 py-3"
              contentClassName="min-h-[20rem] text-sm leading-6"
            />
            <div className="flex items-center gap-2 border-t border-border/50 px-3 py-2">
              {isDirty && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-7"
                  onClick={() => {
                    setDraft(planDoc?.latestRevision?.body ?? "");
                    setEditing(false);
                  }}
                >
                  <RotateCcw className="h-3 w-3 mr-1" />
                  Cancel
                </Button>
              )}
              <Button
                size="sm"
                className="text-xs h-7 ml-auto"
                onClick={() => saveMutation.mutate()}
                disabled={!isDirty || saveMutation.isPending}
              >
                {saveMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
            {saveMutation.error && (
              <p className="px-3 pb-2 text-xs text-destructive">
                {saveMutation.error instanceof Error ? saveMutation.error.message : "Save failed"}
              </p>
            )}
          </div>
        ) : (
          <div className="px-4 py-3 max-h-[60vh] overflow-y-auto">
            <MarkdownBody className="text-sm leading-6 prose-sm">{body}</MarkdownBody>
          </div>
        )}

        <div className="border-t border-border/50 px-3 py-3 space-y-2">
          {onApprove && (
            <Button
              size="sm"
              className="w-full text-xs h-8"
              variant="default"
              onClick={() => onApprove(body)}
            >
              <Check className="h-3.5 w-3.5 mr-1.5" />
              Approve Plan
            </Button>
          )}
          {onRequestChanges && (
            <div className="space-y-1.5">
              <textarea
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-ring min-h-[3rem]"
                placeholder="Request changes..."
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
              />
              <Button
                size="sm"
                className="w-full text-xs h-7"
                variant="outline"
                disabled={!feedback.trim()}
                onClick={() => {
                  onRequestChanges(feedback.trim());
                  setFeedback("");
                }}
              >
                Request Changes
              </Button>
            </div>
          )}
        </div>
      </aside>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-4xl p-0 overflow-hidden">
          <DialogHeader className="border-b border-border/60 px-6 py-4">
            <DialogTitle>Plan Revision History</DialogTitle>
            <DialogDescription>
              Review prior plan revisions and compare changes.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-0 lg:grid-cols-[240px_minmax(0,1fr)]">
            <div className="border-b border-border/60 p-4 lg:border-r lg:border-b-0">
              <h4 className="text-sm font-medium">Revisions</h4>
              <div className="mt-3 space-y-1.5 max-h-[55vh] overflow-y-auto pr-1">
                {(revisions ?? []).map((revision) => (
                  <button
                    key={revision.id}
                    className={cn(
                      "w-full rounded-lg border border-border/70 px-2.5 py-1.5 text-left transition-colors hover:bg-accent/20 text-xs",
                      compareTo === revision.id && "border-foreground/30 bg-accent/20",
                    )}
                    onClick={() => {
                      setCompareTo(revision.id);
                      setCompareFrom(revision.parentRevisionId ?? null);
                    }}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-medium">{formatDateTime(revision.createdAt)}</span>
                      <span className="text-muted-foreground">
                        {revision.authorAgentId ? "Agent" : revision.authorUserId ? "Board" : "System"}
                      </span>
                    </div>
                    {revision.changeSummary && (
                      <p className="mt-0.5 text-foreground/80">{revision.changeSummary}</p>
                    )}
                  </button>
                ))}
              </div>
            </div>
            <div className="p-4 space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="text-[11px] uppercase tracking-wide text-muted-foreground">From</label>
                  <select
                    className="mt-1 block rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                    value={compareFrom ?? ""}
                    onChange={(e) => setCompareFrom(e.target.value || null)}
                  >
                    <option value="">Empty</option>
                    {(revisions ?? []).map((r) => (
                      <option key={r.id} value={r.id}>{formatDateTime(r.createdAt)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[11px] uppercase tracking-wide text-muted-foreground">To</label>
                  <select
                    className="mt-1 block rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                    value={compareTo ?? ""}
                    onChange={(e) => setCompareTo(e.target.value || null)}
                  >
                    {(revisions ?? []).map((r) => (
                      <option key={r.id} value={r.id}>{formatDateTime(r.createdAt)}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/15 overflow-hidden">
                <div className="border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
                  Revision diff
                </div>
                <div className="max-h-[50vh] overflow-auto font-mono text-xs">
                  {diffQuery.isLoading ? (
                    <div className="px-3 py-3 text-muted-foreground">Loading diff...</div>
                  ) : diffLines.length === 0 ? (
                    <div className="px-3 py-3 text-muted-foreground">No diff available.</div>
                  ) : (
                    diffLines.map((line, index) => (
                      <div
                        key={`${line.kind}:${index}:${line.text}`}
                        className={cn(
                          "px-3 py-0.5 whitespace-pre-wrap break-words",
                          line.kind === "add" && "bg-green-500/10 text-green-700 dark:text-green-300",
                          line.kind === "remove" && "bg-red-500/10 text-red-700 dark:text-red-300",
                          line.kind === "equal" && "text-muted-foreground",
                        )}
                      >
                        <span className="inline-block w-4 select-none">
                          {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
                        </span>
                        {line.text || " "}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
