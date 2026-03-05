import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createDocumentRevisionSchema,
  documentDayQuerySchema,
  documentDiffQuerySchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { documentService, approvalService, projectService, agentService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function documentRoutes(db: Db) {
  const router = Router();
  const documentsSvc = documentService(db);
  const approvalsSvc = approvalService(db);
  const projectsSvc = projectService(db);
  const agentsSvc = agentService(db);

  router.get("/projects/:id/document", async (req, res) => {
    const project = await projectsSvc.getById(req.params.id as string);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);
    const document = await documentsSvc.getOrCreateProjectDocument(project.id);
    res.json(document);
  });

  router.get("/approvals/:id/document", async (req, res) => {
    const approval = await approvalsSvc.getById(req.params.id as string);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const document = await documentsSvc.getOrCreateApprovalDocument(approval.id);
    res.json(document);
  });

  router.get("/agents/:id/daily-document", async (req, res) => {
    const agent = await agentsSvc.getById(req.params.id as string);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);
    const query = documentDayQuerySchema.parse(req.query);
    const document = await documentsSvc.getOrCreateAgentDailyDocument(
      agent.id,
      query.day,
      undefined,
      agent.id,
    );
    res.json(document);
  });

  router.get("/documents/:id", async (req, res) => {
    const raw = await documentsSvc.getById(req.params.id as string);
    if (!raw) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    assertCompanyAccess(req, raw.companyId);
    const viewerAgentId = raw.scope === "agent_daily" ? raw.agentId : req.actor.type === "agent" ? req.actor.agentId : null;
    const document = await documentsSvc.getById(raw.id, viewerAgentId ?? undefined);
    res.json(document);
  });

  router.get("/documents/:id/revisions", async (req, res) => {
    const document = await documentsSvc.getById(req.params.id as string);
    if (!document) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    assertCompanyAccess(req, document.companyId);
    const revisions = await documentsSvc.listRevisions(document.id);
    res.json(revisions);
  });

  router.get("/documents/:id/revisions/:revisionId", async (req, res) => {
    const document = await documentsSvc.getById(req.params.id as string);
    if (!document) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    assertCompanyAccess(req, document.companyId);
    const revision = await documentsSvc.getRevision(document.id, req.params.revisionId as string);
    if (!revision) {
      res.status(404).json({ error: "Revision not found" });
      return;
    }
    res.json(revision);
  });

  router.get("/documents/:id/diff", async (req, res) => {
    const document = await documentsSvc.getById(req.params.id as string);
    if (!document) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    assertCompanyAccess(req, document.companyId);
    const query = documentDiffQuerySchema.parse(req.query);
    const diff = await documentsSvc.getDiff(document.id, {
      fromRevisionId: query.from,
      toRevisionId: query.to,
    });
    res.json(diff);
  });

  router.post("/documents/:id/revisions", validate(createDocumentRevisionSchema), async (req, res) => {
    const existing = await documentsSvc.getById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);
    const result = await documentsSvc.createRevision(
      existing.id,
      {
        baseRevisionId: req.body.baseRevisionId ?? null,
        body: req.body.body,
        changeSummary: req.body.changeSummary ?? null,
        source: req.body.source ?? undefined,
      },
      {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      },
    );

    await logActivity(db, {
      companyId: result.document.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "document.revision_created",
      entityType: "document",
      entityId: result.document.id,
      details: {
        revisionId: result.revision.id,
        revisionNumber: result.revision.revisionNumber,
        scope: result.document.scope,
        projectId: result.document.projectId,
        approvalId: result.document.approvalId,
        agentId: result.document.agentId,
        day: result.document.day,
      },
    });

    res.status(201).json(result);
  });

  return router;
}
