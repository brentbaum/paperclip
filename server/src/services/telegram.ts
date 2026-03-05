import type { Db } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { agentService } from "./agents.js";
import type { approvalService } from "./approvals.js";
import type { issueService } from "./issues.js";
import type { heartbeatService } from "./heartbeat.js";
import { logActivity, type LogActivityInput } from "./activity-log.js";
import { subscribeCompanyLiveEvents } from "./live-events.js";
import { parseNewCommand } from "./telegram-new-parser.js";

type AgentService = ReturnType<typeof agentService>;
type IssueService = ReturnType<typeof issueService>;
type ApprovalService = ReturnType<typeof approvalService>;
type HeartbeatService = ReturnType<typeof heartbeatService>;

type TelegramTopicMapping = Record<string, number>;

interface TelegramConfigView {
  telegramBotToken: string | undefined;
  telegramChatId: string | undefined;
  telegramTopicMapping: TelegramTopicMapping;
  telegramStatusTopicId: number | undefined;
  telegramApprovalsTopicId: number | undefined;
}

interface TelegramMessageContextLike {
  from?: { id?: number; is_bot?: boolean; username?: string } | null;
  message?:
    | {
      text?: string;
      message_id?: number;
      message_thread_id?: number;
      chat?: { id?: string | number } | null;
    }
    | null;
  chat?: { id?: string | number } | null;
  reply(text: string, other?: Record<string, unknown>): Promise<{ message_id: number }>;
}

interface TelegramCallbackContextLike {
  callbackQuery?: {
    id?: string;
    data?: string;
    message?: {
      message_id?: number;
      message_thread_id?: number;
      chat?: { id?: string | number } | null;
    } | null;
  } | null;
  answerCallbackQuery?: (options?: Record<string, unknown>) => Promise<unknown>;
}

interface TelegramBotLike {
  api: {
    createForumTopic(chatId: string, name: string): Promise<{ message_thread_id: number }>;
    sendMessage(
      chatId: string,
      text: string,
      options?: Record<string, unknown>,
    ): Promise<{ message_id: number }>;
    editMessageText?(
      chatId: string,
      messageId: number,
      text: string,
      options?: Record<string, unknown>,
    ): Promise<{ message_id: number }>;
    answerCallbackQuery?(
      callbackQueryId: string,
      options?: Record<string, unknown>,
    ): Promise<unknown>;
  };
  on(filter: string, handler: (ctx: any) => Promise<void> | void): void;
  start(options?: Record<string, unknown>): Promise<void>;
  stop(): void;
}

interface TelegramServiceDeps {
  config: TelegramConfigView;
  heartbeat: Pick<HeartbeatService, "wakeup">;
  approvals: Pick<ApprovalService, "approve" | "reject" | "getById">;
  issues: Pick<IssueService, "create">;
  agents: Pick<AgentService, "list" | "getById" | "resolveByReference">;
  createBot?: (token: string) => TelegramBotLike | Promise<TelegramBotLike>;
  logActivityFn?: (db: Db, input: LogActivityInput) => Promise<void>;
}

type SendToAgentTopicInput = {
  companyId: string;
  agentId: string;
  text: string;
  idempotencyKey?: string;
  mirrorStatus?: "done" | "blocked" | null;
  issueId?: string | null;
};

type SendApprovalRequestInput = {
  id: string;
  type: string;
  status: string;
  requestedByAgentId?: string | null;
  requestedByUserId?: string | null;
};

type SyncTopicsResult = {
  statusTopicId: number;
  approvalsTopicId: number;
  topicMapping: Record<string, number>;
  createdTopics: Array<{ agentId: string; topicId: number }>;
};

type SendTelegramResult =
  | { ok: true; messageId: number }
  | { ok: false; error: string };

type RetryTelegramCallOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

const STATUS_MIRROR_DEDUP_TTL_MS = 30_000;
const MAX_CALLBACK_DATA_BYTES = 64;
const TELEGRAM_MAX_RETRY_ATTEMPTS = 3;
const TELEGRAM_RETRY_BASE_DELAY_MS = 250;

const importDynamic = new Function(
  "moduleName",
  "return import(moduleName);",
) as (moduleName: string) => Promise<Record<string, unknown>>;

