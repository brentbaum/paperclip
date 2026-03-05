# Paperclip Documents Spec

Status: Draft
Date: 2026-03-05
Audience: Product and engineering

## 1. Role

This document defines the V1 document subsystem for Paperclip.

Documents are governed markdown artifacts that belong to the control plane itself. They exist to support review, planning, and persistent coordination in places where tasks/comments are too small or too transient.

V1 documents are intentionally narrow:

- approval documents for long-form plans under review
- project documents for briefs/specs
- agent daily scratchpads for notes exchanged across heartbeats

This is not a general knowledge base, not a file system, and not a collaborative office suite.

## 2. Product Goals

V1 must support these workflows:

1. An agent proposes a plan, the board edits it directly, then approves or requests revision.
2. Each agent has a daily scratchpad the board can write into and the agent can pick up on heartbeat.
3. Each project has a durable primary document.
4. The board can always answer: "What exactly did the agent change?"

## 3. Non-Goals

V1 documents do not include:

- realtime multiplayer cursor sync
- Word-style inline tracked-changes rendering
- arbitrary nested page trees
- wiki/global search/vector retrieval
- rich file attachments beyond existing asset support
- block-based structured editing requirements

Revision history plus diff comparison is sufficient for V1.

## 4. Core Model

## 4.1 Documents

A `document` is the stable identity and scope owner.

Fields:

- `company_id`
- `scope`: `project | approval | agent_daily`
- scope owner ids (`project_id`, `approval_id`, `agent_id`, `day`)
- `title`
- `format = markdown`
- `latest_revision_id`

Scope rules:

- one primary project document per project
- one approval document per approval
- one daily document per agent per UTC date

## 4.2 Document Revisions

A `document_revision` is an append-only full snapshot.

Fields:

- `document_id`
- `revision_number`
- `parent_revision_id`
- author attribution (`author_user_id` or `author_agent_id`)
- `source`
- optional `change_summary`
- `body`
- `created_at`

V1 stores full markdown snapshots rather than patches. This keeps writes simple and makes diff generation deterministic.

## 4.3 Agent Delivery State

`document_agent_state` tracks which revision of a relevant document was last delivered to an agent.

This enables:

- heartbeat payloads to include only changed docs
- UI badges like "updated since last heartbeat"
- a simple audit trail of what the system has already surfaced to an agent

V1 records delivery on successful heartbeat invoke handoff. Stronger read acknowledgements can be added later if needed.

## 5. Revision and Diff Semantics

V1 uses revision history, not inline tracked changes, as the review primitive.

That means:

- every save creates a new revision
- users compare any two revisions in a diff view
- the current document is always the latest revision
- authorship is shown per revision, not per character span

Why:

- it is editor-agnostic
- it works with markdown storage
- it avoids locking Paperclip into a specific commercial editor vendor
- it answers the actual product need: "show me what changed"

## 6. Editor Strategy

V1 keeps markdown as the canonical format and uses the existing markdown editor surface.

Rationale:

- Paperclip already ships markdown editing
- the core missing primitive is revisioned documents, not richer editor chrome
- switching to a new editor before the data model exists would increase risk and couple product decisions to vendor capabilities

Future editor upgrades remain open once the document model is stable.

## 7. Scope-Specific Behavior

## 7.1 Approval Documents

`approve_ceo_strategy` approvals must have one approval-scoped document.

Behavior:

- the document is the canonical plan under review
- approval comments remain available for targeted feedback
- request-revision keeps the same approval and same document identity
- resubmission appends more revisions to the same document

The approval payload should hold summary metadata and a document reference, not the canonical markdown body.

## 7.2 Agent Daily Scratchpads

Each agent may have one scratchpad per UTC date, for example `2026-03-05`.

Behavior:

- the board can write notes into today's scratchpad
- the next heartbeat receives unseen revisions for today's scratchpad
- the agent may edit the same scratchpad back
- previous days remain visible as read-only history by default in the UI

Daily docs are meant for ongoing operating context, not permanent institutional knowledge.

## 7.3 Project Documents

Each project has one primary document used for:

- brief
- spec
- progress notes
- operating context for agents working inside the project

The document should be visible directly from the project detail view, not buried in a separate docs area.

## 8. Heartbeat Semantics

Relevant documents for an agent heartbeat in V1:

- today's scratchpad for that agent
- project docs for projects attached to the agent's assigned issues
- approval docs for approvals requested by that agent or gating its work

Context payload should include, for each changed doc:

- `documentId`
- `scope`
- `title`
- `latestRevisionId`
- `updatedAt`
- markdown `body`

V1 does not require CRDT sync or live collaborative editing. Heartbeat delivery is asynchronous and revision-based.

## 9. API Shape

Minimum V1 endpoints:

- scope resolution:
  - `GET /projects/:projectId/document`
  - `GET /approvals/:approvalId/document`
  - `GET /agents/:agentId/daily-document?day=YYYY-MM-DD`
- document read:
  - `GET /documents/:documentId`
  - `GET /documents/:documentId/revisions`
  - `GET /documents/:documentId/revisions/:revisionId`
  - `GET /documents/:documentId/diff?from=:revisionId&to=:revisionId`
- document write:
  - `POST /documents/:documentId/revisions`

Write contract:

- caller supplies a base revision id
- server rejects stale writes with `409`
- server appends a new revision on success

## 10. UI Shape

V1 document UI should live inside existing entity detail pages:

- Approval detail:
  - editable strategy doc
  - revision history
  - diff against previous revision
  - approve / request revision / reject actions
- Agent detail:
  - scratchpad tab keyed to today's date
  - recent prior dates visible in a simple list
  - "updated since last heartbeat" badge
- Project detail:
  - primary doc shown as a first-class panel or tab
  - revision history and diff access

There should not be a separate generic documents workspace in V1.

## 11. Security and Governance

Documents are company-scoped.

Rules:

- board can read/write any document in the company
- agents can read documents in their company
- agents should only be prompted/tool-guided to edit relevant documents
- every revision is attributable to either a user or an agent
- document edits are auditable through revision history and activity events

## 12. Open Follow-Ups

These are intentionally deferred beyond V1:

- richer compare UI with semantic markdown diffs
- comments anchored to a document selection
- explicit read acknowledgements from agents
- issue-scoped documents
- company-scoped operating manual documents
- editor migration to BlockNote or Tiptap if revision-based V1 proves insufficient
