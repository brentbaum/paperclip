import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  documentAgentStates,
  documentRevisions,
  documents,
  issueApprovals,
  issues,
  projects,
} from "@paperclipai/db";
import type { Document, DocumentDiff, DocumentRevision } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

type ActorRef = {
  agentId?: string | null;
  userId?: string | null;
};

type DocumentDb = Pick<Db, "select" | "insert" | "update">;

type CreateScopeDocumentInput = {
  companyId: string;
  scope: "project" | "approval" | "agent_daily" | "issue_plan";
  title: string;
  projectId?: string | null;
  approvalId?: string | null;
  agentId?: string | null;
  issueId?: string | null;
  day?: string | null;
  initialBody?: string;
  initialSource?: string;
  actor?: ActorRef;
};

function summarizeDocumentBody(body: string) {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (normalized.length <= 280) return normalized;
  return `${normalized.slice(0, 277)}...`;
}

function approvalDocumentSeed(approval: typeof approvals.$inferSelect) {
  const payload = approval.payload as Record<string, unknown>;
  const title = typeof payload.title === "string" && payload.title.trim().length > 0
    ? payload.title.trim()
    : "CEO Strategy";
  const bodyCandidate =
    payload.plan ??
    payload.description ??
    payload.strategy ??
    payload.text;
  const body = typeof bodyCandidate === "string" ? bodyCandidate : "";
  return { title, body };
}

function projectDocumentSeed(project: typeof projects.$inferSelect) {
  return {
    title: `${project.name} Document`,
    body: project.description ?? "",
  };
}

function dailyScratchpadTitle(agentName: string, day: string) {
  return `${agentName} Scratchpad · ${day}`;
}

function utcDayString(value = new Date()) {
  return value.toISOString().slice(0, 10);
}

function extractPlanFromDescription(description: string): string {
  const match = description.match(/<plan>([\s\S]*?)<\/plan>/i);
  return match ? match[1]!.trim() : "";
}