function asNonEmptyString(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseChatId(value: string | undefined): string | null {
  return asNonEmptyString(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function formatTopicReplyOptions(topicId: number | null): Record<string, unknown> | undefined {
  if (!topicId) return undefined;
  return { message_thread_id: topicId };
}

function readTelegramStatusCode(err: unknown): number | null {
  const asObj = asRecord(err);
  const direct = asObj.error_code;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;

  const status = asObj.status;
  if (typeof status === "number" && Number.isFinite(status)) return status;

  const statusCode = asObj.statusCode;
  if (typeof statusCode === "number" && Number.isFinite(statusCode)) return statusCode;

  const response = asRecord(asObj.response);
  const responseStatus = response.status;
  if (typeof responseStatus === "number" && Number.isFinite(responseStatus)) return responseStatus;

  return null;
}

function readRetryAfterSeconds(err: unknown): number | null {
  const asObj = asRecord(err);
  const parameters = asRecord(asObj.parameters);
  const retryAfter = parameters.retry_after;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return retryAfter;
  }

  const response = asRecord(asObj.response);
  const responseParameters = asRecord(asRecord(response.data).parameters);
  const responseRetryAfter = responseParameters.retry_after;
  if (
    typeof responseRetryAfter === "number" &&
    Number.isFinite(responseRetryAfter) &&
    responseRetryAfter >= 0
  ) {
    return responseRetryAfter;
  }

  return null;
}

function isNetworkError(err: unknown): boolean {
  const asObj = asRecord(err);
  const code = asObj.code;
  if (typeof code === "string") {
    if (
      code === "ETIMEDOUT" ||
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "EAI_AGAIN" ||
      code === "ENOTFOUND" ||
      code === "UND_ERR_CONNECT_TIMEOUT"
    ) {
      return true;
    }
  }

  if (err instanceof Error) {
    const message = err.message.toLowerCase();
    if (message.includes("network") || message.includes("fetch failed") || message.includes("socket")) {
      return true;
    }
  }

  return false;
}

function isRetryableTelegramError(err: unknown): boolean {
  const statusCode = readTelegramStatusCode(err);
  if (statusCode === null) return isNetworkError(err);
  if (statusCode === 429) return true;
  if (statusCode >= 500) return true;
  if (statusCode === 400 || statusCode === 401 || statusCode === 403 || statusCode === 404) return false;
  if (statusCode >= 400 && statusCode < 500) return false;
  return isNetworkError(err);
}

async function defaultSleep(ms: number) {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function retryTelegramCall<T>(
  fn: () => Promise<T>,
  options: RetryTelegramCallOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? TELEGRAM_MAX_RETRY_ATTEMPTS);
  const baseDelayMs = Math.max(1, options.baseDelayMs ?? TELEGRAM_RETRY_BASE_DELAY_MS);
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      const shouldRetry = attempt < maxAttempts && isRetryableTelegramError(err);
      if (!shouldRetry) throw err;

      const retryAfterSeconds = readRetryAfterSeconds(err);
      const jitterMultiplier = 1 + random();
      const exponentialBackoffMs = Math.round(baseDelayMs * 2 ** (attempt - 1) * jitterMultiplier);
      const delayMs =
        retryAfterSeconds !== null
          ? Math.max(0, Math.round(retryAfterSeconds * 1000))
          : exponentialBackoffMs;

      await sleep(delayMs);
    }
  }

  throw new Error("unreachable");
}

function callbackData(action: "a" | "r", approvalId: string) {
  const value = `pc:${action}:${approvalId}`;
  if (Buffer.byteLength(value, "utf8") > MAX_CALLBACK_DATA_BYTES) {
    throw new Error("approval callback data exceeds telegram limit");
  }
  return value;
}

function parseApprovalCallbackData(rawData: string | undefined): { action: "a" | "r"; approvalId: string } | null {
  if (!rawData) return null;
  const parts = rawData.split(":");
  if (parts.length !== 3) return null;
  if (parts[0] !== "pc") return null;
  if (parts[1] !== "a" && parts[1] !== "r") return null;
  if (!parts[2]) return null;
  return { action: parts[1], approvalId: parts[2] };
}

