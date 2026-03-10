import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  testRemoteExecutionTargetSchema,
  createRemoteExecutionTargetSchema,
  updateRemoteExecutionTargetSchema,
  updateRemoteExecutionLeaseSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { issueService, logActivity, remoteExecutionService } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { testRemoteExecutionTarget } from "../services/remote-execution-runner.js";

export function remoteExecutionRoutes(db: Db) {
  const router = Router();
  const svc = remoteExecutionService(db);
  const issueSvc = issueService(db);

  router.get("/companies/:companyId/remote-execution-targets", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const includeArchived = req.query.includeArchived === "true";
    const targets = await svc.listTargets(companyId, { includeArchived });
    res.json(targets);
  });

  router.post(
    "/companies/:companyId/remote-execution-targets/test",
    validate(testRemoteExecutionTargetSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const result = await testRemoteExecutionTarget({
        runId: `remote-target-test-${randomUUID()}`,
        target: {
          host: req.body.host,
          user: req.body.user,
          workerPath: req.body.workerPath,
          metadata:
            typeof req.body.metadata === "object" && req.body.metadata !== null && !Array.isArray(req.body.metadata)
              ? (req.body.metadata as Record<string, unknown>)
              : null,
        },
      });

      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/remote-execution-targets",
    validate(createRemoteExecutionTargetSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const target = await svc.createTarget(companyId, req.body);
      if (!target) {
        res.status(500).json({ error: "Failed to create remote execution target" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "remote_execution.target_created",
        entityType: "remote_execution_target",
        entityId: target.id,
        details: { name: target.name, host: target.host },
      });

      res.status(201).json(target);
    },
  );

  router.patch(
    "/remote-execution-targets/:id",
    validate(updateRemoteExecutionTargetSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const existing = await svc.getTargetById(id);
      if (!existing) {
        res.status(404).json({ error: "Remote execution target not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);

      const target = await svc.updateTarget(id, req.body);
      if (!target) {
        res.status(404).json({ error: "Remote execution target not found" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "remote_execution.target_updated",
        entityType: "remote_execution_target",
        entityId: target.id,
        details: { changedKeys: Object.keys(req.body).sort() },
      });

      res.json(target);
    },
  );

  router.delete("/remote-execution-targets/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getTargetById(id);
    if (!existing) {
      res.status(404).json({ error: "Remote execution target not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const target = await svc.archiveTarget(id);
    if (!target) {
      res.status(404).json({ error: "Remote execution target not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "remote_execution.target_archived",
      entityType: "remote_execution_target",
      entityId: target.id,
      details: { name: target.name },
    });

    res.json(target);
  });

  router.get("/issues/:id/remote-execution-leases", async (req, res) => {
    assertBoard(req);
    const issueId = req.params.id as string;
    const issue = await issueSvc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const leases = await svc.listLeasesForIssue(issue.companyId, issueId);
    res.json(leases);
  });

  router.patch(
    "/remote-execution-leases/:id",
    validate(updateRemoteExecutionLeaseSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const existing = await svc.getLeaseById(id);
      if (!existing) {
        res.status(404).json({ error: "Remote execution lease not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);

      const patch: Record<string, unknown> = { ...req.body };
      if (typeof req.body.expiresAt === "string") patch.expiresAt = new Date(req.body.expiresAt);
      if (typeof req.body.destroyedAt === "string") patch.destroyedAt = new Date(req.body.destroyedAt);
      const updated = await svc.updateLease(id, patch);

      if (!updated) {
        res.status(404).json({ error: "Remote execution lease not found" });
        return;
      }

      res.json(updated);
    },
  );

  router.post("/remote-execution-leases/:id/reset", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getLeaseById(id);
    if (!existing) {
      res.status(404).json({ error: "Remote execution lease not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const lease = await svc.resetLease(id);
    if (!lease) {
      res.status(404).json({ error: "Remote execution lease not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "remote_execution.lease_reset",
      entityType: "remote_execution_lease",
      entityId: lease.id,
      details: { issueId: lease.issueId },
    });

    res.json(lease);
  });

  return router;
}
