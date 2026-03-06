import { beforeEach, describe, expect, it, vi } from "vitest";

const { readConfigFileMock, writeConfigFileMock } = vi.hoisted(() => ({
  readConfigFileMock: vi.fn(() => ({
    $meta: {
      version: 1,
      updatedAt: "2026-03-04T21:54:41.431Z",
      source: "test",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: "/tmp/paperclip-test-db",
      embeddedPostgresPort: 54331,
    },
    logging: {
      mode: "file",
      logDir: "/tmp/paperclip-test-logs",
    },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
      tailscaleServe: false,
    },
    auth: {
      baseUrlMode: "auto",
    },
    storage: {
      provider: "local_disk",
      localDisk: {
        baseDir: "/tmp/paperclip-test-storage",
      },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: {
        keyFilePath: "/tmp/paperclip-test.key",
      },
    },
    telegram: {
      topicMapping: {},
    },
  })),
  writeConfigFileMock: vi.fn(),
}));

vi.mock("../config-file.js", () => ({
  readConfigFile: readConfigFileMock,
  writeConfigFile: writeConfigFileMock,
}));

import { telegramService } from "../services/telegram.js";

type FakeEmitInput = {
  text: string;
  chatId: string;
  topicId?: number;
  messageId?: number;
  fromIsBot?: boolean;
  fromId?: number;
  username?: string;
};

class FakeBot {
  private nextTopicId = 1000;
  private nextMessageId = 2000;
  private messageHandlers: Array<(ctx: any) => Promise<void> | void> = [];

  api = {
    createForumTopic: vi.fn(async (_chatId: string, _name: string) => ({
      message_thread_id: this.nextTopicId++,
    })),
    editForumTopic: vi.fn(async () => true),
    sendMessage: vi.fn(async (_chatId: string, _text: string, _opts?: Record<string, unknown>) => ({
      message_id: this.nextMessageId++,
    })),
  };

  on = vi.fn((filter: string, handler: (ctx: any) => Promise<void> | void) => {
    if (filter === "message:text") this.messageHandlers.push(handler);
  });

  start = vi.fn(async () => undefined);
  stop = vi.fn(() => undefined);

  async emitMessage(input: FakeEmitInput) {
    const replies: string[] = [];
    const ctx = {
      from: {
        id: input.fromId ?? 1,
        is_bot: input.fromIsBot ?? false,
        username: input.username,
      },
      message: {
        text: input.text,
        message_id: input.messageId ?? 1,
        message_thread_id: input.topicId,
        chat: { id: input.chatId },
      },
      reply: vi.fn(async (text: string) => {
        replies.push(text);
        return { message_id: this.nextMessageId++ };
      }),
    };

    for (const handler of this.messageHandlers) {
      await handler(ctx);
    }

    return { replies, ctx };
  }
}

function baseDeps(overrides?: Partial<Parameters<typeof telegramService>[1]>) {
  return {
    config: {
      telegramBotToken: "bot-token",
      telegramChatId: "-100123",
      telegramTopicMapping: {},
      telegramStatusTopicId: undefined,
      telegramApprovalsTopicId: undefined,
    },
    heartbeat: {
      wakeup: vi.fn(async () => null),
    },
    approvals: {} as any,
    issues: {
      create: vi.fn(async () => ({ id: "issue-1", identifier: "PAP-1" })),
    },
    agents: {
      list: vi.fn(async () => []),
      getById: vi.fn(async () => null),
      resolveByReference: vi.fn(async () => ({ agent: null, ambiguous: false })),
    },
    logActivityFn: vi.fn(async () => undefined),
    ...overrides,
  } as Parameters<typeof telegramService>[1];
}

