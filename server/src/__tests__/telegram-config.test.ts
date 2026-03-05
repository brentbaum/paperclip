import { describe, expect, it } from "vitest";
import { paperclipConfigSchema } from "@paperclipai/shared";

function baseConfig() {
  return {
    $meta: {
      version: 1 as const,
      updatedAt: new Date().toISOString(),
      source: "configure" as const,
    },
    database: {
      mode: "embedded-postgres" as const,
    },
    logging: {
      mode: "file" as const,
    },
    server: {
      deploymentMode: "local_trusted" as const,
      exposure: "private" as const,
    },
  };
}

describe("telegram config schema", () => {
  it("accepts config without telegram block", () => {
    const parsed = paperclipConfigSchema.parse(baseConfig());
    expect(parsed.telegram).toBeUndefined();
  });

  it("defaults topicMapping to an empty object", () => {
    const parsed = paperclipConfigSchema.parse({
      ...baseConfig(),
      telegram: {
        botToken: "token",
        chatId: "-100123",
      },
    });

    expect(parsed.telegram).toEqual({
      botToken: "token",
      chatId: "-100123",
      topicMapping: {},
    });
  });

  it("rejects invalid topic IDs", () => {
    const result = paperclipConfigSchema.safeParse({
      ...baseConfig(),
      telegram: {
        botToken: "token",
        chatId: "-100123",
        topicMapping: {
          "agent-1": 0,
        },
      },
    });

    expect(result.success).toBe(false);
  });
});
