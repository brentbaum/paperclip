import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { processControlRoutes } from "../routes/process-control.js";
import { errorHandler } from "../middleware/error-handler.js";

function createApp(actor: Express.Request["actor"], options?: {
  isRestartEnabled?: () => boolean;
  requestRestart?: (reason: string) => void;
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", processControlRoutes(options));
  app.use(errorHandler);
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("processControlRoutes", () => {
  it("accepts restart requests from local implicit board and triggers restart after response", async () => {
    const requestRestart = vi.fn();
    const app = createApp(
      { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true },
      { isRestartEnabled: () => true, requestRestart },
    );

    const res = await request(app).post("/api/control/restart");
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "accepted", action: "restart" });

    await new Promise((resolve) => setImmediate(resolve));
    expect(requestRestart).toHaveBeenCalledWith("api:local-board");
  });

  it("rejects restart requests when self-restart is disabled", async () => {
    const requestRestart = vi.fn();
    const app = createApp(
      { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true },
      { isRestartEnabled: () => false, requestRestart },
    );

    const res = await request(app).post("/api/control/restart");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Self-restart is not enabled for this process" });
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it("requires instance admin board access", async () => {
    const requestRestart = vi.fn();
    const app = createApp(
      { type: "board", userId: "user-1", source: "session", isInstanceAdmin: false, companyIds: ["company-1"] },
      { isRestartEnabled: () => true, requestRestart },
    );

    const res = await request(app).post("/api/control/restart");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Instance admin access required" });
    expect(requestRestart).not.toHaveBeenCalled();
  });
});
