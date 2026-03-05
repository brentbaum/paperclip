import { useEffect, useMemo, useState } from "react";
import type { Agent, Issue } from "@paperclipai/shared";
import { Check, User } from "lucide-react";
import { cn } from "../lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Identity } from "./Identity";
import { AgentIcon } from "./AgentIconPicker";

type AssigneeOption =
  | { key: string; assigneeAgentId: null; assigneeUserId: null; label: string; icon: "none" }
  | { key: string; assigneeAgentId: null; assigneeUserId: string; label: string; icon: "user" }
  | { key: string; assigneeAgentId: string; assigneeUserId: null; label: string; icon: "agent"; agent: Agent };

interface IssueAssigneePickerProps {
  issue: Pick<Issue, "assigneeAgentId" | "assigneeUserId" | "createdByUserId">;
  agents?: Agent[];
  currentUserId?: string | null;
  onChange: (assigneeAgentId: string | null, assigneeUserId: string | null) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  compact?: boolean;
}

function userLabel(userId: string | null | undefined, currentUserId?: string | null) {
  if (!userId) return null;
  if (userId === "local-board") return "Board";
  if (currentUserId && userId === currentUserId) return "Me";
  return userId.slice(0, 5);
}

function ShortcutBadge({ index }: { index: number }) {
  return (
    <span className="inline-flex min-w-4 items-center justify-center text-[11px] font-medium text-muted-foreground">
      {index + 1}
    </span>
  );
}

export function IssueAssigneePicker({
  issue,
  agents,
  currentUserId,
  onChange,
  open: openProp,
  onOpenChange,
  compact = false,
}: IssueAssigneePickerProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [search, setSearch] = useState("");
  const open = openProp ?? internalOpen;
  const setOpen = (next: boolean) => {
    onOpenChange?.(next);
    if (openProp === undefined) setInternalOpen(next);
    if (!next) setSearch("");
  };

  const currentAgent = issue.assigneeAgentId
    ? agents?.find((agent) => agent.id === issue.assigneeAgentId) ?? null
    : null;
  const currentUserLabel = userLabel(issue.assigneeUserId, currentUserId);

  const visibleOptions = useMemo<AssigneeOption[]>(() => {
    const options: AssigneeOption[] = [{ key: "none", assigneeAgentId: null, assigneeUserId: null, label: "No assignee", icon: "none" }];
    if (issue.createdByUserId) {
      const creatorLabel = userLabel(issue.createdByUserId, currentUserId);
      options.push({
        key: `user:${issue.createdByUserId}`,
        assigneeAgentId: null,
        assigneeUserId: issue.createdByUserId,
        label: creatorLabel ? `Assign to ${creatorLabel === "Me" ? "me" : creatorLabel}` : "Assign to requester",
        icon: "user",
      });
    }

    const filteredAgents = [...(agents ?? [])]
      .filter((agent) => agent.status !== "terminated")
      .filter((agent) => {
        if (!search.trim()) return true;
        return agent.name.toLowerCase().includes(search.trim().toLowerCase());
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const agent of filteredAgents) {
      options.push({
        key: `agent:${agent.id}`,
        assigneeAgentId: agent.id,
        assigneeUserId: null,
        label: agent.name,
        icon: "agent",
        agent,
      });
    }

    return options;
  }, [agents, currentUserId, issue.createdByUserId, search]);

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key < "1" || event.key > "9") return;
      const index = Number.parseInt(event.key, 10) - 1;
      const option = visibleOptions[index];
      if (!option) return;
      event.preventDefault();
      onChange(option.assigneeAgentId, option.assigneeUserId);
      setOpen(false);
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onChange, open, visibleOptions]);

  const trigger = currentAgent ? (
    compact ? (
      <span className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-accent/50">
        <Identity name={currentAgent.name} size="sm" />
      </span>
    ) : (
      <Identity name={currentAgent.name} size="sm" />
    )
  ) : currentUserLabel ? (
    <span className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-accent/50">
      <User className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-sm">{currentUserLabel}</span>
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-accent/50">
      <User className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">Unassigned</span>
    </span>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className={cn("min-w-0 rounded transition-colors hover:bg-accent/50", compact && "max-w-[13rem]")}>
          {trigger}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-1" align="start">
        <input
          className="mb-1 w-full border-b border-border bg-transparent px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground/50"
          placeholder="Search assignees..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          autoFocus
        />
        <div className="max-h-56 overflow-y-auto overscroll-contain">
          {visibleOptions.map((option, index) => {
            const selected =
              option.assigneeAgentId === issue.assigneeAgentId &&
              option.assigneeUserId === issue.assigneeUserId;

            return (
              <button
                key={option.key}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50",
                  selected && "bg-accent",
                )}
                onClick={() => {
                  onChange(option.assigneeAgentId, option.assigneeUserId);
                  setOpen(false);
                }}
              >
                {option.icon === "agent" ? (
                  <AgentIcon icon={option.agent.icon} className="h-3 w-3 shrink-0 text-muted-foreground" />
                ) : option.icon === "user" ? (
                  <User className="h-3 w-3 shrink-0 text-muted-foreground" />
                ) : (
                  <span className="h-3 w-3 shrink-0" />
                )}
                <span className="truncate">{option.label}</span>
                <span className="ml-auto inline-flex items-center gap-2">
                  {selected && <Check className="h-3 w-3 text-muted-foreground" />}
                  {index < 9 && <ShortcutBadge index={index} />}
                </span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