async function hydrateDocuments(
  db: DocumentDb,
  rows: Array<typeof documents.$inferSelect>,
  viewerAgentId?: string | null,
): Promise<Document[]> {
  if (rows.length === 0) return [];

  const latestRevisionIds = rows
    .map((row) => row.latestRevisionId)
    .filter((value): value is string => Boolean(value));
  const documentIds = rows.map((row) => row.id);

  const [revisionRows, stateRows] = await Promise.all([
    latestRevisionIds.length > 0
      ? db
          .select()
          .from(documentRevisions)
          .where(inArray(documentRevisions.id, latestRevisionIds))
      : Promise.resolve([] as Array<typeof documentRevisions.$inferSelect>),
    viewerAgentId
      ? db
          .select()
          .from(documentAgentStates)
          .where(
            and(
              eq(documentAgentStates.agentId, viewerAgentId),
              inArray(documentAgentStates.documentId, documentIds),
            ),
          )
      : Promise.resolve([] as Array<typeof documentAgentStates.$inferSelect>),
  ]);

  const revisionMap = new Map<string, typeof documentRevisions.$inferSelect>();
  for (const row of revisionRows) revisionMap.set(row.id, row);

  const stateMap = new Map<string, typeof documentAgentStates.$inferSelect>();
  for (const row of stateRows) stateMap.set(row.documentId, row);

  return rows.map((row) => {
    const latestRevision = row.latestRevisionId ? revisionMap.get(row.latestRevisionId) ?? null : null;
    const agentState = stateMap.get(row.id) ?? null;
    return {
      id: row.id,
      companyId: row.companyId,
      scope: row.scope as Document["scope"],
      title: row.title,
      format: row.format as Document["format"],
      projectId: row.projectId ?? null,
      approvalId: row.approvalId ?? null,
      agentId: row.agentId ?? null,
      issueId: row.issueId ?? null,
      day: row.day ?? null,
      latestRevisionId: row.latestRevisionId ?? null,
      latestRevisionNumber: latestRevision?.revisionNumber ?? null,
      latestRevision: latestRevision
        ? {
            id: latestRevision.id,
            companyId: latestRevision.companyId,
            documentId: latestRevision.documentId,
            revisionNumber: latestRevision.revisionNumber,
            parentRevisionId: latestRevision.parentRevisionId ?? null,
            authorAgentId: latestRevision.authorAgentId ?? null,
            authorUserId: latestRevision.authorUserId ?? null,
            source: latestRevision.source,
            changeSummary: latestRevision.changeSummary ?? null,
            body: latestRevision.body,
            createdAt: latestRevision.createdAt,
          }
        : null,
      createdByAgentId: row.createdByAgentId ?? null,
      createdByUserId: row.createdByUserId ?? null,
      lastDeliveredRevisionId: agentState?.lastDeliveredRevisionId ?? null,
      lastWrittenRevisionId: agentState?.lastWrittenRevisionId ?? null,
      hasUndeliveredChanges:
        Boolean(row.latestRevisionId) && row.latestRevisionId !== (agentState?.lastDeliveredRevisionId ?? null),
      archivedAt: row.archivedAt ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
}

export function documentService(db: Db) {
  async function getDocumentRowById(documentId: string) {
    return db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getDocumentByScope(
    where:
      | { projectId: string }
      | { approvalId: string }
      | { agentId: string; day: string }
      | { issueId: string },
    viewerAgentId?: string | null,
  ) {
    let row: typeof documents.$inferSelect | null = null;
    if ("projectId" in where) {
      row = await db
        .select()
        .from(documents)
        .where(eq(documents.projectId, where.projectId))
        .then((rows) => rows[0] ?? null);
    } else if ("approvalId" in where) {
      row = await db
        .select()
        .from(documents)
        .where(eq(documents.approvalId, where.approvalId))
        .then((rows) => rows[0] ?? null);
    } else if ("issueId" in where) {
      row = await db
        .select()
        .from(documents)
        .where(eq(documents.issueId, where.issueId))
        .then((rows) => rows[0] ?? null);
    } else {
      row = await db
        .select()
        .from(documents)
        .where(and(eq(documents.agentId, where.agentId), eq(documents.day, where.day)))
        .then((rows) => rows[0] ?? null);
    }
    if (!row) return null;
    return hydrateDocuments(db, [row], viewerAgentId).then((rows) => rows[0] ?? null);
  }

  async function updateApprovalPayloadDocumentMetadata(
    tx: DocumentDb,
    approvalId: string,
    documentId: string,
    title: string,
    body: string,
  ) {
    const approval = await tx
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .then((rows) => rows[0] ?? null);
    if (!approval) return;
    const payload = approval.payload as Record<string, unknown>;
    await tx
      .update(approvals)
      .set({
        payload: {
          ...payload,
          documentId,
          documentTitle: title,
          summary: summarizeDocumentBody(body),
        },
        updatedAt: new Date(),
      })
      .where(eq(approvals.id, approvalId));
  }

  async function createScopedDocument(input: CreateScopeDocumentInput): Promise<Document> {
    const now = new Date();
    const initialBody = input.initialBody ?? "";
    const initialSource = input.initialSource ?? "seed";
    const actor = input.actor ?? {};

    return db.transaction(async (tx) => {
      const [documentRow] = await tx
        .insert(documents)
        .values({
          companyId: input.companyId,
          scope: input.scope,
          title: input.title,
          format: "markdown",
          projectId: input.projectId ?? null,
          approvalId: input.approvalId ?? null,
          agentId: input.agentId ?? null,
          issueId: input.issueId ?? null,
          day: input.day ?? null,
          latestRevisionId: null,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const [revision] = await tx
        .insert(documentRevisions)
        .values({
          companyId: input.companyId,
          documentId: documentRow.id,
          revisionNumber: 1,
          parentRevisionId: null,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          source: initialSource,
          changeSummary: null,
          body: initialBody,
          createdAt: now,
        })
        .returning();

      await tx
        .update(documents)
        .set({
          latestRevisionId: revision.id,
          updatedAt: now,
        })
        .where(eq(documents.id, documentRow.id));

      if (input.scope === "approval" && input.approvalId) {
        await updateApprovalPayloadDocumentMetadata(
          tx,
          input.approvalId,
          documentRow.id,
          input.title,
          initialBody,
        );
      }

      const hydrated = await hydrateDocuments(tx, [{ ...documentRow, latestRevisionId: revision.id, updatedAt: now }], actor.agentId ?? null);
      return hydrated[0]!;
    });
  }

  async function getOrCreateProjectDocument(
    projectId: string,
    actor?: ActorRef,
    viewerAgentId?: string | null,
  ) {
    const existing = await getDocumentByScope({ projectId }, viewerAgentId);
    if (existing) return existing;

    const project = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((rows) => rows[0] ?? null);
    if (!project) throw notFound("Project not found");

    const seed = projectDocumentSeed(project);
    return createScopedDocument({
      companyId: project.companyId,
      scope: "project",
      title: seed.title,
      projectId: project.id,
      initialBody: seed.body,
      initialSource: project.description ? "seed_from_project_description" : "seed_empty",
      actor,
    });
  }

  async function getOrCreateApprovalDocument(
    approvalId: string,
    actor?: ActorRef,
    viewerAgentId?: string | null,
  ) {
    const existing = await getDocumentByScope({ approvalId }, viewerAgentId);
    if (existing) return existing;

    const approval = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .then((rows) => rows[0] ?? null);
    if (!approval) throw notFound("Approval not found");

    const seed = approvalDocumentSeed(approval);
    return createScopedDocument({
      companyId: approval.companyId,
      scope: "approval",
      title: seed.title,
      approvalId: approval.id,
      initialBody: seed.body,
      initialSource: seed.body ? "seed_from_approval_payload" : "seed_empty",
      actor,
    });
  }

  async function getOrCreateAgentDailyDocument(
    agentId: string,
    day = utcDayString(),
    actor?: ActorRef,
    viewerAgentId?: string | null,
  ) {
    const existing = await getDocumentByScope({ agentId, day }, viewerAgentId ?? agentId);
    if (existing) return existing;

    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");

    return createScopedDocument({
      companyId: agent.companyId,
      scope: "agent_daily",
      title: dailyScratchpadTitle(agent.name, day),
      agentId: agent.id,
      day,
      initialBody: "",
      initialSource: "seed_empty",
      actor,
    });
  }

  async function getOrCreateIssuePlanDocument(
    issueId: string,
    actor?: ActorRef,
    viewerAgentId?: string | null,
  ) {
    const existing = await getDocumentByScope({ issueId }, viewerAgentId);
    if (existing) return existing;

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue) throw notFound("Issue not found");

    const planBody = extractPlanFromDescription(issue.description ?? "");
    return createScopedDocument({
      companyId: issue.companyId,
      scope: "issue_plan",
      title: `Plan · ${issue.identifier ?? issue.id.slice(0, 8)}`,
      issueId: issue.id,
      initialBody: planBody,
      initialSource: planBody ? "seed_from_issue_description" : "seed_empty",
      actor,
    });
  }

  return {
    getById: async (documentId: string, viewerAgentId?: string | null) => {
      const row = await getDocumentRowById(documentId);
      if (!row) return null;
      const [document] = await hydrateDocuments(db, [row], viewerAgentId);
      return document ?? null;
    },

    listRevisions: async (documentId: string): Promise<DocumentRevision[]> => {
      const rows = await db
        .select()
        .from(documentRevisions)
        .where(eq(documentRevisions.documentId, documentId))
        .orderBy(desc(documentRevisions.revisionNumber));
      return rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        documentId: row.documentId,
        revisionNumber: row.revisionNumber,
        parentRevisionId: row.parentRevisionId ?? null,
        authorAgentId: row.authorAgentId ?? null,
        authorUserId: row.authorUserId ?? null,
        source: row.source,
        changeSummary: row.changeSummary ?? null,
        body: row.body,
        createdAt: row.createdAt,
      }));
    },

    getRevision: async (documentId: string, revisionId: string): Promise<DocumentRevision | null> => {
      const row = await db
        .select()
        .from(documentRevisions)
        .where(and(eq(documentRevisions.documentId, documentId), eq(documentRevisions.id, revisionId)))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      return {
        id: row.id,
        companyId: row.companyId,
        documentId: row.documentId,
        revisionNumber: row.revisionNumber,
        parentRevisionId: row.parentRevisionId ?? null,
        authorAgentId: row.authorAgentId ?? null,
        authorUserId: row.authorUserId ?? null,
        source: row.source,
        changeSummary: row.changeSummary ?? null,
        body: row.body,
        createdAt: row.createdAt,
      };
    },

    getDiff: async (
      documentId: string,
      input: { fromRevisionId?: string | null; toRevisionId?: string | null },
    ): Promise<DocumentDiff> => {
      const revisions = await db
        .select()
        .from(documentRevisions)
        .where(eq(documentRevisions.documentId, documentId))
        .orderBy(asc(documentRevisions.revisionNumber));
      if (revisions.length === 0) {
        return {
          documentId,
          fromRevision: null,
          toRevision: null,
          fromBody: "",
          toBody: "",
        };
      }

      const revisionMap = new Map(revisions.map((row) => [row.id, row]));
      const toRow =
        (input.toRevisionId ? revisionMap.get(input.toRevisionId) : null) ??
        revisions[revisions.length - 1]!;
      const fromRow =
        (input.fromRevisionId ? revisionMap.get(input.fromRevisionId) : null) ??
        (toRow.parentRevisionId ? revisionMap.get(toRow.parentRevisionId) : null) ??
        null;

      const toRevision = {
        id: toRow.id,
        companyId: toRow.companyId,
        documentId: toRow.documentId,
        revisionNumber: toRow.revisionNumber,
        parentRevisionId: toRow.parentRevisionId ?? null,
        authorAgentId: toRow.authorAgentId ?? null,
        authorUserId: toRow.authorUserId ?? null,
        source: toRow.source,
        changeSummary: toRow.changeSummary ?? null,
        body: toRow.body,
        createdAt: toRow.createdAt,
      };

      const fromRevision = fromRow
        ? {
            id: fromRow.id,
            companyId: fromRow.companyId,
            documentId: fromRow.documentId,
            revisionNumber: fromRow.revisionNumber,
            parentRevisionId: fromRow.parentRevisionId ?? null,
            authorAgentId: fromRow.authorAgentId ?? null,
            authorUserId: fromRow.authorUserId ?? null,
            source: fromRow.source,
            changeSummary: fromRow.changeSummary ?? null,
            body: fromRow.body,
            createdAt: fromRow.createdAt,
          }
        : null;

      return {
        documentId,
        fromRevision,
        toRevision,
        fromBody: fromRevision?.body ?? "",
        toBody: toRevision.body,
      };
    },

    getOrCreateProjectDocument,
    getOrCreateApprovalDocument,
    getOrCreateAgentDailyDocument,
    getOrCreateIssuePlanDocument,

    createRevision: async (
      documentId: string,
      input: {
        baseRevisionId?: string | null;
        body: string;
        changeSummary?: string | null;
        source?: string | null;
      },
      actor: ActorRef,
    ) => {
      const now = new Date();
      return db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(documents)
          .where(eq(documents.id, documentId))
          .then((rows) => rows[0] ?? null);
        if (!existing) throw notFound("Document not found");
        if (existing.archivedAt) throw unprocessable("Document is archived");

        const currentRevision = existing.latestRevisionId
          ? await tx
              .select()
              .from(documentRevisions)
              .where(eq(documentRevisions.id, existing.latestRevisionId))
              .then((rows) => rows[0] ?? null)
          : null;

        const expectedBase = input.baseRevisionId ?? null;
        const currentBase = currentRevision?.id ?? null;
        if (expectedBase !== currentBase) {
          throw conflict("Document has changed since you started editing");
        }

        if (currentRevision && currentRevision.body === input.body) {
          throw unprocessable("No document changes to save");
        }

        const [revision] = await tx
          .insert(documentRevisions)
          .values({
            companyId: existing.companyId,
            documentId: existing.id,
            revisionNumber: (currentRevision?.revisionNumber ?? 0) + 1,
            parentRevisionId: currentRevision?.id ?? null,
            authorAgentId: actor.agentId ?? null,
            authorUserId: actor.userId ?? null,
            source: input.source?.trim() || (actor.agentId ? "agent_edit" : "user_edit"),
            changeSummary: input.changeSummary ?? null,
            body: input.body,
            createdAt: now,
          })
          .returning();

        await tx
          .update(documents)
          .set({
            latestRevisionId: revision.id,
            updatedAt: now,
          })
          .where(eq(documents.id, existing.id));

        if (actor.agentId) {
          await tx
            .insert(documentAgentStates)
            .values({
              companyId: existing.companyId,
              documentId: existing.id,
              agentId: actor.agentId,
              lastDeliveredRevisionId: null,
              lastWrittenRevisionId: revision.id,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [documentAgentStates.agentId, documentAgentStates.documentId],
              set: {
                lastWrittenRevisionId: revision.id,
                updatedAt: now,
              },
            });
        }

        if (existing.scope === "approval" && existing.approvalId) {
          await updateApprovalPayloadDocumentMetadata(
            tx,
            existing.approvalId,
            existing.id,
            existing.title,
            input.body,
          );
        }

        const [document] = await hydrateDocuments(
          tx,
          [{ ...existing, latestRevisionId: revision.id, updatedAt: now }],
          actor.agentId ?? null,
        );
        return {
          document: document!,
          revision: {
            id: revision.id,
            companyId: revision.companyId,
            documentId: revision.documentId,
            revisionNumber: revision.revisionNumber,
            parentRevisionId: revision.parentRevisionId ?? null,
            authorAgentId: revision.authorAgentId ?? null,
            authorUserId: revision.authorUserId ?? null,
            source: revision.source,
            changeSummary: revision.changeSummary ?? null,
            body: revision.body,
            createdAt: revision.createdAt,
          },
        };
      });
    },

    listChangedRelevantDocumentsForAgent: async (agentId: string) => {
      const agent = await db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);
      if (!agent) throw notFound("Agent not found");

      const [assignedIssues, requestedApprovals, linkedApprovals] = await Promise.all([
        db
          .select({ projectId: issues.projectId })
          .from(issues)
          .where(and(eq(issues.companyId, agent.companyId), eq(issues.assigneeAgentId, agent.id))),
        db
          .select({ id: approvals.id })
          .from(approvals)
          .where(and(eq(approvals.companyId, agent.companyId), eq(approvals.requestedByAgentId, agent.id))),
        db
          .select({ approvalId: issueApprovals.approvalId })
          .from(issueApprovals)
          .innerJoin(issues, eq(issueApprovals.issueId, issues.id))
          .where(and(eq(issueApprovals.companyId, agent.companyId), eq(issues.assigneeAgentId, agent.id))),
      ]);

      const projectIds = Array.from(
        new Set(
          assignedIssues
            .map((row) => row.projectId)
            .filter((value): value is string => Boolean(value)),
        ),
      );
      const approvalIds = Array.from(
        new Set([
          ...requestedApprovals.map((row) => row.id),
          ...linkedApprovals.map((row) => row.approvalId),
        ]),
      );

      const day = utcDayString();
      const docs: Document[] = [];
      docs.push(await getOrCreateAgentDailyDocument(agent.id, day, undefined, agent.id));
      for (const projectId of projectIds) {
        docs.push(await getOrCreateProjectDocument(projectId, undefined, agent.id));
      }
      for (const approvalId of approvalIds) {
        docs.push(await getOrCreateApprovalDocument(approvalId, undefined, agent.id));
      }

      const deduped = Array.from(new Map(docs.map((doc) => [doc.id, doc])).values());
      return deduped.filter((doc) => doc.hasUndeliveredChanges && doc.latestRevision);
    },

    markDeliveredToAgent: async (
      agentId: string,
      docsToMark: Array<Pick<Document, "id" | "companyId" | "latestRevisionId">>,
    ) => {
      const now = new Date();
      for (const doc of docsToMark) {
        if (!doc.latestRevisionId) continue;
        await db
          .insert(documentAgentStates)
          .values({
            companyId: doc.companyId,
            documentId: doc.id,
            agentId,
            lastDeliveredRevisionId: doc.latestRevisionId,
            lastWrittenRevisionId: null,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [documentAgentStates.agentId, documentAgentStates.documentId],
            set: {
              lastDeliveredRevisionId: doc.latestRevisionId,
              updatedAt: now,
            },
          });
      }
    },
  };
}
