import { describe, expect, it } from "vitest";
import {
  asString,
  asNumber,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";

/**
 * Tests for the telegram wake context flow.
 *
 * When a telegram message triggers an agent wakeup, the heartbeat service
 * enriches the context snapshot with a `paperclipTelegram` object and
 * `paperclipTools.telegram` metadata. Each adapter then:
 *
 * 1. Reads `context.paperclipTelegram` to extract telegram fields
 * 2. Sets PAPERCLIP_TELEGRAM_* env vars for the agent process
 * 3. Builds a prompt preamble via `buildTelegramWakePrompt` so the agent
 *    knows about the incoming message and the reply endpoint
 *
 * These tests verify the adapter-side contract by reimplementing the same
 * `buildTelegramWakePrompt` logic used across all local adapters.
 */

// Reimplementation of the adapter function for testing
function buildTelegramWakePrompt(context: Record<string, unknown>, agentId: string) {
  const wakeReason = asString(context.wakeReason, "").trim();
  const telegramContext = parseObject(context.paperclipTelegram);
  const tools = parseObject(context.paperclipTools);
  const telegramTool = parseObject(tools.telegram);
  const messageText = asString(telegramContext.messageText, "").trim();
  if (wakeReason !== "telegram_message" || messageText.length === 0) return "";

  const chatId = asString(telegramContext.chatId, "").trim();
  const topicId = Math.floor(asNumber(telegramContext.topicId, 0));
  const username = asString(telegramContext.username, "").trim();
  const userId = Math.floor(asNumber(telegramContext.userId, 0));
  const sendEndpoint = asString(telegramTool.sendEndpoint, "/api/agent-tools/telegram/send").trim();
  const senderLabel =
    username.length > 0 ? `@${username}` : userId > 0 ? `user ${userId}` : "the operator";
  const location = [
    chatId.length > 0 ? `chat ${chatId}` : null,
    topicId > 0 ? `topic ${topicId}` : null,
  ].filter(Boolean).join(", ");

  return [
    "Telegram wake context:",
    `- From: ${senderLabel}${location ? ` in ${location}` : ""}`,
    `- Message: ${JSON.stringify(messageText)}`,
    "",
    "Before you end this run, you must send a reply back to Telegram.",
    `Use POST ${sendEndpoint} with JSON like {\"agentId\":\"${agentId}\",\"text\":\"your reply\"}.`,
    "If no issue work is required, send a concise acknowledgement and stop. Do not only write an internal status update.",
    "",
  ].join("\n");
}

// Helper: simulates what enrichWakeContextSnapshot does for telegram payloads
function simulateEnrichment(payload: Record<string, unknown>) {
  const contextSnapshot: Record<string, unknown> = {};
  const text = typeof payload.text === "string" && payload.text.trim().length > 0 ? payload.text : null;
  const chatId = typeof payload.chatId === "string" && payload.chatId.trim().length > 0 ? payload.chatId : null;
  const topicId = typeof payload.topicId === "number" && Number.isFinite(payload.topicId) ? payload.topicId : null;
  const messageId = typeof payload.messageId === "number" && Number.isFinite(payload.messageId) ? payload.messageId : null;
  const telegramUserId = typeof payload.telegramUserId === "number" && Number.isFinite(payload.telegramUserId) ? payload.telegramUserId : null;
  const telegramUsername = typeof payload.telegramUsername === "string" && payload.telegramUsername.trim().length > 0 ? payload.telegramUsername : null;

  if (text) contextSnapshot.wakeMessage = text;
  contextSnapshot.wakeReason = "telegram_message";

  if (text || chatId || topicId !== null || messageId !== null || telegramUserId !== null || telegramUsername) {
    contextSnapshot.paperclipTelegram = {
      ...(text ? { messageText: text } : {}),
      ...(chatId ? { chatId } : {}),
      ...(topicId !== null ? { topicId } : {}),
      ...(messageId !== null ? { messageId } : {}),
      ...(telegramUserId !== null ? { userId: telegramUserId } : {}),
      ...(telegramUsername ? { username: telegramUsername } : {}),
    };
  }

  return contextSnapshot;
}

// Helper: simulates what the heartbeat does before adapter.execute
function simulateToolsInjection(context: Record<string, unknown>, agentId: string) {
  context.paperclipTools = {
    ...((context.paperclipTools as Record<string, unknown> | undefined) ?? {}),
    telegram: {
      sendEndpoint: "/api/agent-tools/telegram/send",
      defaultAgentId: agentId,
      supportsStatusFlags: true,
    },
  };
  return context;
}

// Helper: simulates what adapters do to extract telegram env vars
function simulateAdapterEnvExtraction(context: Record<string, unknown>) {
  const telegramContext = parseObject(context.paperclipTelegram);
  const env: Record<string, string> = {};
  const messageText = asString(telegramContext.messageText, "");
  const chatId = asString(telegramContext.chatId, "");
  const topicId = Math.floor(asNumber(telegramContext.topicId, 0));
  const messageId = Math.floor(asNumber(telegramContext.messageId, 0));
  const userId = Math.floor(asNumber(telegramContext.userId, 0));
  const username = asString(telegramContext.username, "");

  if (messageText) env.PAPERCLIP_TELEGRAM_MESSAGE_TEXT = messageText;
  if (chatId) env.PAPERCLIP_TELEGRAM_CHAT_ID = chatId;
  if (topicId > 0) env.PAPERCLIP_TELEGRAM_TOPIC_ID = String(topicId);
  if (messageId > 0) env.PAPERCLIP_TELEGRAM_MESSAGE_ID = String(messageId);
  if (userId > 0) env.PAPERCLIP_TELEGRAM_USER_ID = String(userId);
  if (username) env.PAPERCLIP_TELEGRAM_USERNAME = username;

  return env;
}

describe("telegram wake context flow", () => {
  const samplePayload = {
    text: "Create a ticket assigned to the CEO to get me a haircut",
    chatId: "-100123",
    topicId: 5001,
    messageId: 99,
    telegramUserId: 42,
    telegramUsername: "operator",
  };

  describe("enrichWakeContextSnapshot (contract)", () => {
    it("builds paperclipTelegram with all fields from a telegram wakeup payload", () => {
      const context = simulateEnrichment(samplePayload);
      expect(context.paperclipTelegram).toEqual({
        messageText: "Create a ticket assigned to the CEO to get me a haircut",
        chatId: "-100123",
        topicId: 5001,
        messageId: 99,
        userId: 42,
        username: "operator",
      });
      expect(context.wakeMessage).toBe("Create a ticket assigned to the CEO to get me a haircut");
      expect(context.wakeReason).toBe("telegram_message");
    });

    it("omits null/empty fields from paperclipTelegram", () => {
      const context = simulateEnrichment({
        text: "hello",
        chatId: "-100123",
        topicId: null,
        messageId: null,
        telegramUserId: null,
        telegramUsername: null,
      });
      expect(context.paperclipTelegram).toEqual({
        messageText: "hello",
        chatId: "-100123",
      });
    });

    it("does not create paperclipTelegram when payload has no telegram data", () => {
      const context = simulateEnrichment({
        issueId: "some-issue-id",
      });
      expect(context.paperclipTelegram).toBeUndefined();
    });
  });

  describe("paperclipTools injection", () => {
    it("injects telegram tool metadata into context before adapter execution", () => {
      const context = simulateEnrichment(samplePayload);
      simulateToolsInjection(context, "agent-42");
      const tools = parseObject(context.paperclipTools);
      const telegram = parseObject(tools.telegram);
      expect(telegram).toEqual({
        sendEndpoint: "/api/agent-tools/telegram/send",
        defaultAgentId: "agent-42",
        supportsStatusFlags: true,
      });
    });
  });

  describe("adapter env var extraction", () => {
    it("extracts all PAPERCLIP_TELEGRAM_* env vars from enriched context", () => {
      const context = simulateEnrichment(samplePayload);
      const env = simulateAdapterEnvExtraction(context);
      expect(env).toEqual({
        PAPERCLIP_TELEGRAM_MESSAGE_TEXT: "Create a ticket assigned to the CEO to get me a haircut",
        PAPERCLIP_TELEGRAM_CHAT_ID: "-100123",
        PAPERCLIP_TELEGRAM_TOPIC_ID: "5001",
        PAPERCLIP_TELEGRAM_MESSAGE_ID: "99",
        PAPERCLIP_TELEGRAM_USER_ID: "42",
        PAPERCLIP_TELEGRAM_USERNAME: "operator",
      });
    });

    it("omits env vars for missing telegram fields", () => {
      const context = simulateEnrichment({
        text: "hello",
        chatId: "-100123",
        topicId: null,
        messageId: null,
        telegramUserId: null,
        telegramUsername: null,
      });
      const env = simulateAdapterEnvExtraction(context);
      expect(env).toEqual({
        PAPERCLIP_TELEGRAM_MESSAGE_TEXT: "hello",
        PAPERCLIP_TELEGRAM_CHAT_ID: "-100123",
      });
      expect(env.PAPERCLIP_TELEGRAM_TOPIC_ID).toBeUndefined();
      expect(env.PAPERCLIP_TELEGRAM_USER_ID).toBeUndefined();
    });
  });

  describe("buildTelegramWakePrompt", () => {
    it("returns empty string for non-telegram wake reasons", () => {
      const context = {
        wakeReason: "issue_comment_mentioned",
        paperclipTelegram: { messageText: "hello" },
      };
      expect(buildTelegramWakePrompt(context, "agent-1")).toBe("");
    });

    it("returns empty string when messageText is empty", () => {
      const context = {
        wakeReason: "telegram_message",
        paperclipTelegram: { messageText: "" },
      };
      expect(buildTelegramWakePrompt(context, "agent-1")).toBe("");
    });

    it("builds a prompt with sender, message, and reply instructions", () => {
      const context = simulateEnrichment(samplePayload);
      simulateToolsInjection(context, "agent-42");
      const prompt = buildTelegramWakePrompt(context, "agent-42");

      expect(prompt).toContain("Telegram wake context:");
      expect(prompt).toContain("@operator");
      expect(prompt).toContain("chat -100123");
      expect(prompt).toContain("topic 5001");
      expect(prompt).toContain("Create a ticket assigned to the CEO to get me a haircut");
      expect(prompt).toContain("POST /api/agent-tools/telegram/send");
      expect(prompt).toContain('"agentId":"agent-42"');
      expect(prompt).toContain("send a reply back to Telegram");
    });

    it("falls back to user ID when username is missing", () => {
      const context: Record<string, unknown> = {
        wakeReason: "telegram_message",
        paperclipTelegram: {
          messageText: "hello",
          chatId: "-100123",
          topicId: 5001,
          userId: 42,
        },
        paperclipTools: {
          telegram: { sendEndpoint: "/api/agent-tools/telegram/send" },
        },
      };
      const prompt = buildTelegramWakePrompt(context, "agent-1");
      expect(prompt).toContain("user 42");
      expect(prompt).not.toContain("@");
    });

    it("falls back to 'the operator' when both username and userId are missing", () => {
      const context: Record<string, unknown> = {
        wakeReason: "telegram_message",
        paperclipTelegram: {
          messageText: "hello",
        },
        paperclipTools: {
          telegram: { sendEndpoint: "/api/agent-tools/telegram/send" },
        },
      };
      const prompt = buildTelegramWakePrompt(context, "agent-1");
      expect(prompt).toContain("the operator");
    });
  });

  describe("coalescing: telegram wakes must not merge into running runs", () => {
    /**
     * Reproduces the bug where a telegram message wake with no issueId
     * yields a null taskKey. Because isSameTaskScope(null, null) === true,
     * the wake coalesced into an already-running run. The running adapter
     * had already received its context so the agent never saw the telegram
     * prompt and never replied.
     *
     * The fix: telegram_message wakes skip coalescing into running runs
     * (same treatment as comment wakes).
     */

    // Reimplementation of the coalescing decision from heartbeat.ts
    function shouldCoalesceIntoRunning(opts: {
      reason: string | null;
      wakeCommentId: string | null;
      taskKey: string | null;
      sameScopeRunningRunExists: boolean;
      sameScopeQueuedRunExists: boolean;
    }) {
      const shouldQueueFollowupForCommentWake =
        Boolean(opts.wakeCommentId) && opts.sameScopeRunningRunExists && !opts.sameScopeQueuedRunExists;
      const shouldQueueFollowupForTelegramWake =
        opts.reason === "telegram_message" && opts.sameScopeRunningRunExists && !opts.sameScopeQueuedRunExists;

      // coalescedTargetRun logic: queued first, then running (unless skipped)
      if (opts.sameScopeQueuedRunExists) return "queued";
      if (shouldQueueFollowupForCommentWake || shouldQueueFollowupForTelegramWake) return null;
      if (opts.sameScopeRunningRunExists) return "running";
      return null;
    }

    it("telegram_message wakes are NOT coalesced into a running run", () => {
      const result = shouldCoalesceIntoRunning({
        reason: "telegram_message",
        wakeCommentId: null,
        taskKey: null,
        sameScopeRunningRunExists: true,
        sameScopeQueuedRunExists: false,
      });
      expect(result).toBeNull(); // should queue a new run, not coalesce
    });

    it("telegram_message wakes CAN coalesce into a queued run (not yet started)", () => {
      const result = shouldCoalesceIntoRunning({
        reason: "telegram_message",
        wakeCommentId: null,
        taskKey: null,
        sameScopeRunningRunExists: true,
        sameScopeQueuedRunExists: true,
      });
      expect(result).toBe("queued"); // fine to merge into queued (hasn't read context yet)
    });

    it("comment wakes are still NOT coalesced into running runs (existing behavior)", () => {
      const result = shouldCoalesceIntoRunning({
        reason: "issue_comment_mentioned",
        wakeCommentId: "comment-1",
        taskKey: null,
        sameScopeRunningRunExists: true,
        sameScopeQueuedRunExists: false,
      });
      expect(result).toBeNull();
    });

    it("normal wakes with null taskKey still coalesce into running runs", () => {
      const result = shouldCoalesceIntoRunning({
        reason: "issue_assigned",
        wakeCommentId: null,
        taskKey: null,
        sameScopeRunningRunExists: true,
        sameScopeQueuedRunExists: false,
      });
      expect(result).toBe("running"); // normal behavior preserved
    });
  });

  describe("end-to-end contract: telegram message → enriched context → adapter prompt", () => {
    it("full flow produces correct context, env vars, and prompt for a typical telegram message", () => {
      // Step 1: Telegram service calls heartbeat.wakeup with this payload
      const payload = {
        text: "Create a ticket assigned to the CEO to get me a haircut",
        chatId: "-100123",
        topicId: 5001,
        messageId: 99,
        telegramUserId: 42,
        telegramUsername: "operator",
      };

      // Step 2: enrichWakeContextSnapshot builds the context
      const context = simulateEnrichment(payload);
      expect(context.paperclipTelegram).toBeDefined();
      expect(context.wakeMessage).toBe(payload.text);

      // Step 3: heartbeat injects tools before adapter execution
      simulateToolsInjection(context, "agent-42");

      // Step 4: Adapter extracts env vars
      const env = simulateAdapterEnvExtraction(context);
      expect(env.PAPERCLIP_TELEGRAM_MESSAGE_TEXT).toBe(payload.text);
      expect(env.PAPERCLIP_TELEGRAM_CHAT_ID).toBe("-100123");
      expect(env.PAPERCLIP_TELEGRAM_TOPIC_ID).toBe("5001");
      expect(env.PAPERCLIP_TELEGRAM_USERNAME).toBe("operator");

      // Step 5: Adapter builds telegram wake prompt
      const prompt = buildTelegramWakePrompt(context, "agent-42");
      expect(prompt.length).toBeGreaterThan(0);
      expect(prompt).toContain(payload.text);
      expect(prompt).toContain("@operator");
      expect(prompt).toContain("/api/agent-tools/telegram/send");
    });
  });
});
