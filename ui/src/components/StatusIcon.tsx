import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { cn } from "../lib/utils";
import { issueStatusText, issueStatusTextDefault } from "../lib/status-colors";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

const allStatuses = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"] as const;

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusColor(status: string): string {
  return issueStatusText[status] ?? issueStatusTextDefault;
}

function ShortcutBadge({ index }: { index: number }) {
  return (
    <span className="inline-flex min-w-4 items-center justify-center text-[11px] font-medium text-muted-foreground">
      {index + 1}
    </span>
  );
}

function StatusGlyph({ status, className }: { status: string; className?: string }) {
  const colorClass = statusColor(status);

  if (status === "done") {
    return (
      <span
        className={cn(
          "inline-flex h-4 w-4 items-center justify-center rounded-full bg-current",
          colorClass,
          className,
        )}
      >
        <Check className="h-3 w-3 text-background" strokeWidth={3} />
      </span>
    );
  }

  if (status === "todo") {
    return <span className={cn("inline-flex h-4 w-4 rounded-full border-2 border-current", colorClass, className)} />;
  }

  if (status === "backlog") {
    return (
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className={cn("h-4 w-4 shrink-0", colorClass, className)}
      >
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="1.5 2"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (status === "in_progress") {
    return (
      <span
        className={cn(
          "inline-flex h-4 w-4 rounded-full border-2 border-current border-r-transparent rotate-45",
          colorClass,
          className,
        )}
      />
    );
  }

  if (status === "in_review") {
    return (
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className={cn("h-4 w-4 shrink-0", colorClass, className)}
      >
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
        <path
          d="M8 4.5v4.5M5.75 7.75 8 10l2.25-2.25"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (status === "blocked") {
    return (
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className={cn("h-4 w-4 shrink-0", colorClass, className)}
      >
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
        <path
          d="m5.25 5.25 5.5 5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (status === "cancelled") {
    return (
      <span className={cn("inline-flex h-4 w-4 items-center justify-center rounded-full border-2 border-current", colorClass, className)}>
        <X className="h-2.5 w-2.5" strokeWidth={2.5} />
      </span>
    );
  }

  return <span className={cn("inline-flex h-4 w-4 rounded-full border-2 border-current", colorClass, className)} />;
}

interface StatusIconProps {
  status: string;
  onChange?: (status: string) => void;
  className?: string;
  showLabel?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function StatusIcon({
  status,
  onChange,
  className,
  showLabel,
  open: openProp,
  onOpenChange,
}: StatusIconProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  const setOpen = (next: boolean) => {
    onOpenChange?.(next);
    if (openProp === undefined) setInternalOpen(next);
  };
  const selectStatus = (nextStatus: string) => {
    if (!onChange) return;
    onChange(nextStatus);
    setOpen(false);
  };

  useEffect(() => {
    if (!open || !onChange) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key < "1" || event.key > "9") return;
      const index = Number.parseInt(event.key, 10) - 1;
      const nextStatus = allStatuses[index];
      if (!nextStatus) return;
      event.preventDefault();
      selectStatus(nextStatus);
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onChange, open]);

  const glyph = <StatusGlyph status={status} className={className} />;

  if (!onChange) {
    return showLabel ? (
      <span className="inline-flex items-center gap-1.5">
        {glyph}
        <span className="text-sm">{statusLabel(status)}</span>
      </span>
    ) : (
      glyph
    );
  }

  const trigger = showLabel ? (
    <button className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-accent/50">
      {glyph}
      <span className="text-sm">{statusLabel(status)}</span>
    </button>
  ) : (
    <button className="rounded-full transition-opacity hover:opacity-80">{glyph}</button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-56 p-1" align="start">
        {allStatuses.map((nextStatus, index) => (
          <Button
            key={nextStatus}
            variant="ghost"
            size="sm"
            className={cn("w-full justify-start gap-2 text-xs", nextStatus === status && "bg-accent")}
            onClick={() => selectStatus(nextStatus)}
          >
            <StatusGlyph status={nextStatus} />
            <span>{statusLabel(nextStatus)}</span>
            <span className="ml-auto inline-flex items-center gap-2">
              {nextStatus === status && <Check className="h-3 w-3 text-muted-foreground" />}
              <ShortcutBadge index={index} />
            </span>
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
