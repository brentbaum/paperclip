import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Check, AlertTriangle, Minus } from "lucide-react";
import { cn } from "../lib/utils";
import { priorityColor, priorityColorDefault } from "../lib/status-colors";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

const priorityConfig: Record<string, { icon: typeof ArrowUp; color: string; label: string }> = {
  critical: { icon: AlertTriangle, color: priorityColor.critical ?? priorityColorDefault, label: "Critical" },
  high: { icon: ArrowUp, color: priorityColor.high ?? priorityColorDefault, label: "High" },
  medium: { icon: Minus, color: priorityColor.medium ?? priorityColorDefault, label: "Medium" },
  low: { icon: ArrowDown, color: priorityColor.low ?? priorityColorDefault, label: "Low" },
};

const allPriorities = ["critical", "high", "medium", "low"];

interface PriorityIconProps {
  priority: string;
  onChange?: (priority: string) => void;
  className?: string;
  showLabel?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function ShortcutBadge({ index }: { index: number }) {
  return (
    <span className="inline-flex min-w-4 items-center justify-center text-[11px] font-medium text-muted-foreground">
      {index + 1}
    </span>
  );
}

export function PriorityIcon({
  priority,
  onChange,
  className,
  showLabel,
  open: openProp,
  onOpenChange,
}: PriorityIconProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  const setOpen = (next: boolean) => {
    onOpenChange?.(next);
    if (openProp === undefined) setInternalOpen(next);
  };
  const config = priorityConfig[priority] ?? priorityConfig.medium!;
  const Icon = config.icon;
  const selectPriority = (nextPriority: string) => {
    if (!onChange) return;
    onChange(nextPriority);
    setOpen(false);
  };

  useEffect(() => {
    if (!open || !onChange) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key < "1" || event.key > "9") return;
      const index = Number.parseInt(event.key, 10) - 1;
      const nextPriority = allPriorities[index];
      if (!nextPriority) return;
      event.preventDefault();
      selectPriority(nextPriority);
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onChange, open]);

  const icon = (
    <span
      className={cn(
        "inline-flex items-center justify-center shrink-0",
        config.color,
        onChange && !showLabel && "cursor-pointer",
        className
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  );

  if (!onChange) return showLabel ? <span className="inline-flex items-center gap-1.5">{icon}<span className="text-sm">{config.label}</span></span> : icon;

  const trigger = showLabel ? (
    <button className="inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors">
      {icon}
      <span className="text-sm">{config.label}</span>
    </button>
  ) : icon;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-44 p-1" align="start">
        {allPriorities.map((p, index) => {
          const c = priorityConfig[p]!;
          const PIcon = c.icon;
          return (
            <Button
              key={p}
              variant="ghost"
              size="sm"
              className={cn("w-full justify-start gap-2 text-xs", p === priority && "bg-accent")}
              onClick={() => selectPriority(p)}
            >
              <PIcon className={cn("h-3.5 w-3.5", c.color)} />
              <span>{c.label}</span>
              <span className="ml-auto inline-flex items-center gap-2">
                {p === priority && <Check className="h-3 w-3 text-muted-foreground" />}
                <ShortcutBadge index={index} />
              </span>
            </Button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
