const LAST_REMOTE_TARGET_KEY_PREFIX = "paperclip:last-remote-target";

export function buildLastRemoteTargetStorageKey(scopeKey: string) {
  return `${LAST_REMOTE_TARGET_KEY_PREFIX}:${scopeKey}`;
}

export function readLastRemoteTargetId(scopeKey: string | null | undefined) {
  if (!scopeKey) return null;
  try {
    return localStorage.getItem(buildLastRemoteTargetStorageKey(scopeKey));
  } catch {
    return null;
  }
}

export function writeLastRemoteTargetId(
  scopeKey: string | null | undefined,
  targetId: string | null | undefined,
) {
  if (!scopeKey || !targetId) return;
  try {
    localStorage.setItem(buildLastRemoteTargetStorageKey(scopeKey), targetId);
  } catch {
    // Ignore localStorage failures.
  }
}

export function resolvePreferredRemoteTargetId(
  targets: Array<{ id: string }>,
  lastSelectedTargetId: string | null | undefined,
) {
  if (targets.length === 0) return "";
  if (
    lastSelectedTargetId &&
    targets.some((target) => target.id === lastSelectedTargetId)
  ) {
    return lastSelectedTargetId;
  }
  return targets[0]?.id ?? "";
}
