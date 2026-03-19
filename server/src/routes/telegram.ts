import { Router } from "express";
import { z } from "zod";
import { forbidden, unauthorized } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import type { TelegramService } from "../services/telegram.js";

const sendTelegramMessageSchema = z.object({
  agentId: z.string().min(1),
  text: z.string().min(1),
  status: z.enum(["done", "blocked"]).optional(),
  issueId: z.string().min(1).optional(),
  chatId: z.string().min(1).optional(),
  topicId: z.coerce.number().int().optional(),
});

export function telegramRoutes(telegram: Pick<TelegramService, "sendToAgentTopic">) {
  const router = Router();

  router.post(
    "/agent-tools/telegram/send",
    validate(sendTelegramMessageSchema),
    async (req, res) => {
      if (req.actor.type !== "agent") {
        throw unauthorized("Agent authentication required");
      }

      if (req.actor.agentId !== req.body.agentId) {
        throw forbidden("Agents may only send telegram messages for themselves");
      }

      if (!req.actor.companyId) {
        throw unauthorized("Agent company context missing");
      }

      logger.info(
        {
          agentId: req.body.agentId,
          hasChatId: Boolean(req.body.chatId),
          chatId: req.body.chatId ?? null,
          hasTopicId: req.body.topicId != null,
          topicId: req.body.topicId ?? null,
          textLen: req.body.text?.length ?? 0,
        },
        "telegram send request received",
      );

      const result = await telegram.sendToAgentTopic({
        companyId: req.actor.companyId,
        agentId: req.body.agentId,
        text: req.body.text,
        mirrorStatus: req.body.status ?? null,
        issueId: req.body.issueId ?? null,
        overrideChatId: req.body.chatId ?? null,
        overrideTopicId: req.body.topicId ?? null,
      });

      if (!result.ok) {
        if (result.error === "agent-company mismatch") {
          res.status(403).json({ error: "Agent key cannot access another company" });
          return;
        }
        if (result.error === "agent not found") {
          res.status(404).json({ error: "Agent not found" });
          return;
        }
        if (result.error === "agent topic not configured") {
          res.status(409).json({ error: "Agent telegram topic not configured" });
          return;
        }
        if (result.error === "telegram disabled") {
          res.status(503).json({ error: "Telegram integration is disabled" });
          return;
        }

        res.status(502).json({ error: result.error });
        return;
      }

      res.status(201).json({ ok: true, messageId: result.messageId });
    },
  );

  return router;
}