describe("telegramService", () => {
  beforeEach(() => {
    readConfigFileMock.mockClear();
    writeConfigFileMock.mockClear();
  });

  it("is a no-op when telegram config is missing", async () => {
    const createBot = vi.fn(async () => new FakeBot());
    const deps = baseDeps({
      config: {
        telegramBotToken: undefined,
        telegramChatId: undefined,
        telegramTopicMapping: {},
        telegramStatusTopicId: undefined,
        telegramApprovalsTopicId: undefined,
      },
      createBot,
    });

    const svc = telegramService({} as any, deps);
    await svc.start();
    const sendResult = await svc.sendToAgentTopic({
      companyId: "company-1",
      agentId: "agent-1",
      text: "hello",
    });
    const syncResult = await svc.syncTopics("company-1");

    expect(createBot).not.toHaveBeenCalled();
    expect(sendResult).toEqual({ ok: false, error: "telegram disabled" });
    expect(syncResult).toEqual({
      statusTopicId: 0,
      approvalsTopicId: 0,
      topicMapping: {},
      createdTopics: [],
    });
  });

  it("does not crash startup on telegram polling conflict and still allows outbound sends", async () => {
    const fakeBot = new FakeBot();
    fakeBot.start = vi.fn(async () => {
      throw {
        error_code: 409,
        description:
          "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
      };
    });

    const deps = baseDeps({
      createBot: async () => fakeBot,
      companies: {
        list: vi.fn(async () => [
          {
            id: "company-1",
            name: "Acme",
            status: "active",
            createdAt: "2026-03-04T00:00:00.000Z",
          },
        ]),
        getById: vi.fn(async () => ({
          id: "company-1",
          name: "Acme",
          status: "active",
          createdAt: "2026-03-04T00:00:00.000Z",
        })),
      },
      agents: {
        list: vi.fn(async () => [
          { id: "agent-1", name: "Alice", role: "engineer", status: "idle", createdAt: "2026-03-04T01:00:00.000Z" },
        ]),
        getById: vi.fn(async (id: string) =>
          id === "agent-1" ? { id: "agent-1", companyId: "company-1", status: "idle" } : null,
        ),
        resolveByReference: vi.fn(async () => ({ agent: null, ambiguous: false })),
      } as any,
    });

    const svc = telegramService({} as any, deps);
    await expect(svc.start()).resolves.toBeUndefined();

    const sendResult = await svc.sendToAgentTopic({
      companyId: "company-1",
      agentId: "agent-1",
      text: "hello",
    });

    expect(fakeBot.start).toHaveBeenCalledTimes(1);
    expect(sendResult).toEqual({ ok: true, messageId: expect.any(Number) });
    expect(fakeBot.api.sendMessage).toHaveBeenCalledWith(
      "-100123",
      "hello",
      expect.objectContaining({ message_thread_id: expect.any(Number) }),
    );
  });

  it("syncs system topics and missing active agent topics idempotently", async () => {
    const fakeBot = new FakeBot();
    const deps = baseDeps({
      createBot: async () => fakeBot,
      companies: {
        list: vi.fn(async () => [
          {
            id: "company-1",
            name: "Acme",
            status: "active",
            createdAt: "2026-03-04T00:00:00.000Z",
          },
        ]),
        getById: vi.fn(async () => ({
          id: "company-1",
          name: "Acme",
          status: "active",
          createdAt: "2026-03-04T00:00:00.000Z",
        })),
      },
      agents: {
        list: vi.fn(async () => [
          { id: "agent-1", name: "Alice", status: "idle", createdAt: "2026-03-04T01:00:00.000Z" },
          { id: "agent-2", name: "Bob", status: "terminated", createdAt: "2026-03-04T02:00:00.000Z" },
        ]),
        getById: vi.fn(async () => null),
        resolveByReference: vi.fn(async () => ({ agent: null, ambiguous: false })),
      } as any,
    });

    const svc = telegramService({} as any, deps);
    const first = await svc.syncTopics("company-1");
    const second = await svc.syncTopics("company-1");

    expect(fakeBot.api.createForumTopic).toHaveBeenCalledTimes(3);
    expect(fakeBot.api.createForumTopic).toHaveBeenNthCalledWith(3, "-100123", "Acme / Alice");
    expect(first.statusTopicId).toBeGreaterThan(0);
    expect(first.approvalsTopicId).toBeGreaterThan(0);
    expect(first.topicMapping["agent-1"]).toBeGreaterThan(0);
    expect(first.topicMapping["agent-2"]).toBeUndefined();
    expect(first.createdTopics).toEqual([
      { agentId: "agent-1", topicId: first.topicMapping["agent-1"]! },
    ]);
    expect(fakeBot.api.editForumTopic).toHaveBeenCalledWith(
      "-100123",
      first.topicMapping["agent-1"],
      { name: "Acme / Alice" },
    );
    expect(second.createdTopics).toEqual([]);
  });

  it("provisions topics in company order on startup when no mappings exist", async () => {
    const fakeBot = new FakeBot();
    const deps = baseDeps({
      createBot: async () => fakeBot,
      companies: {
        list: vi.fn(async () => [
          {
            id: "company-1",
            name: "Evolve",
            status: "active",
            createdAt: "2026-03-05T11:21:40.182Z",
          },
          {
            id: "company-2",
            name: "Refract",
            status: "active",
            createdAt: "2026-03-04T22:11:15.017Z",
          },
        ]),
        getById: vi.fn(async (companyId: string) => {
          if (companyId === "company-1") {
            return {
              id: "company-1",
              name: "Evolve",
              status: "active",
              createdAt: "2026-03-05T11:21:40.182Z",
            };
          }
          if (companyId === "company-2") {
            return {
              id: "company-2",
              name: "Refract",
              status: "active",
              createdAt: "2026-03-04T22:11:15.017Z",
            };
          }
          return null;
        }),
      },
      agents: {
        list: vi.fn(async (companyId: string) => {
          if (companyId === "company-1") {
            return [{ id: "agent-1", name: "Alice", status: "idle", createdAt: "2026-03-05T12:00:00.000Z" }];
          }
          if (companyId === "company-2") {
            return [{ id: "agent-2", name: "Bob", status: "idle", createdAt: "2026-03-04T23:00:00.000Z" }];
          }
          return [];
        }),
        getById: vi.fn(async () => null),
        resolveByReference: vi.fn(async () => ({ agent: null, ambiguous: false })),
      } as any,
    });

    const svc = telegramService({} as any, deps);
    await svc.start();

    expect(deps.agents.list).toHaveBeenCalledWith("company-2");
    expect(deps.agents.list).toHaveBeenCalledWith("company-1");
    expect(fakeBot.api.createForumTopic).toHaveBeenCalledTimes(4);
    expect(fakeBot.api.createForumTopic).toHaveBeenNthCalledWith(3, "-100123", "Refract / Bob");
    expect(fakeBot.api.createForumTopic).toHaveBeenNthCalledWith(4, "-100123", "Evolve / Alice");
    expect(deps.config.telegramStatusTopicId).toBeGreaterThan(0);
    expect(deps.config.telegramApprovalsTopicId).toBeGreaterThan(0);
    expect(deps.config.telegramTopicMapping["agent-1"]).toBeGreaterThan(0);
    expect(deps.config.telegramTopicMapping["agent-2"]).toBeGreaterThan(0);
  });

  it("routes non-command messages in mapped topics to heartbeat wakeup", async () => {
    const fakeBot = new FakeBot();
    const wakeup = vi.fn(async () => null);
    const deps = baseDeps({
      createBot: async () => fakeBot,
      heartbeat: { wakeup },
      config: {
        telegramBotToken: "bot-token",
        telegramChatId: "-100123",
        telegramTopicMapping: { "agent-1": 5001 },
        telegramStatusTopicId: undefined,
        telegramApprovalsTopicId: undefined,
      },
    });

    const svc = telegramService({} as any, deps);
    await svc.start();
    await fakeBot.emitMessage({
      text: "please investigate this",
      chatId: "-100123",
      topicId: 5001,
      messageId: 77,
      fromId: 42,
      username: "operator",
    });

    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        source: "automation",
        reason: "telegram_message",
      }),
    );
  });

  it("handles /new in mapped topic using default topic owner", async () => {
    const fakeBot = new FakeBot();
    const issuesCreate = vi.fn(async () => ({ id: "issue-1", identifier: "PAP-47" }));
    const deps = baseDeps({
      createBot: async () => fakeBot,
      issues: { create: issuesCreate },
      agents: {
        list: vi.fn(async () => []),
        getById: vi.fn(async (id: string) =>
          id === "agent-1" ? { id: "agent-1", companyId: "company-1", status: "idle" } : null,
        ),
        resolveByReference: vi.fn(async (_companyId: string, ref: string) =>
          ref === "agent-1"
            ? { agent: { id: "agent-1", companyId: "company-1" }, ambiguous: false }
            : { agent: null, ambiguous: false },
        ),
      } as any,
      config: {
        telegramBotToken: "bot-token",
        telegramChatId: "-100123",
        telegramTopicMapping: { "agent-1": 5001 },
        telegramStatusTopicId: undefined,
        telegramApprovalsTopicId: undefined,
      },
    });

    const svc = telegramService({} as any, deps);
    await svc.start();
    const emitted = await fakeBot.emitMessage({
      text: "/new Add retry handling\nUse jitter and cap retries.",
      chatId: "-100123",
      topicId: 5001,
    });

    expect(issuesCreate).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Add retry handling",
        description: "Use jitter and cap retries.",
        assigneeAgentId: "agent-1",
        status: "todo",
      }),
    );
    expect(emitted.replies).toContain("Created PAP-47.");
  });

  it("returns usage error for /new without owner outside mapped topics", async () => {
    const fakeBot = new FakeBot();
    const issuesCreate = vi.fn(async () => ({ id: "issue-1", identifier: "PAP-47" }));
    const deps = baseDeps({
      createBot: async () => fakeBot,
      issues: { create: issuesCreate },
      config: {
        telegramBotToken: "bot-token",
        telegramChatId: "-100123",
        telegramTopicMapping: { "agent-1": 5001 },
        telegramStatusTopicId: undefined,
        telegramApprovalsTopicId: undefined,
      },
    });

    const svc = telegramService({} as any, deps);
    await svc.start();
    const emitted = await fakeBot.emitMessage({
      text: "/new Needs explicit owner",
      chatId: "-100123",
      topicId: 9999,
    });

    expect(issuesCreate).not.toHaveBeenCalled();
    expect(emitted.replies[0]).toContain("Owner is required outside an agent topic");
  });
});
