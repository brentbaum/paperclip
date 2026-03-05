import { describe, expect, it } from "vitest";
import { retryTelegramCall } from "../services/telegram.js";

describe("retryTelegramCall", () => {
  it("retries 429 errors and respects retry_after", async () => {
    let attempts = 0;
    const delays: number[] = [];

    const result = await retryTelegramCall(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          const err = new Error("rate limited") as Error & {
            error_code: number;
            parameters: { retry_after: number };
          };
          err.error_code = 429;
          err.parameters = { retry_after: 2 };
          throw err;
        }
        return "ok";
      },
      {
        sleep: async (ms) => {
          delays.push(ms);
        },
        random: () => 0,
      },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(2);
    expect(delays).toEqual([2000]);
  });

  it("retries 5xx errors", async () => {
    let attempts = 0;
    const delays: number[] = [];

    const result = await retryTelegramCall(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          const err = new Error("telegram unavailable") as Error & { error_code: number };
          err.error_code = 503;
          throw err;
        }
        return "ok";
      },
      {
        sleep: async (ms) => {
          delays.push(ms);
        },
        random: () => 0,
        baseDelayMs: 100,
      },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it("does not retry 400 errors", async () => {
    let attempts = 0;
    const delays: number[] = [];

    await expect(
      retryTelegramCall(
        async () => {
          attempts += 1;
          const err = new Error("bad request") as Error & { error_code: number };
          err.error_code = 400;
          throw err;
        },
        {
          sleep: async (ms) => {
            delays.push(ms);
          },
          random: () => 0,
        },
      ),
    ).rejects.toThrow("bad request");

    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  it("stops after max attempts", async () => {
    let attempts = 0;
    const delays: number[] = [];

    await expect(
      retryTelegramCall(
        async () => {
          attempts += 1;
          const err = new Error("server error") as Error & { error_code: number };
          err.error_code = 500;
          throw err;
        },
        {
          maxAttempts: 3,
          sleep: async (ms) => {
            delays.push(ms);
          },
          random: () => 0,
          baseDelayMs: 100,
        },
      ),
    ).rejects.toThrow("server error");

    expect(attempts).toBe(3);
    expect(delays).toEqual([100, 200]);
  });
});