function formatApprovalRequestMessage(approval: SendApprovalRequestInput) {
  const requester =
    approval.requestedByAgentId
      ? `agent:${approval.requestedByAgentId}`
      : approval.requestedByUserId
        ? `user:${approval.requestedByUserId}`
        : "unknown";
  return [
    `Approval ${approval.id}`,
    `Type: ${approval.type}`,
    `Requester: ${requester}`,
    `Status: ${approval.status}`,
  ].join("\n");
}

function formatApprovalResolvedMessage(
  approvalId: string,
  status: "approved" | "rejected",
  idempotent: boolean,
) {
  const suffix = idempotent ? " (already resolved)" : "";
  return `Approval ${approvalId}: ${status.toUpperCase()}${suffix}`;
}

function statusMirrorLine(input: { status: "done" | "blocked"; identifier: string }) {
  return `${input.status.toUpperCase()} ${input.identifier}`;
}

async function defaultCreateBot(token: string): Promise<TelegramBotLike> {
  const mod = await importDynamic("grammy");
  const BotCtor = mod.Bot as (new (botToken: string) => TelegramBotLike) | undefined;
  if (!BotCtor) {
    throw new Error("grammy Bot export not found");
  }
  return new BotCtor(token);
}

export function telegramService(db: Db, deps: TelegramServiceDeps) {
  let bot: TelegramBotLike | null = null;
  let handlersRegistered = false;
  let started = false;
  let startPromise: Promise<void> | null = null;
  const liveEventUnsubscribers = new Map<string, () => void>();
  const statusMirrorDedupUntil = new Map<string, number>();

  const createBot = deps.createBot ?? defaultCreateBot;
  const logActivityFn = deps.logActivityFn ?? logActivity;

  function getBotToken() {
    return asNonEmptyString(deps.config.telegramBotToken);
  }

  function getChatId() {
    return parseChatId(deps.config.telegramChatId);
  }

  function isEnabled() {
    return Boolean(getBotToken() && getChatId());
  }

  function reverseTopicMapping(): Map<number, string> {
    const reverse = new Map<number, string>();
    for (const [agentId, topicId] of Object.entries(deps.config.telegramTopicMapping ?? {})) {
      if (Number.isInteger(topicId) && topicId > 0) {
        reverse.set(topicId, agentId);
      }
    }
    return reverse;
  }

  function pruneStatusMirrorDedup(now = Date.now()) {
    for (const [key, expiresAt] of statusMirrorDedupUntil.entries()) {
      if (expiresAt <= now) statusMirrorDedupUntil.delete(key);
    }
  }

  function shouldMirrorStatus(dedupeKey: string) {
    const now = Date.now();
    pruneStatusMirrorDedup(now);
    const existingExpiry = statusMirrorDedupUntil.get(dedupeKey);
    if (existingExpiry && existingExpiry > now) return false;
    statusMirrorDedupUntil.set(dedupeKey, now + STATUS_MIRROR_DEDUP_TTL_MS);
    return true;
  }

  function parseStatusMirrorEvent(event: LiveEvent): {
    issueId: string;
    identifier: string;
    status: "done" | "blocked";
  } | null {
    if (event.type !== "activity.logged") return null;
    const payload = asRecord(event.payload);
    if (payload.action !== "issue.updated") return null;

    const issueId = typeof payload.entityId === "string" ? payload.entityId : null;
    if (!issueId) return null;

    const details = asRecord(payload.details);
    const rawStatus = typeof details.status === "string" ? details.status.toLowerCase() : null;
    if (rawStatus !== "done" && rawStatus !== "blocked") return null;

    const identifier =
      typeof details.identifier === "string" && details.identifier.trim().length > 0
        ? details.identifier
        : issueId;

    return {
      issueId,
      identifier,
      status: rawStatus,
    };
  }

  async function resolveCompanyIdFromMappedAgent(mappedAgentId: string | null): Promise<string | null> {
    if (mappedAgentId) {
      const mapped = await deps.agents.getById(mappedAgentId);
      if (mapped) return mapped.companyId;
    }
    for (const agentId of Object.keys(deps.config.telegramTopicMapping)) {
      const mapped = await deps.agents.getById(agentId);
      if (mapped) return mapped.companyId;
    }
    return null;
  }

  async function ensureBot(): Promise<TelegramBotLike | null> {
    if (!isEnabled()) return null;
    if (bot) return bot;
    const token = getBotToken();
    if (!token) return null;
    bot = await createBot(token);
    return bot;
  }

  async function ensureStatusTopic(companyId: string): Promise<number | null> {
    if (deps.config.telegramStatusTopicId) return deps.config.telegramStatusTopicId;
    const syncResult = await syncTopics(companyId);
    return syncResult.statusTopicId || null;
  }

  async function ensureApprovalsTopic(companyId: string): Promise<number | null> {
    if (deps.config.telegramApprovalsTopicId) return deps.config.telegramApprovalsTopicId;
    const syncResult = await syncTopics(companyId);
    return syncResult.approvalsTopicId || null;
  }

  async function sendStatusMirror(input: {
    companyId: string;
    issueId: string;
    identifier: string;
    status: "done" | "blocked";
  }) {
    if (!isEnabled()) return;

    const dedupeKey = `${input.companyId}:${input.issueId}:${input.status}`;
    if (!shouldMirrorStatus(dedupeKey)) return;

    const chatId = getChatId();
    const activeBot = await ensureBot();
    if (!chatId || !activeBot) return;

    const statusTopicId = await ensureStatusTopic(input.companyId);
    if (!statusTopicId) return;

    try {
      await retryTelegramCall(() =>
        activeBot.api.sendMessage(chatId, statusMirrorLine(input), {
          message_thread_id: statusTopicId,
        }),
      );
    } catch (err) {
      logger.warn(
        { err, companyId: input.companyId, issueId: input.issueId, status: input.status },
        "telegram status mirror failed",
      );
    }
  }

  async function handleLiveEventForStatusMirror(companyId: string, event: LiveEvent) {
    const parsed = parseStatusMirrorEvent(event);
    if (!parsed) return;
    await sendStatusMirror({
      companyId,
      issueId: parsed.issueId,
      identifier: parsed.identifier,
      status: parsed.status,
    });
  }

  function subscribeToLiveEvents(companyId: string) {
    const existing = liveEventUnsubscribers.get(companyId);
    if (existing) return existing;

    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      void handleLiveEventForStatusMirror(companyId, event).catch((err) => {
        logger.warn({ err, companyId, eventType: event.type }, "telegram live event handler failed");
      });
    });

    const wrapped = () => {
      unsubscribe();
      liveEventUnsubscribers.delete(companyId);
    };
    liveEventUnsubscribers.set(companyId, wrapped);
    return wrapped;
  }

  async function subscribeToMappedCompanyEvents() {
    const companyIds = new Set<string>();
    for (const agentId of Object.keys(deps.config.telegramTopicMapping)) {
      const agent = await deps.agents.getById(agentId);
      if (agent) companyIds.add(agent.companyId);
    }
    for (const companyId of companyIds) {
      subscribeToLiveEvents(companyId);
    }
  }

  async function handleNewCommand(ctx: TelegramMessageContextLike, text: string, topicId: number | null) {
    const parsed = parseNewCommand(text);
    if (!parsed.ok) {
      await ctx.reply(parsed.message, formatTopicReplyOptions(topicId));
      return;
    }

    const mappedAgentId = topicId ? (reverseTopicMapping().get(topicId) ?? null) : null;
    const ownerRef = parsed.ownerRef ?? mappedAgentId;
    if (!ownerRef) {
      await ctx.reply(
        "Owner is required outside an agent topic. Use: /new <title> --owner <agent>",
        formatTopicReplyOptions(topicId),
      );
      return;
    }

    const companyId = await resolveCompanyIdFromMappedAgent(mappedAgentId);
    if (!companyId) {
      await ctx.reply(
        "Unable to resolve company context for this command.",
        formatTopicReplyOptions(topicId),
      );
      return;
    }

    const resolvedOwner = await deps.agents.resolveByReference(companyId, ownerRef);
    if (resolvedOwner.ambiguous) {
      await ctx.reply(
        "Owner reference is ambiguous. Use the agent ID.",
        formatTopicReplyOptions(topicId),
      );
      return;
    }
    if (!resolvedOwner.agent) {
      await ctx.reply(
        `Owner not found: ${ownerRef}`,
        formatTopicReplyOptions(topicId),
      );
      return;
    }

    const createdIssue = await deps.issues.create(companyId, {
      title: parsed.title,
      description: parsed.description,
      status: "todo",
      assigneeAgentId: resolvedOwner.agent.id,
      createdByUserId: "board",
    });

    await logActivityFn(db, {
      companyId,
      actorType: "user",
      actorId: "board",
      action: "issue.created",
      entityType: "issue",
      entityId: createdIssue.id,
      agentId: resolvedOwner.agent.id,
      details: {
        source: "telegram",
        topicId,
        ownerRef,
      },
    });

    const identifier =
      typeof createdIssue.identifier === "string" && createdIssue.identifier.length > 0
        ? createdIssue.identifier
        : createdIssue.id;
    await ctx.reply(`Created ${identifier}.`, formatTopicReplyOptions(topicId));
  }

  async function handleInboundMessage(ctx: TelegramMessageContextLike) {
    if (ctx.from?.is_bot) return;
    const text = ctx.message?.text;
    if (!text || text.trim().length === 0) return;

    const incomingChatId = String(ctx.message?.chat?.id ?? ctx.chat?.id ?? "");
    const configuredChatId = getChatId();
    if (!configuredChatId || incomingChatId !== configuredChatId) return;

    const topicId =
      typeof ctx.message?.message_thread_id === "number" ? ctx.message.message_thread_id : null;
    if (/^\/new(?:@\S+)?(?=\s|$)/i.test(text.trimStart())) {
      await handleNewCommand(ctx, text, topicId);
      return;
    }

    if (!topicId) return;
    const mappedAgentId = reverseTopicMapping().get(topicId);
    if (!mappedAgentId) return;

    const messageId =
      typeof ctx.message?.message_id === "number" ? ctx.message.message_id : null;
    await deps.heartbeat.wakeup(mappedAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "telegram_message",
      idempotencyKey:
        messageId !== null ? `telegram:${configuredChatId}:${topicId}:${messageId}` : undefined,
      payload: {
        text,
        chatId: configuredChatId,
        topicId,
        messageId,
        telegramUserId: ctx.from?.id ?? null,
        telegramUsername: ctx.from?.username ?? null,
      },
      contextSnapshot: {
        source: "telegram",
        reason: "message",
        chatId: configuredChatId,
        topicId,
        messageId,
      },
    });
  }

  async function answerApprovalCallback(
    activeBot: TelegramBotLike,
    ctx: TelegramCallbackContextLike,
    text: string,
  ) {
    const callbackQueryId = ctx.callbackQuery?.id;
    if (!callbackQueryId) return;

    if (typeof ctx.answerCallbackQuery === "function") {
      await retryTelegramCall(() => ctx.answerCallbackQuery?.({ text }) as Promise<unknown>);
      return;
    }

    if (typeof activeBot.api.answerCallbackQuery === "function") {
      await retryTelegramCall(() =>
        activeBot.api.answerCallbackQuery?.(callbackQueryId, { text }) as Promise<unknown>,
      );
    }
  }

  async function handleApprovalCallback(ctx: TelegramCallbackContextLike) {
    const parsed = parseApprovalCallbackData(ctx.callbackQuery?.data);
    if (!parsed) return;

    const chatId = String(ctx.callbackQuery?.message?.chat?.id ?? "");
    const configuredChatId = getChatId();
    if (!configuredChatId || chatId !== configuredChatId) return;

    const activeBot = await ensureBot();
    if (!activeBot) return;

    const messageId = ctx.callbackQuery?.message?.message_id;

    try {
      const updated =
        parsed.action === "a"
          ? await deps.approvals.approve(parsed.approvalId, "board")
          : await deps.approvals.reject(parsed.approvalId, "board");

      const status = updated.status === "approved" ? "approved" : "rejected";
      if (typeof activeBot.api.editMessageText === "function" && typeof messageId === "number") {
        await retryTelegramCall(() =>
          activeBot.api.editMessageText?.(
            configuredChatId,
            messageId,
            formatApprovalResolvedMessage(parsed.approvalId, status, false),
            { reply_markup: { inline_keyboard: [] } },
          ) as Promise<{ message_id: number }>,
        );
      }
      await answerApprovalCallback(activeBot, ctx, status === "approved" ? "Approved" : "Rejected");
      return;
    } catch (err) {
      const existing = await deps.approvals.getById(parsed.approvalId);
      const resolvedStatus =
        existing?.status === "approved" || existing?.status === "rejected" ? existing.status : null;

      if (resolvedStatus) {
        if (typeof activeBot.api.editMessageText === "function" && typeof messageId === "number") {
          await retryTelegramCall(() =>
            activeBot.api.editMessageText?.(
              configuredChatId,
              messageId,
              formatApprovalResolvedMessage(parsed.approvalId, resolvedStatus, true),
              { reply_markup: { inline_keyboard: [] } },
            ) as Promise<{ message_id: number }>,
          );
        }
        await answerApprovalCallback(
          activeBot,
          ctx,
          resolvedStatus === "approved" ? "Already approved" : "Already rejected",
        );
        return;
      }

      if (err instanceof HttpError) {
        await answerApprovalCallback(activeBot, ctx, err.message);
        return;
      }

      logger.warn({ err, approvalId: parsed.approvalId }, "telegram approval callback failed");
      await answerApprovalCallback(activeBot, ctx, "Failed to resolve approval");
    }
  }

  async function registerHandlersIfNeeded() {
    const activeBot = await ensureBot();
    if (!activeBot || handlersRegistered) return;
    activeBot.on("message:text", async (ctx: TelegramMessageContextLike) => {
      try {
        await handleInboundMessage(ctx);
      } catch (err) {
        logger.error({ err }, "telegram inbound handler failed");
      }
    });
    activeBot.on("callback_query:data", async (ctx: TelegramCallbackContextLike) => {
      try {
        await handleApprovalCallback(ctx);
      } catch (err) {
        logger.error({ err }, "telegram callback handler failed");
      }
    });
    handlersRegistered = true;
  }

  async function start() {
    if (!isEnabled()) {
      logger.info("telegram disabled (missing bot token or chat id)");
      return;
    }
    if (started) return;
    if (startPromise) {
      await startPromise;
      return;
    }
    startPromise = (async () => {
      const activeBot = await ensureBot();
      if (!activeBot) return;
      await registerHandlersIfNeeded();
      // bot.start() blocks forever (long-polling loop) — don't await it.
      // Use onStart callback to know when polling has begun.
      void activeBot.start({
        onStart: () => {
          started = true;
          logger.info("telegram bot started");
        },
      });
      await subscribeToMappedCompanyEvents();
    })();
    try {
      await startPromise;
    } finally {
      startPromise = null;
    }
  }

  async function stop() {
    for (const unsubscribe of liveEventUnsubscribers.values()) {
      unsubscribe();
    }
    liveEventUnsubscribers.clear();
    statusMirrorDedupUntil.clear();

    if (!bot) return;
    if (started) {
      bot.stop();
      started = false;
      logger.info("telegram bot stopped");
    }
    bot = null;
    handlersRegistered = false;
  }

  async function syncTopics(companyId: string): Promise<SyncTopicsResult> {
    if (!isEnabled()) {
      return {
        statusTopicId: deps.config.telegramStatusTopicId ?? 0,
        approvalsTopicId: deps.config.telegramApprovalsTopicId ?? 0,
        topicMapping: { ...deps.config.telegramTopicMapping },
        createdTopics: [],
      };
    }

    const chatId = getChatId();
    const activeBot = await ensureBot();
    if (!chatId || !activeBot) {
      return {
        statusTopicId: deps.config.telegramStatusTopicId ?? 0,
        approvalsTopicId: deps.config.telegramApprovalsTopicId ?? 0,
        topicMapping: { ...deps.config.telegramTopicMapping },
        createdTopics: [],
      };
    }

    if (!deps.config.telegramStatusTopicId) {
      const statusTopic = await retryTelegramCall(() => activeBot.api.createForumTopic(chatId, "Status"));
      deps.config.telegramStatusTopicId = statusTopic.message_thread_id;
    }
    if (!deps.config.telegramApprovalsTopicId) {
      const approvalsTopic = await retryTelegramCall(() =>
        activeBot.api.createForumTopic(chatId, "Approvals"),
      );
      deps.config.telegramApprovalsTopicId = approvalsTopic.message_thread_id;
    }

    const createdTopics: Array<{ agentId: string; topicId: number }> = [];
    const companyAgents = await deps.agents.list(companyId);
    for (const agent of companyAgents) {
      if (agent.status === "terminated") continue;
      if (deps.config.telegramTopicMapping[agent.id]) continue;
      const topic = await retryTelegramCall(() => activeBot.api.createForumTopic(chatId, agent.name));
      deps.config.telegramTopicMapping[agent.id] = topic.message_thread_id;
      createdTopics.push({ agentId: agent.id, topicId: topic.message_thread_id });
    }

    subscribeToLiveEvents(companyId);

    return {
      statusTopicId: deps.config.telegramStatusTopicId ?? 0,
      approvalsTopicId: deps.config.telegramApprovalsTopicId ?? 0,
      topicMapping: { ...deps.config.telegramTopicMapping },
      createdTopics,
    };
  }

  async function sendToAgentTopic(input: SendToAgentTopicInput): Promise<SendTelegramResult> {
    if (!isEnabled()) {
      return { ok: false as const, error: "telegram disabled" };
    }
    const chatId = getChatId();
    const activeBot = await ensureBot();
    if (!chatId || !activeBot) {
      return { ok: false as const, error: "telegram disabled" };
    }

    subscribeToLiveEvents(input.companyId);

    const owner = await deps.agents.getById(input.agentId);
    if (!owner) {
      return { ok: false as const, error: "agent not found" };
    }
    if (owner.companyId !== input.companyId) {
      return { ok: false as const, error: "agent-company mismatch" };
    }

    const topicId = deps.config.telegramTopicMapping[input.agentId];
    if (!topicId) {
      return { ok: false as const, error: "agent topic not configured" };
    }

    const text = input.mirrorStatus ? `[${input.mirrorStatus.toUpperCase()}] ${input.text}` : input.text;

    try {
      const sent = await retryTelegramCall(() =>
        activeBot.api.sendMessage(chatId, text, {
          message_thread_id: topicId,
        }),
      );

      if (input.mirrorStatus) {
        await sendStatusMirror({
          companyId: input.companyId,
          issueId: input.issueId ?? `${input.agentId}:${sent.message_id}`,
          identifier: input.issueId ?? input.agentId,
          status: input.mirrorStatus,
        });
      }

      return { ok: true as const, messageId: sent.message_id };
    } catch (err) {
      const message = err instanceof Error ? err.message : "telegram send failed";
      logger.warn({ err, agentId: input.agentId, topicId }, "telegram send failed");
      return { ok: false as const, error: message };
    }
  }

  async function sendApprovalRequest(
    companyId: string,
    approval: SendApprovalRequestInput,
  ): Promise<SendTelegramResult> {
    if (!isEnabled()) {
      return { ok: false as const, error: "telegram disabled" };
    }

    const chatId = getChatId();
    const activeBot = await ensureBot();
    if (!chatId || !activeBot) {
      return { ok: false as const, error: "telegram disabled" };
    }

    subscribeToLiveEvents(companyId);

    const approvalsTopicId = await ensureApprovalsTopic(companyId);
    if (!approvalsTopicId) {
      return { ok: false as const, error: "approvals topic not configured" };
    }

    const approveCallback = callbackData("a", approval.id);
    const rejectCallback = callbackData("r", approval.id);

    try {
      const sent = await retryTelegramCall(() =>
        activeBot.api.sendMessage(chatId, formatApprovalRequestMessage(approval), {
          message_thread_id: approvalsTopicId,
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Approve", callback_data: approveCallback },
                { text: "Reject", callback_data: rejectCallback },
              ],
            ],
          },
        }),
      );
      return { ok: true as const, messageId: sent.message_id };
    } catch (err) {
      const message = err instanceof Error ? err.message : "telegram send failed";
      logger.warn({ err, approvalId: approval.id }, "telegram approval send failed");
      return { ok: false as const, error: message };
    }
  }

  return {
    start,
    stop,
    syncTopics,
    sendToAgentTopic,
    sendApprovalRequest,
    subscribeToLiveEvents,
  };
}

export type TelegramService = ReturnType<typeof telegramService>;
export type { SendToAgentTopicInput, SendApprovalRequestInput, SyncTopicsResult, RetryTelegramCallOptions };
