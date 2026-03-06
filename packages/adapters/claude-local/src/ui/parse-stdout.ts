import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return "";
  const msg =
    (typeof rec.message === "string" && rec.message) ||
    (typeof rec.error === "string" && rec.error) ||
    (typeof rec.code === "string" && rec.code) ||
    "";
  if (msg) return msg;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseClaudeStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = typeof parsed.type === "string" ? parsed.type : "";
  // System events: hooks, rate limits, etc. → formatted system entries
  if (type === "system") {
    const subtype = typeof parsed.subtype === "string" ? parsed.subtype : "";
    if (subtype === "init") {
      return [
        {
          kind: "init",
          ts,
          model: typeof parsed.model === "string" ? parsed.model : "unknown",
          sessionId: typeof parsed.session_id === "string" ? parsed.session_id : "",
        },
      ];
    }
    const hookName = typeof parsed.hook_name === "string" ? parsed.hook_name : "";
    if (subtype === "hook_started") {
      return [{ kind: "system", ts, text: `hook started: ${hookName}` }];
    }
    if (subtype === "hook_response") {
      const outcome = typeof parsed.outcome === "string" ? parsed.outcome : "unknown";
      return [{ kind: "system", ts, text: `hook ${outcome}: ${hookName}` }];
    }
    // Other system subtypes → short formatted line
    const text = subtype || "system";
    return [{ kind: "system", ts, text }];
  }

  // Rate limit events → system entry
  if (type === "rate_limit_event") {
    const info = asRecord(parsed.rate_limit_info);
    const status = info && typeof info.status === "string" ? info.status : "unknown";
    return [{ kind: "system", ts, text: `rate limit: ${status}` }];
  }

  if (type === "assistant") {
    const message = asRecord(parsed.message) ?? {};
    const content = Array.isArray(message.content) ? message.content : [];
    const entries: TranscriptEntry[] = [];
    for (const blockRaw of content) {
      const block = asRecord(blockRaw);
      if (!block) continue;
      const blockType = typeof block.type === "string" ? block.type : "";
      if (blockType === "text") {
        const text = typeof block.text === "string" ? block.text : "";
        if (text) entries.push({ kind: "assistant", ts, text });
      } else if (blockType === "thinking") {
        const text = typeof block.thinking === "string" ? block.thinking : "";
        if (text) entries.push({ kind: "thinking", ts, text });
      } else if (blockType === "tool_use") {
        entries.push({
          kind: "tool_call",
          ts,
          name: typeof block.name === "string" ? block.name : "unknown",
          input: block.input ?? {},
        });
      }
    }
    return entries.length > 0 ? entries : [{ kind: "stdout", ts, text: line }];
  }

  if (type === "user") {
    const message = asRecord(parsed.message) ?? {};
    const content = Array.isArray(message.content) ? message.content : [];
    const entries: TranscriptEntry[] = [];
    for (const blockRaw of content) {
      const block = asRecord(blockRaw);
      if (!block) continue;
      const blockType = typeof block.type === "string" ? block.type : "";
      if (blockType === "text") {
        const text = typeof block.text === "string" ? block.text : "";
        if (text) entries.push({ kind: "user", ts, text });
      } else if (blockType === "tool_result") {
        const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        const isError = block.is_error === true;
        let text = "";
        if (typeof block.content === "string") {
          text = block.content;
        } else if (Array.isArray(block.content)) {
          const parts: string[] = [];
          for (const part of block.content) {
            const p = asRecord(part);
            if (p && typeof p.text === "string") parts.push(p.text);
          }
          text = parts.join("\n");
        }
        entries.push({ kind: "tool_result", ts, toolUseId, content: text, isError });
      }
    }
    if (entries.length > 0) return entries;
    // fall through to stdout for user messages without recognized blocks
  }

  if (type === "result") {
    const usage = asRecord(parsed.usage) ?? {};
    const inputTokens = asNumber(usage.input_tokens);
    const outputTokens = asNumber(usage.output_tokens);
    const cachedTokens = asNumber(usage.cache_read_input_tokens);
    const costUsd = asNumber(parsed.total_cost_usd);
    const subtype = typeof parsed.subtype === "string" ? parsed.subtype : "";
    const isError = parsed.is_error === true;
    const errors = Array.isArray(parsed.errors) ? parsed.errors.map(errorText).filter(Boolean) : [];
    const text = typeof parsed.result === "string" ? parsed.result : "";
    return [{
      kind: "result",
      ts,
      text,
      inputTokens,
      outputTokens,
      cachedTokens,
      costUsd,
      subtype,
      isError,
      errors,
    }];
  }

  // Parsed JSON that doesn't match any known type — format as system entry
  // instead of dumping raw JSON into the transcript
  if (parsed) {
    const subtype = typeof parsed.subtype === "string" ? parsed.subtype : "";
    const summary = type ? (subtype ? `${type}: ${subtype}` : type) : "event";
    return [{ kind: "system", ts, text: summary }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
