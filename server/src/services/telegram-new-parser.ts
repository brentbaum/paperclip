export interface ParsedNewCommand {
  ok: true;
  title: string;
  description: string | null;
  ownerRef: string | null;
}

export type NewCommandParseErrorCode =
  | "missing_title"
  | "missing_owner_outside_agent_topic"
  | "invalid_owner_flag";

export interface NewCommandParseError {
  ok: false;
  code: NewCommandParseErrorCode;
  message: string;
}

export type ParsedNewCommandResult = ParsedNewCommand | NewCommandParseError;

const NEW_COMMAND_PREFIX = /^\/new(?:@\S+)?(?=\s|$)/i;
const OWNER_FLAG_REGEX = /(^|\s)--owner\s+([^\s]+)/g;

export function parseNewCommand(text: string): ParsedNewCommandResult {
  const normalized = text.replace(/\r\n/g, "\n").trimStart();
  const commandMatch = normalized.match(NEW_COMMAND_PREFIX);
  if (!commandMatch) {
    return {
      ok: false,
      code: "missing_title",
      message: "Usage: /new <title> [--owner <agent>]",
    };
  }

  const remainder = normalized.slice(commandMatch[0].length);
  const lines = remainder.split("\n");
  const firstLineRaw = (lines[0] ?? "").trim();

  let ownerRef: string | null = null;
  let titleCandidate = firstLineRaw;
  let ownerFlagFound = false;

  for (const match of firstLineRaw.matchAll(OWNER_FLAG_REGEX)) {
    ownerFlagFound = true;
    ownerRef = match[2]?.trim() ?? null;
  }

  if (firstLineRaw.includes("--owner") && !ownerFlagFound) {
    return {
      ok: false,
      code: "invalid_owner_flag",
      message: "Invalid owner flag. Use --owner <agent>.",
    };
  }

  if (ownerFlagFound) {
    titleCandidate = firstLineRaw.replace(OWNER_FLAG_REGEX, " ").trim();
    if (!ownerRef || ownerRef.length === 0) {
      return {
        ok: false,
        code: "invalid_owner_flag",
        message: "Invalid owner flag. Use --owner <agent>.",
      };
    }
  }

  if (titleCandidate.length === 0) {
    return {
      ok: false,
      code: "missing_title",
      message: "Issue title is required.",
    };
  }

  const descriptionRaw = lines.slice(1).join("\n").trim();
  return {
    ok: true,
    title: titleCandidate,
    description: descriptionRaw.length > 0 ? descriptionRaw : null,
    ownerRef,
  };
}
