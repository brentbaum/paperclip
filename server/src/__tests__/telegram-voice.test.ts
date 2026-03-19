import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readConfigFileMock, writeConfigFileMock } = vi.hoisted(() => ({
  readConfigFileMock: vi.fn(() => ({
    $meta: { version: 1, updatedAt: "2026-03-04T21:54:41.431Z", source: "test" },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: "/tmp/paperclip-test-db",
      embeddedPostgresPort: 54331,
    },
    logging: { mode: "file", logDir: "/tmp/paperclip-test-logs" },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
      tailscaleServe: false,
    },
    auth: { baseUrlMode: "auto" },
    storage: { provider: "local_disk", localDisk: { baseDir: "/tmp/paperclip-test-storage" } },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: { keyFilePath: "/tmp/paperclip-test.key" },
    },
    telegram: { topicMapping: {} },
  })),
  writeConfigFileMock: vi.fn(),
}));

vi.mock("../config-file.js", () => ({
  readConfigFile: readConfigFileMock,
  writeConfigFile: writeConfigFileMock,
}));

import { telegramService } from "../services/telegram.js";
import type { SpeechToTextService } from "../services/speech-to-text.js";

type FakeVoiceEmitInput = {
  voice: {
    file_id: string;
    file_unique_id: string;
    duration: number;
    mime_type?: string;
    file_size?: number;
  };
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
  private voiceHandlers: Array<(ctx: any) => Promise<void> | void> = [];

  api = {
    createForumTopic: vi.fn(async (_chatId: string, _name: string) => ({
      message_thread_id: this.nextTopicId++,
    })),
    editForumTopic: vi.fn(async () => true),
    sendChatAction: vi.fn(async () => true),
    sendMessage: vi.fn(
      async (_chatId: string, _text: string, _opts?: Record<string, unknown>) => ({
        message_id: this.nextMessageId++,
      }),
    ),
    getFile: vi.fn(async (_fileId: string) => ({
      file_path: "voice/file_123.ogg",
    })),
  };

  on = vi.fn((filter: string, handler: (ctx: any) => Promise<void> | void) => {
    if (filter === "message:text") this.messageHandlers.push(handler);
    if (filter === "message:voice") this.voiceHandlers.push(handler);
  });

  start = vi.fn(async () => undefined);
  stop = vi.fn(() => undefined);

  async emitVoiceMessage(input: FakeVoiceEmitInput) {
    const replies: string[] = [];
    const ctx = {
      from: {
        id: input.fromId ?? 1,
        is_bot: input.fromIsBot ?? false,
        username: input.username,
      },
      message: {
        voice: input.voice,
        message_id: input.messageId ?? 1,
        message_thread_id: input.topicId,
        chat: { id: input.chatId },
      },
      reply: vi.fn(async (text: string) => {
        replies.push(text);
        return { message_id: this.nextMessageId++ };
      }),
    };

    for (const handler of this.voiceHandlers) {
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
      telegramTopicMapping: { "agent-1": 42 },
      telegramStatusTopicId: undefined,
      telegramApprovalsTopicId: undefined,
    },
    heartbeat: {
      wakeup: vi.fn(async () => ({ id: "run-1", status: "running" })),
      getRun: vi.fn(async () => null),
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

const voiceMsg: FakeVoiceEmitInput["voice"] = {
  file_id: "AgACAgIAAxkBAAI",
  file_unique_id: "unique123",
  duration: 5,
  mime_type: "audio/ogg",
  file_size: 12345,
};

describe("telegram voice message handling", () => {
  beforeEach(() => {
    readConfigFileMock.mockClear();
    writeConfigFileMock.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(100),
      })),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("registers message:voice handler on start", async () => {
    const fakeBot = new FakeBot();
    const svc = telegramService(
      {} as any,
      baseDeps({ createBot: async () => fakeBot }),
    );
    await svc.start();

    expect(fakeBot.on).toHaveBeenCalledWith("message:voice", expect.any(Function));
  });

  it("transcribes voice and wakes agent with transcribed text", async () => {
    const fakeBot = new FakeBot();
    const mockStt: SpeechToTextService = {
      transcribe: vi.fn(async () => ({ text: "hello from voice" })),
    };
    const wakeup = vi.fn(async () => ({ id: "run-1", status: "running" }));

    const svc = telegramService(
      {} as any,
      baseDeps({
        createBot: async () => fakeBot,
        stt: mockStt,
        heartbeat: { wakeup, getRun: vi.fn(async () => null) },
      }),
    );
    await svc.start();

    await fakeBot.emitVoiceMessage({
      voice: voiceMsg,
      chatId: "-100123",
      topicId: 42,
      messageId: 10,
      username: "testuser",
    });

    expect(fakeBot.api.getFile).toHaveBeenCalledWith("AgACAgIAAxkBAAI");
    expect(mockStt.transcribe).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        reason: "telegram_message",
        payload: expect.objectContaining({
          text: "hello from voice",
          isVoiceMessage: true,
          voiceDurationSec: 5,
          voiceFileId: "AgACAgIAAxkBAAI",
          topicId: 42,
        }),
      }),
    );
  });

  it("sends fallback text when STT service is not configured", async () => {
    const fakeBot = new FakeBot();
    const wakeup = vi.fn(async () => ({ id: "run-1", status: "running" }));

    const svc = telegramService(
      {} as any,
      baseDeps({
        createBot: async () => fakeBot,
        heartbeat: { wakeup, getRun: vi.fn(async () => null) },
      }),
    );
    await svc.start();

    await fakeBot.emitVoiceMessage({
      voice: voiceMsg,
      chatId: "-100123",
      topicId: 42,
    });

    expect(wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          text: "[Voice message — transcription unavailable]",
          isVoiceMessage: true,
        }),
      }),
    );
  });

  it("sends fallback text when transcription returns empty", async () => {
    const fakeBot = new FakeBot();
    const mockStt: SpeechToTextService = {
      transcribe: vi.fn(async () => ({ text: "" })),
    };
    const wakeup = vi.fn(async () => ({ id: "run-1", status: "running" }));

    const svc = telegramService(
      {} as any,
      baseDeps({
        createBot: async () => fakeBot,
        stt: mockStt,
        heartbeat: { wakeup, getRun: vi.fn(async () => null) },
      }),
    );
    await svc.start();

    await fakeBot.emitVoiceMessage({
      voice: voiceMsg,
      chatId: "-100123",
      topicId: 42,
    });

    expect(wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          text: "[Voice message — transcription unavailable]",
        }),
      }),
    );
  });

  it("skips voice messages from bots", async () => {
    const fakeBot = new FakeBot();
    const wakeup = vi.fn(async () => null);

    const svc = telegramService(
      {} as any,
      baseDeps({
        createBot: async () => fakeBot,
        heartbeat: { wakeup, getRun: vi.fn(async () => null) },
      }),
    );
    await svc.start();

    await fakeBot.emitVoiceMessage({
      voice: voiceMsg,
      chatId: "-100123",
      topicId: 42,
      fromIsBot: true,
    });

    expect(wakeup).not.toHaveBeenCalled();
  });

  it("skips voice messages from wrong chat", async () => {
    const fakeBot = new FakeBot();
    const wakeup = vi.fn(async () => null);

    const svc = telegramService(
      {} as any,
      baseDeps({
        createBot: async () => fakeBot,
        heartbeat: { wakeup, getRun: vi.fn(async () => null) },
      }),
    );
    await svc.start();

    await fakeBot.emitVoiceMessage({
      voice: voiceMsg,
      chatId: "-999",
      topicId: 42,
    });

    expect(wakeup).not.toHaveBeenCalled();
  });

  it("skips voice messages without a topic", async () => {
    const fakeBot = new FakeBot();
    const wakeup = vi.fn(async () => null);

    const svc = telegramService(
      {} as any,
      baseDeps({
        createBot: async () => fakeBot,
        heartbeat: { wakeup, getRun: vi.fn(async () => null) },
      }),
    );
    await svc.start();

    await fakeBot.emitVoiceMessage({
      voice: voiceMsg,
      chatId: "-100123",
    });

    expect(wakeup).not.toHaveBeenCalled();
  });

  it("includes idempotency key based on message ID", async () => {
    const fakeBot = new FakeBot();
    const wakeup = vi.fn(async () => ({ id: "run-1", status: "running" }));

    const svc = telegramService(
      {} as any,
      baseDeps({
        createBot: async () => fakeBot,
        heartbeat: { wakeup, getRun: vi.fn(async () => null) },
      }),
    );
    await svc.start();

    await fakeBot.emitVoiceMessage({
      voice: voiceMsg,
      chatId: "-100123",
      topicId: 42,
      messageId: 777,
    });

    expect(wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        idempotencyKey: "telegram:-100123:42:777",
      }),
    );
  });
});
