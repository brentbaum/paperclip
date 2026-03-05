import { describe, expect, it } from "vitest";
import { parseNewCommand } from "../services/telegram-new-parser.js";

describe("parseNewCommand", () => {
  it("parses inline owner and title on the first line", () => {
    const parsed = parseNewCommand("/new Fix auth timeout --owner alice");
    expect(parsed).toEqual({
      ok: true,
      title: "Fix auth timeout",
      description: null,
      ownerRef: "alice",
    });
  });

  it("accepts command mention form and multiline description", () => {
    const parsed = parseNewCommand(
      "/new@paperclipbot Add webhook retries\nUse exponential backoff.\nMax 3 attempts.",
    );
    expect(parsed).toEqual({
      ok: true,
      title: "Add webhook retries",
      description: "Use exponential backoff.\nMax 3 attempts.",
      ownerRef: null,
    });
  });

  it("parses owner when it appears before the title", () => {
    const parsed = parseNewCommand("/new --owner bob Harden timeout handling");
    expect(parsed).toEqual({
      ok: true,
      title: "Harden timeout handling",
      description: null,
      ownerRef: "bob",
    });
  });

  it("returns missing_title when title is empty", () => {
    const parsed = parseNewCommand("/new --owner alice");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe("missing_title");
  });

  it("returns invalid_owner_flag when owner flag has no value", () => {
    const parsed = parseNewCommand("/new Ship it --owner");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe("invalid_owner_flag");
  });

  it("returns missing_title when command token is missing", () => {
    const parsed = parseNewCommand("Create issue for this");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe("missing_title");
  });
});
