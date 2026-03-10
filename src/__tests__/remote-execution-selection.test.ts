import { describe, expect, it } from "vitest";
import { resolvePreferredRemoteTargetId } from "../../ui/src/lib/remoteExecutionSelection";

describe("resolvePreferredRemoteTargetId", () => {
  const targets = [
    { id: "target-a", name: "Target A" },
    { id: "target-b", name: "Target B" },
  ];

  it("returns the last selected target when it is still available", () => {
    expect(resolvePreferredRemoteTargetId(targets, "target-b")).toBe("target-b");
  });

  it("falls back to the first available target when the last selected one is missing", () => {
    expect(resolvePreferredRemoteTargetId(targets, "missing")).toBe("target-a");
  });

  it("returns an empty string when there are no targets", () => {
    expect(resolvePreferredRemoteTargetId([], "target-b")).toBe("");
  });
});
