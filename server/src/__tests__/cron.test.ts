import { describe, expect, it } from "vitest";
import { parseCron, validateCron, nextCronTick, nextCronTickFromExpression } from "../services/cron.js";

describe("parseCron", () => {
  it("parses '0 9 * * 1-5' (weekdays at 9am)", () => {
    const cron = parseCron("0 9 * * 1-5");
    expect(cron.minutes).toEqual([0]);
    expect(cron.hours).toEqual([9]);
    expect(cron.daysOfMonth).toHaveLength(31); // all days
    expect(cron.months).toHaveLength(12); // all months
    expect(cron.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it("parses '*/15 * * * *' (every 15 minutes)", () => {
    const cron = parseCron("*/15 * * * *");
    expect(cron.minutes).toEqual([0, 15, 30, 45]);
  });

  it("parses '0 0 1 * *' (midnight on the 1st)", () => {
    const cron = parseCron("0 0 1 * *");
    expect(cron.minutes).toEqual([0]);
    expect(cron.hours).toEqual([0]);
    expect(cron.daysOfMonth).toEqual([1]);
  });

  it("throws on invalid expression", () => {
    expect(() => parseCron("invalid")).toThrow();
    expect(() => parseCron("")).toThrow();
    expect(() => parseCron("* * *")).toThrow(); // too few fields
  });
});

describe("validateCron", () => {
  it("returns null for valid expressions", () => {
    expect(validateCron("0 9 * * 1-5")).toBeNull();
    expect(validateCron("*/5 * * * *")).toBeNull();
  });

  it("returns error string for invalid expressions", () => {
    expect(validateCron("invalid")).toBeTruthy();
    expect(typeof validateCron("bad cron")).toBe("string");
  });
});

describe("nextCronTick", () => {
  it("finds next weekday at 9am UTC", () => {
    const cron = parseCron("0 9 * * 1-5");
    // Wednesday 2026-03-18 at 08:00 UTC
    const after = new Date("2026-03-18T08:00:00Z");
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    // Should be 2026-03-18 09:00 UTC (same day, it's a Wednesday)
    expect(next!.getUTCHours()).toBe(9);
    expect(next!.getUTCMinutes()).toBe(0);
    expect(next!.getUTCDay()).toBeGreaterThanOrEqual(1);
    expect(next!.getUTCDay()).toBeLessThanOrEqual(5);
  });

  it("skips weekends for weekday-only schedule", () => {
    const cron = parseCron("0 9 * * 1-5");
    // Saturday 2026-03-21 at 10:00 UTC
    const after = new Date("2026-03-21T10:00:00Z");
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    // Should be Monday 2026-03-23 09:00 UTC
    expect(next!.getUTCDay()).toBe(1); // Monday
    expect(next!.getUTCHours()).toBe(9);
  });

  it("returns strictly after the reference date", () => {
    const cron = parseCron("0 9 * * *");
    const after = new Date("2026-03-17T09:00:00Z");
    const next = nextCronTick(cron, after);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(after.getTime());
  });
});

describe("nextCronTickFromExpression", () => {
  it("convenience wrapper works end-to-end", () => {
    const after = new Date("2026-03-17T08:00:00Z");
    const next = nextCronTickFromExpression("0 9 * * *", after);
    expect(next).not.toBeNull();
    expect(next!.getUTCHours()).toBe(9);
    expect(next!.getUTCMinutes()).toBe(0);
  });
});
