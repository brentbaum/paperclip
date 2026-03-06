import { useEffect, useMemo, useState } from "react";
import type { AgentFileContent, AgentFileEntry } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { MarkdownEditor } from "./MarkdownEditor";
import { cn, formatDateTime } from "../lib/utils";

interface AgentFilesWorkspaceProps {
  files: AgentFileEntry[];
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
  selectedFile: AgentFileContent | null | undefined;
  onSave: (input: { path: string; body: string }) => Promise<void>;
  isSaving?: boolean;
}

export function AgentFilesWorkspace({
  files,
  selectedPath,
  onSelectPath,
  selectedFile,
  onSave,
  isSaving = false,
}: AgentFilesWorkspaceProps) {
  const [draft, setDraft] = useState("");

  useEffect(() => {
    setDraft(selectedFile?.body ?? "");
  }, [selectedFile?.body, selectedFile?.path]);

  const selectedEntry = useMemo(
    () => files.find((file) => file.path === selectedPath) ?? null,
    [files, selectedPath],
  );
  const isDirty = draft !== (selectedFile?.body ?? "");

  if (files.length === 0) {
    return (
      <div className="rounded-lg border border-border px-4 py-5 text-sm text-muted-foreground">
        No markdown files found for this agent. Paperclip currently shows markdown files from the
        configured instructions directory and the agent workspace root.
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="rounded-2xl border border-border/60 bg-muted/10 p-2">
        <div className="px-2 pb-2 pt-1">
          <h3 className="text-sm font-medium">Agent Files</h3>
          <p className="mt-1 text-xs text-muted-foreground">Markdown files in the agent workspace and instructions directory.</p>
        </div>
        <div className="space-y-1">
          {files.map((file) => (
            <button
              key={file.path}
              className={cn(
                "w-full rounded-xl px-3 py-2 text-left transition-colors hover:bg-accent/40",
                selectedPath === file.path && "bg-accent/60",
              )}
              onClick={() => {
                if (isDirty && selectedPath && selectedPath !== file.path && !window.confirm("Discard unsaved changes?")) {
                  return;
                }
                onSelectPath(file.path);
              }}
            >
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{file.name}</span>
                {file.isInstructionsFile && (
                  <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                    Active
                  </span>
                )}
              </div>
              <p className="mt-1 truncate text-[11px] text-muted-foreground">
                {file.rootLabel} · {file.relativePath}
              </p>
            </button>
          ))}
        </div>
      </aside>

      <section className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium tracking-tight">{selectedEntry?.name ?? "Select a file"}</h3>
            {selectedFile && (
              <p className="mt-1 text-xs text-muted-foreground">
                {selectedFile.rootLabel} · {selectedFile.relativePath} · Updated {formatDateTime(selectedFile.updatedAt)}
              </p>
            )}
            {selectedFile?.isInstructionsFile && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                This file is configured as the agent’s active instructions file and will be used on the next run.
              </p>
            )}
          </div>
          {selectedFile && (
            <div className="flex items-center gap-2">
              {isDirty && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDraft(selectedFile.body)}
                  disabled={isSaving}
                >
                  Reset
                </Button>
              )}
              <Button
                size="sm"
                onClick={() => onSave({ path: selectedFile.path, body: draft })}
                disabled={!isDirty || isSaving}
              >
                {isSaving ? "Saving..." : "Save"}
              </Button>
            </div>
          )}
        </div>

        {selectedFile ? (
          <div className="rounded-2xl border border-border/50 bg-background shadow-sm">
            <div className="border-b border-border/50 px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              Live File
            </div>
            <MarkdownEditor
              value={draft}
              onChange={setDraft}
              placeholder="Write markdown..."
              bordered={false}
              onSubmit={() => {
                if (isDirty && !isSaving) {
                  void onSave({ path: selectedFile.path, body: draft });
                }
              }}
              className="px-4 py-4"
              contentClassName="min-h-[56vh] text-[15px] leading-7"
            />
          </div>
        ) : (
          <div className="rounded-lg border border-border px-4 py-5 text-sm text-muted-foreground">
            Select a file to start editing.
          </div>
        )}
      </section>
    </div>
  );
}
