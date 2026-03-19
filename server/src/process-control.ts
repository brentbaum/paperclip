const DEFAULT_SELF_RESTART_EXIT_CODE = 75;

let restartHandler: ((reason: string) => void) | null = null;

export function isSelfRestartEnabled(): boolean {
  return process.env.PAPERCLIP_SELF_RESTART === "true";
}

export function getSelfRestartExitCode(): number {
  const rawValue = process.env.PAPERCLIP_SELF_RESTART_EXIT_CODE;
  const parsed = Number(rawValue);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_SELF_RESTART_EXIT_CODE;
}

export function registerSelfRestartHandler(handler: ((reason: string) => void) | null): void {
  restartHandler = handler;
}

export function requestSelfRestart(reason = "requested"): void {
  if (!isSelfRestartEnabled()) {
    throw new Error("Self-restart is not enabled for this process");
  }
  if (!restartHandler) {
    throw new Error("Self-restart handler is not registered");
  }
  restartHandler(reason);
}
