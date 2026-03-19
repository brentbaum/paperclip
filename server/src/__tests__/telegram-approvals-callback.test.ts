import { describe, expect, it, vi } from "vitest";
import { telegramService } from "../services/telegram.js";

type CallbackInput = {
  data: string;
  chatId: string;
  messageId: number;
  callbackQueryId: string;
};

class FakeBot {
  private callbackHandlers: Array<(ctx: any) => Promise<void> | void> = [];

  api = {
    createForumTopic: vi.fn(async () => ({ message_thread_id: 1000 })),
    sendMessage: vi.fn(async () => ({ message_id: 2000 })),
    editMessageText: vi.fn(async () => ({ message_id: 2001 })),
    answerCallbackQuery: vi.fn(async () => ({ ok: true })),
  };

  on = vi.fn((filter: string, handler: (ctx: any) => Promise<void> | void) => {
    if (filter === "callback_query:data") {
      this.callbackHandlers.push(handler);
    }
  });

  start = vi.fn(async () => undefined);
  stop = vi.fn(() => undefined);

  async emitCallback(input: CallbackInput) {
    const ctx = {
      callbackQuery: {
        id: input.callbackQueryId,
        data: input.data,
        message: {
          message_id: input.messageId,
          chat: { id: input.chatId },
        },
      },
    };

    for (const handler of this.callbackHandlers) {
      await handler(ctx);
    }
  }
}

function createDeps(fakeBot: FakeBot, overrides?: Partial<Parameters<typeof telegramService>[1]>) {
  return {
    config: {
      telegramBotToken: "bot-token",
      telegramChatId: "-100123",
      telegramTopicMapping: {},
      telegramStatusTopicId: 9001,
      telegramApprovalsTopicId: 9002,
    },
    heartbeat: {
      wakeup: vi.fn(async () => null),
    },
    approvals: {
      approve: vi.fn(async () => ({ approval: { id: "approval-1", status: "approved" }, applied: true })),
      reject: vi.fn(async () => ({ approval: { id: "approval-1", status: "rejected" }, applied: true })),
      getById: vi.fn(async () => null),
    },
    issues: {
      create: vi.fn(async () => ({ id: "issue-1", identifier: "PAP-1" })),
    },
    agents: {
      list: vi.fn(async () => []),
      getById: vi.fn(async () => null),
      resolveByReference: vi.fn(async () => ({ agent: null, ambiguous: false })),
    },
    createBot: vi.fn(async () => fakeBot),
    logActivityFn: vi.fn(async () => undefined),
    ...overrides,
  } as Parameters<typeof telegramService>[1];
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("telegram approval callbacks", () => {
  it("approves using inline callback", async () => {
    const fakeBot = new FakeBot();
    const approve = vi.fn(async () => ({ approval: { id: "approval-1", status: "approved" }, applied: true }));
    const svc = telegramService(
      {} as any,
      createDeps(fakeBot, {
        approvals: {
          approve,
          reject: vi.fn(async () => ({ approval: { id: "approval-1", status: "rejected" }, applied: true })),
          getById: vi.fn(async () => null),
        },
      }),
    );

    await svc.start();
    await fakeBot.emitCallback({
      data: "pc:a:approval-1",
      chatId: "-100123",
      messageId: 777,
      callbackQueryId: "cb-1",
    });
    await flushAsync();

    expect(approve).toHaveBeenCalledWith("approval-1", "board");
    expect(fakeBot.api.editMessageText).toHaveBeenCalledWith(
      "-100123",
      777,
      "Approval approval-1: APPROVED",
      { reply_markup: { inline_keyboard: [] } },
    );
    expect(fakeBot.api.answerCallbackQuery).toHaveBeenCalledWith("cb-1", { text: "Approved" });

    await svc.stop();
  });

  it("rejects using inline callback", async () => {
    const fakeBot = new FakeBot();
    const reject = vi.fn(async () => ({ approval: { id: "approval-1", status: "rejected" }, applied: true }));
    const svc = telegramService(
      {} as any,
      createDeps(fakeBot, {
        approvals: {
          approve: vi.fn(async () => ({ approval: { id: "approval-1", status: "approved" }, applied: true })),
          reject,
          getById: vi.fn(async () => null),
        },
      }),
    );

    await svc.start();
    await fakeBot.emitCallback({
      data: "pc:r:approval-1",
      chatId: "-100123",
      messageId: 778,
      callbackQueryId: "cb-2",
    });
    await flushAsync();

    expect(reject).toHaveBeenCalledWith("approval-1", "board");
    expect(fakeBot.api.editMessageText).toHaveBeenCalledWith(
      "-100123",
      778,
      "Approval approval-1: REJECTED",
      { reply_markup: { inline_keyboard: [] } },
    );
    expect(fakeBot.api.answerCallbackQuery).toHaveBeenCalledWith("cb-2", { text: "Rejected" });

    await svc.stop();
  });

  it("is idempotent for already-resolved approvals", async () => {
    const fakeBot = new FakeBot();
    const approve = vi.fn(async () => {
      throw new Error("already resolved");
    });
    const getById = vi.fn(async () => ({ id: "approval-1", status: "approved" }));
    const svc = telegramService(
      {} as any,
      createDeps(fakeBot, {
        approvals: {
          approve,
          reject: vi.fn(async () => ({ approval: { id: "approval-1", status: "rejected" }, applied: true })),
          getById,
        },
      }),
    );

    await svc.start();
    await fakeBot.emitCallback({
      data: "pc:a:approval-1",
      chatId: "-100123",
      messageId: 779,
      callbackQueryId: "cb-3",
    });
    await flushAsync();

    expect(approve).toHaveBeenCalledWith("approval-1", "board");
    expect(getById).toHaveBeenCalledWith("approval-1");
    expect(fakeBot.api.editMessageText).toHaveBeenCalledWith(
      "-100123",
      779,
      "Approval approval-1: APPROVED (already resolved)",
      { reply_markup: { inline_keyboard: [] } },
    );
    expect(fakeBot.api.answerCallbackQuery).toHaveBeenCalledWith("cb-3", {
      text: "Already approved",
    });

    await svc.stop();
  });
});
