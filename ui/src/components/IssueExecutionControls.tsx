import type { IssueExecutionMode, RemoteExecutionTarget } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type IssueExecutionControlsProps = {
  executionMode: IssueExecutionMode;
  executionTargetId: string;
  onExecutionModeChange: (mode: IssueExecutionMode) => void;
  onExecutionTargetChange: (targetId: string) => void;
  targets: RemoteExecutionTarget[];
  canUseRemote: boolean;
  size?: "sm" | "default";
  triggerClassName?: string;
  textClassName?: string;
  showPrefix?: boolean;
  remoteRequirementLabel?: string;
};

const EXECUTION_MODE_LABELS: Record<IssueExecutionMode, string> = {
  default: "Local",
  remote: "Remote",
};

export function IssueExecutionControls({
  executionMode,
  executionTargetId,
  onExecutionModeChange,
  onExecutionTargetChange,
  targets,
  canUseRemote,
  size = "default",
  triggerClassName,
  textClassName,
  showPrefix = true,
  remoteRequirementLabel,
}: IssueExecutionControlsProps) {
  const effectiveExecutionMode = canUseRemote ? executionMode : "default";
  const selectedTarget = targets.find((target) => target.id === executionTargetId) ?? null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {showPrefix && <span className={cn("text-muted-foreground", textClassName)}>via</span>}
      <Select
        value={effectiveExecutionMode}
        onValueChange={(value) => onExecutionModeChange(value as IssueExecutionMode)}
      >
        <SelectTrigger size={size} className={cn("min-w-[112px]", triggerClassName)}>
          <SelectValue placeholder="Execution" />
        </SelectTrigger>
        <SelectContent align="start">
          <SelectItem value="default">{EXECUTION_MODE_LABELS.default}</SelectItem>
          <SelectItem value="remote" disabled={!canUseRemote}>
            {canUseRemote ? EXECUTION_MODE_LABELS.remote : "Remote"}
          </SelectItem>
        </SelectContent>
      </Select>

      {effectiveExecutionMode === "remote" && (
        <>
          <span className={cn("text-muted-foreground", textClassName)}>on</span>
          <Select value={executionTargetId} onValueChange={onExecutionTargetChange} disabled={targets.length === 0}>
            <SelectTrigger size={size} className={cn("min-w-[180px]", triggerClassName)}>
              <SelectValue placeholder={targets.length === 0 ? "No targets" : "Choose target"}>
                {selectedTarget?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectContent align="start">
              {targets.length === 0 ? (
                <SelectItem value="__no_targets__" disabled>
                  No remote targets
                </SelectItem>
              ) : (
                targets.map((target) => (
                  <SelectItem key={target.id} value={target.id}>
                    {target.name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </>
      )}

      {!canUseRemote && remoteRequirementLabel ? (
        <span className={cn("text-muted-foreground", textClassName)}>{remoteRequirementLabel}</span>
      ) : null}
    </div>
  );
}
