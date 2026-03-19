export type RunLogChunk = { ts: string; stream: "stdout" | "stderr" | "system"; chunk: string };

export function parseLogRows(
  content: string,
  pendingRef: React.MutableRefObject<string>,
  finalize = false,
): RunLogChunk[] {
  if (!content && !finalize) return [];
  const combined = `${pendingRef.current}${content}`;
  const split = combined.split("\n");
  pendingRef.current = split.pop() ?? "";
  if (finalize && pendingRef.current) {
    split.push(pendingRef.current);
    pendingRef.current = "";
  }
  const parsed: RunLogChunk[] = [];
  for (const line of split) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed) as { ts?: unknown; stream?: unknown; chunk?: unknown };
      const stream = raw.stream === "stderr" || raw.stream === "system" ? raw.stream : "stdout";
      const chunk = typeof raw.chunk === "string" ? raw.chunk : "";
      const ts = typeof raw.ts === "string" ? raw.ts : new Date().toISOString();
      if (!chunk) continue;
      parsed.push({ ts, stream, chunk });
    } catch {
      // Ignore malformed rows while logs are still streaming.
    }
  }
  return parsed;
}
