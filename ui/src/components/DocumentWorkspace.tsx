import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Document, DocumentRevision } from "@paperclipai/shared";
import { documentsApi } from "../api/documents";
import { queryKeys } from "../lib/queryKeys";
import { MarkdownEditor } from "./MarkdownEditor";
import { Button } from "@/components/ui/button";
import { cn, formatDateTime } from "../lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type SaveInput = {
  baseRevisionId?: string | null;
  body: string;
  changeSummary?: string | null;
  source?: string;
};

interface DocumentWorkspaceProps {
  document: Document | null | undefined;
  revisions: DocumentRevision[];
  heading: string;
  hideTitleLine?: boolean;
  saveSource?: string;
  emptyLabel?: string;
  onSave: (input: SaveInput) => Promise<void>;
  isSaving?: boolean;
}

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
      continue;
    }
    if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
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

function authorLabel(revision: DocumentRevision) {
  if (revision.authorAgentId) return "Agent";
  if (revision.authorUserId) return "Board";
  return "System";
}

function revisionLabel(revision: DocumentRevision) {
  return formatDateTime(revision.createdAt);
}

export function DocumentWorkspace({
  document,
  revisions,
  heading,
  hideTitleLine = false,
  saveSource = "user_edit",
  emptyLabel = "No document loaded.",
  onSave,
  isSaving = false,
}: DocumentWorkspaceProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [compareFrom, setCompareFrom] = useState<string | null>(null);
  const [compareTo, setCompareTo] = useState<string | null>(null);

  useEffect(() => {
    setDraft(document?.latestRevision?.body ?? "");
  }, [document?.latestRevision?.body, document?.id]);

  useEffect(() => {
    if (!document) {
      setCompareFrom(null);
      setCompareTo(null);
      return;
    }
    const nextTo = document.latestRevisionId ?? revisions[0]?.id ?? null;
    const nextFrom = revisions[1]?.id ?? revisions[0]?.parentRevisionId ?? null;
    setCompareTo((current) => current ?? nextTo);
    setCompareFrom((current) => current ?? nextFrom);
  }, [document, revisions]);

  const diffQuery = useQuery({
    queryKey: document ? queryKeys.documents.diff(document.id, compareFrom, compareTo) : ["documents", "diff", "none"],
    queryFn: () => documentsApi.getDiff(document!.id, compareFrom, compareTo),
    enabled: Boolean(document?.id && compareTo),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!document) throw new Error("Document not found");
      await onSave({
        baseRevisionId: document.latestRevisionId,
        body: draft,
        changeSummary: null,
        source: saveSource,
      });
    },
    onSuccess: async () => {
      if (!document) return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.documents.detail(document.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.documents.revisions(document.id) });
    },
  });

  const diffLines = useMemo(() => {
    if (!diffQuery.data) return [];
    return buildDiffLines(diffQuery.data.fromBody, diffQuery.data.toBody);
  }, [diffQuery.data]);
  const isDirty = draft !== (document?.latestRevision?.body ?? "");

  if (!document) {
    return (
      <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }

  return (
    <>
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium tracking-tight">{heading}</h3>
            {!hideTitleLine && (
              <p className="mt-1 text-xs text-muted-foreground">
                {document.title}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setHistoryOpen(true)}>
              History
            </Button>
            {isDirty && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDraft(document.latestRevision?.body ?? "")}
                disabled={saveMutation.isPending || isSaving}
              >
                Reset
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={!isDirty || saveMutation.isPending || isSaving}
            >
              {saveMutation.isPending || isSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
        <div className="rounded-2xl border border-border/50 bg-background shadow-sm">
          <div className="border-b border-border/50 px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            Live Document
          </div>
          <MarkdownEditor
            value={draft}
            onChange={setDraft}
            placeholder="Write markdown..."
            bordered={false}
            onSubmit={() => {
              if (isDirty && !saveMutation.isPending && !isSaving) {
                saveMutation.mutate();
              }
            }}
            className="px-4 py-4"
            contentClassName="min-h-[56vh] text-[15px] leading-7"
          />
        </div>

        {saveMutation.error && (
          <p className="text-sm text-destructive">
            {saveMutation.error instanceof Error ? saveMutation.error.message : "Save failed"}
          </p>
        )}
      </div>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-5xl p-0 overflow-hidden">
          <DialogHeader className="border-b border-border/60 px-6 py-4">
            <DialogTitle>Revision History</DialogTitle>
            <DialogDescription>
              Review prior revisions and compare document changes without leaving the editor.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-0 lg:grid-cols-[280px_minmax(0,1fr)]">
            <div className="border-b border-border/60 p-4 lg:border-r lg:border-b-0">
              <h4 className="text-sm font-medium">Revisions</h4>
              <div className="mt-4 space-y-2 max-h-[60vh] overflow-y-auto pr-1">
                {revisions.map((revision) => (
                  <button
                    key={revision.id}
                    className={cn(
                      "w-full rounded-xl border border-border/70 px-3 py-2 text-left transition-colors hover:bg-accent/20",
                      compareTo === revision.id && "border-foreground/30 bg-accent/20",
                    )}
                    onClick={() => {
                      setCompareTo(revision.id);
                      setCompareFrom(revision.parentRevisionId ?? null);
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium">{revisionLabel(revision)}</span>
                      <span className="text-[11px] text-muted-foreground">{authorLabel(revision)}</span>
                    </div>
                    {revision.changeSummary && (
                      <p className="mt-1 text-xs text-foreground/90">{revision.changeSummary}</p>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div className="p-4 space-y-4">
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    From
                  </label>
                  <select
                    className="mt-1 block rounded-md border border-border bg-background px-3 py-2 text-sm"
                    value={compareFrom ?? ""}
                    onChange={(event) => setCompareFrom(event.target.value || null)}
                  >
                    <option value="">Empty</option>
                    {revisions.map((revision) => (
                      <option key={revision.id} value={revision.id}>
                        {revisionLabel(revision)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    To
                  </label>
                  <select
                    className="mt-1 block rounded-md border border-border bg-background px-3 py-2 text-sm"
                    value={compareTo ?? ""}
                    onChange={(event) => setCompareTo(event.target.value || null)}
                  >
                    {revisions.map((revision) => (
                      <option key={revision.id} value={revision.id}>
                        {revisionLabel(revision)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="rounded-xl border border-border/60 bg-muted/15 overflow-hidden">
                <div className="border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
                  Revision diff
                </div>
                <div className="max-h-[58vh] overflow-auto font-mono text-xs">
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
