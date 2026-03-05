import { describe, expect, it, vi } from "vitest";
import { publishLiveEvent } from "../services/live-events.js";
import { telegramService } from "../services/telegram.js";

class FakeBot {
  api = {
    createForumTopic: vi.fn(async () => ({ message_thread_id: 1000 })),
    sendMessage: vi.fn(async () => ({ message_id: 2000 })),
  };

  on = vi.fn();
  start = vi.fn(async () => undefined);
  stop = vi.fn(() => undefined);
}

function createDeps(fakeBot: FakeBot) {
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
      approve: vi.fn(async () => ({ status: "approved" })),
      reject: vi.fn(async () => ({ status: "rejected" })),
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
  } as Parameters<typeof telegramService>[1];
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("telegram status mirroring", () => {
  it("mirrors done and blocked updates to status topic", async () => {
    const fakeBot = new FakeBot();
    const svc = telegramService({} as any, createDeps(fakeBot));
    const unsubscribe = svc.subscribeToLiveEvents("company-1");

    publishLiveEvent({
      companyId: "company-1",
      type: "activity.logged",
      payload: {
        action: "issue.updated",
        entityId: "issue-1",
        details: { status: "done", identifier: "PAP-1" },
      },
    });
    publishLiveEvent({
      companyId: "company-1",
      type: "activity.logged",
      payload: {
        action: "issue.updated",
        entityId: "issue-2",
        details: { status: "blocked", identifier: "PAP-2" },
      },
    });

    await flushAsync();

    expect(fakeBot.api.sendMessage).toHaveBeenCalledTimes(2);
    expect(fakeBot.api.sendMessage).toHaveBeenNthCalledWith(
      1,
      "-100123",
      "DONE PAP-1",
      { message_thread_id: 9001 },
    );
    expect(fakeBot.api.sendMessage).toHaveBeenNthCalledWith(
      2,
      "-100123",
      "BLOCKED PAP-2",
      { message_thread_id: 9001 },
    );

    unsubscribe();
    await svc.stop();
  });

  it("ignores non-done/blocked statuses", async () => {
    const fakeBot = new FakeBot();
    const svc = telegramService({} as any, createDeps(fakeBot));
    const unsubscribe = svc.subscribeToLiveEvents("company-1");

    publishLiveEvent({
      companyId: "company-1",
      type: "activity.logged",
      payload: {
        action: "issue.updated",
        entityId: "issue-1",
        details: { status: "in_progress", identifier: "PAP-1" },
      },
    });

    await flushAsync();
    expect(fakeBot.api.sendMessage).not.toHaveBeenCalled();

    unsubscribe();
    await svc.stop();
  });

  it("deduplicates mirrored status updates for 30 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-05T00:00:00Z"));

    const fakeBot = new FakeBot();
    const svc = telegramService({} as any, createDeps(fakeBot));
    const unsubscribe = svc.subscribeToLiveEvents("company-1");

    const payload = {
      action: "issue.updated",
      entityId: "issue-1",
      details: { status: "done", identifier: "PAP-1" },
    };

    publishLiveEvent({ companyId: "company-1", type: "activity.logged", payload });
    await flushAsync();

    publishLiveEvent({ companyId: "company-1", type: "activity.logged", payload });
    await flushAsync();

    expect(fakeBot.api.sendMessage).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-03-05T00:00:31Z"));
    publishLiveEvent({ companyId: "company-1", type: "activity.logged", payload });
    await flushAsync();

    expect(fakeBot.api.sendMessage).toHaveBeenCalledTimes(2);

    unsubscribe();
    await svc.stop();
    vi.useRealTimers();
  });
});
