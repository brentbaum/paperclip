import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { telegramRoutes } from "../routes/telegram.js";

type Actor = Express.Request["actor"];

type RouteResult = {
  status: number;
  body: unknown;
};

function extractPostHandlers() {
  const router = telegramRoutes({ sendToAgentTopic: vi.fn() } as any) as any;
  const layer = router.stack.find(
    (entry: any) => entry?.route?.path === "/agent-tools/telegram/send" && entry?.route?.methods?.post,
  );
  if (!layer) {
    throw new Error("telegram send route not found");
  }
  return layer.route.stack.map((entry: any) => entry.handle) as Array<(...args: any[]) => unknown>;
}

async function invokeSendRoute(input: {
  actor: Actor;
  body: Record<string, unknown>;
  sendToAgentTopic: ReturnType<typeof vi.fn>;
}): Promise<RouteResult> {
  const handlers = extractPostHandlers();
  const req = {
    actor: input.actor,
    body: { ...input.body },
    method: "POST",
    originalUrl: "/api/agent-tools/telegram/send",
  } as any;

  const res = {
    statusCode: 200,
    jsonBody: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.jsonBody = payload;
      return this;
    },
  } as any;

  const router = telegramRoutes({ sendToAgentTopic: input.sendToAgentTopic } as any) as any;
  const routeLayer = router.stack.find(
    (entry: any) => entry?.route?.path === "/agent-tools/telegram/send" && entry?.route?.methods?.post,
  );
  const routeHandlers = routeLayer.route.stack.map((entry: any) => entry.handle) as Array<(...args: any[]) => unknown>;

  let caughtError: unknown;

  for (const handler of routeHandlers) {
    if (caughtError) break;
    try {
      if (handler.length >= 3) {
        await new Promise<void>((resolve, reject) => {
          handler(req, res, (err?: unknown) => {
            if (err) reject(err);
            else resolve();
          });
        });
      } else {
        await handler(req, res);
      }
    } catch (err) {
      caughtError = err;
    }
  }

  if (caughtError) {
    errorHandler(caughtError, req, res, () => undefined);
  }

  return {
    status: res.statusCode,
    body: res.jsonBody,
  };
}

describe("telegram agent tool route", () => {
  it("allows an agent to send telegram messages for itself", async () => {
    const sendToAgentTopic = vi.fn(async () => ({ ok: true as const, messageId: 501 }));

    const res = await invokeSendRoute({
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        source: "agent_key",
      },
      body: { agentId: "agent-1", text: "hello" },
      sendToAgentTopic,
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, messageId: 501 });
    expect(sendToAgentTopic).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: "agent-1",
      text: "hello",
      mirrorStatus: null,
      issueId: null,
    });
  });

  it("blocks agents from spoofing another agent id", async () => {
    const sendToAgentTopic = vi.fn(async () => ({ ok: true as const, messageId: 501 }));

    const res = await invokeSendRoute({
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        source: "agent_key",
      },
      body: { agentId: "agent-2", text: "hello" },
      sendToAgentTopic,
    });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Agents may only send telegram messages for themselves" });
    expect(sendToAgentTopic).not.toHaveBeenCalled();
  });

  it("rejects company mismatch responses from telegram service", async () => {
    const sendToAgentTopic = vi.fn(async () => ({ ok: false as const, error: "agent-company mismatch" }));

    const res = await invokeSendRoute({
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        source: "agent_key",
      },
      body: { agentId: "agent-1", text: "hello" },
      sendToAgentTopic,
    });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Agent key cannot access another company" });
  });
});
