import { Router, type Request } from "express";
import { conflict, forbidden, unauthorized } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { assertBoard } from "./authz.js";
import { isSelfRestartEnabled, requestSelfRestart } from "../process-control.js";

function assertInstanceAdmin(req: Request) {
  assertBoard(req);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

function assertRestartAccess(req: Request) {
  if (req.actor.type === "agent") return;
  if (req.actor.type === "none") {
    throw unauthorized();
  }
  assertInstanceAdmin(req);
}

function getRestartActorLabel(req: Request): string {
  if (req.actor.type === "agent") {
    return `agent:${req.actor.agentId ?? "unknown-agent"}`;
  }
  return req.actor.userId ?? req.actor.source ?? "unknown";
}

export function processControlRoutes(
  opts: {
    isRestartEnabled?: () => boolean;
    requestRestart?: (reason: string) => void;
  } = {},
) {
  const isRestartEnabled = opts.isRestartEnabled ?? isSelfRestartEnabled;
  const requestRestart = opts.requestRestart ?? requestSelfRestart;
  const router = Router();

  router.post("/control/restart", (req, res) => {
    assertRestartAccess(req);
    if (!isRestartEnabled()) {
      throw conflict("Self-restart is not enabled for this process");
    }

    const actorLabel = getRestartActorLabel(req);
    res.status(202).json({ status: "accepted", action: "restart" });
    res.once("finish", () => {
      setImmediate(() => {
        try {
          requestRestart(`api:${actorLabel}`);
        } catch (err) {
          logger.error({ err }, "Failed to trigger self-restart after API request");
        }
      });
    });
  });

  return router;
}
