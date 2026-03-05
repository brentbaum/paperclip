# Telegram Integration Implementation Plan

## Scope and Constraints
- Add Telegram supergroup Topics as a mobile interface for one Paperclip company.
- No new database tables.
- Keep existing service pattern: factory functions returning method objects.
- Use existing `heartbeatService` for wakeups and existing live events for status mirroring.
- Keep company boundaries strict for all reads/writes.
- Keep behavior deployable in phases.

## Library Choice
- Use `grammy` (not `node-telegram-bot-api`).
- Reason: stronger TypeScript ergonomics, clean middleware model, built-in support for polling and webhook, easy callback query handling, lower glue code for retries and bot lifecycle.

## Core Architecture Decisions
- Telegram integration lives in `server/src/services/telegram.ts` as a service factory.
- Telegram topic mapping is persisted in config (`packages/shared/src/config-schema.ts`) and written atomically back to config file when auto-provisioning creates new topics.
- Start in polling mode by default; add webhook mode in final phase for public deployments.
- Subscribe to `subscribeCompanyLiveEvents(companyId, ...)` and mirror:
  - `activity.logged` events with `action=issue.updated` and `details.status in {done, blocked}` to Status topic.
  - `activity.logged` events with `action=approval.created` to Approvals topic with inline buttons.
- Inbound Telegram messages:
  - Agent topic text wakes mapped agent via `heartbeat.wakeup(...reason="telegram_message"...)`.
  - `/new` command creates issue via `issueService` and logs activity.
- Agent Telegram tool:
  - Expose an authenticated API endpoint for agent runs.
  - Inject tool contract into adapter execution context (`context.paperclipTools.telegram`) so adapter prompts/skills can call it consistently.

## Phase 1: Foundation, Config, Outbound Messaging, Topic Provisioning
Deployable outcome: Telegram can be enabled, bot starts, system/agent topics can be provisioned, test messages can be sent.

### Files to create
- `server/src/services/telegram.ts`
- `server/src/routes/telegram.ts`
- `server/src/__tests__/telegram-topic-sync.test.ts`
- `server/src/__tests__/telegram-startup.test.ts`

### Files to modify
- `server/package.json` (add `grammy`)
- `packages/shared/src/config-schema.ts`
- `packages/shared/src/index.ts`
- `server/src/config.ts`
- `server/src/config-file.ts` (add atomic write helper)
- `server/src/services/index.ts`
- `server/src/routes/index.ts`
- `server/src/app.ts`
- `server/src/index.ts`

### Key interfaces (pseudocode)
```ts
// packages/shared/src/config-schema.ts
type TelegramConfig = {
  botToken: string;
  chatId: string;
  topicMapping: Record<string, number>; // agentId -> message_thread_id
  statusTopicId: number;
  approvalsTopicId: number;
};

// server/src/services/telegram.ts
export function telegramService(db: Db, deps: {
  config: Config;
  heartbeat: ReturnType<typeof heartbeatService>;
  approvals: ReturnType<typeof approvalService>;
  issues: ReturnType<typeof issueService>;
  agents: ReturnType<typeof agentService>;
}) {
  return {
    start(): Promise<void>;
    stop(): Promise<void>;
    syncTopics(companyId: string): Promise<{
      statusTopicId: number;
      approvalsTopicId: number;
      topicMapping: Record<string, number>;
      createdTopics: Array<{ agentId: string; topicId: number }>;
    }>;
    sendToAgentTopic(input: {
      companyId: string;
      agentId: string;
      text: string;
      idempotencyKey?: string;
      mirrorStatus?: "done" | "blocked" | null;
    }): Promise<{ ok: true; messageId: number } | { ok: false; error: string }>;
  };
}
```

### Implementation notes
- Service is no-op when `telegram.botToken` or `telegram.chatId` is missing.
- Add board-only route: `POST /api/companies/:companyId/telegram/sync-topics`.
- Add board-only route: `POST /api/companies/:companyId/telegram/test-message`.
- Provisioning behavior:
  - Ensure Approvals and Status topics exist.
  - Ensure one topic per active non-terminated agent.
  - Persist new IDs into config file atomically.
- `index.ts` starts/stops Telegram service alongside server lifecycle.

### Test plan
- Config schema validates telegram block and defaults mapping object.
- Startup test: service does not start when config missing.
- Sync test: creates missing system topics and agent topics; writes mapping once.
- Sync idempotency test: second sync does not create duplicates when mapping exists.
- API route test: non-board access denied for sync routes.

### Deployment notes
- Add bot token and chat ID to config.
- Run sync endpoint once after bot is added to supergroup.
- No behavior impact to heartbeats/issues if telegram is disabled.

---

## Phase 2: Inbound Routing and `/new` Command
Deployable outcome: human can message agents in topic threads; `/new` creates issues from Telegram.

### Files to create
- `server/src/services/telegram-new-parser.ts`
- `server/src/__tests__/telegram-new-parser.test.ts`
- `server/src/__tests__/telegram-inbound-routing.test.ts`

### Files to modify
- `server/src/services/telegram.ts`

### `/new` parser spec
| Input part | Rule |
|---|---|
| Command token | Accept `/new` and `/new@<botname>` |
| First line after command | Required title (after stripping optional `--owner`) |
| `--owner <name>` | Optional owner reference; resolve with `agentService.resolveByReference` |
| Remaining lines | Optional multiline description (preserve newlines) |
| No owner in agent topic | Default to topic's mapped agent |
| No owner outside agent topic | Return usage error |
| Empty title | Return validation error |

### Key interfaces (pseudocode)
```ts
type ParsedNewCommand = {
  title: string;
  description: string | null;
  ownerRef: string | null;
};

type NewCommandParseErrorCode =
  | "missing_title"
  | "missing_owner_outside_agent_topic"
  | "invalid_owner_flag";

function parseNewCommand(text: string): ParsedNewCommand | {
  ok: false;
  code: NewCommandParseErrorCode;
  message: string;
};
```

### Implementation notes
- Inbound message handling:
  - Ignore bot-originated messages.
  - Resolve topic to agent via reverse mapping.
  - For non-command text in agent topic: call `heartbeat.wakeup(agentId, { source: "automation", reason: "telegram_message", payload, contextSnapshot })`.
- `/new` behavior:
  - Create issue with `status: "todo"` when assignee resolved.
  - `createdByUserId` uses board operator identity (`"board"` in local trusted mode).
  - Log `issue.created` activity with source metadata (`source: "telegram"`).
  - Reply in topic with created identifier (`PAP-xx`).

### Test plan
- Parser tests for inline owner, multiline description, missing title, missing owner.
- Inbound routing test: mapped topic triggers wakeup with expected payload/context.
- `/new` test: creates issue in correct company, assigns expected agent.
- `/new` ambiguity test: ambiguous owner returns clear error message in topic.

### Deployment notes
- Requires bot privacy mode disabled in group topics.
- First end-to-end smoke: send plain text in agent topic and verify heartbeat queued event.

---

## Phase 3: Approvals Inline Buttons, Status Mirroring, Agent Telegram Tool Injection
Deployable outcome: full loop for status feed, approvals buttons, and agent-generated Telegram updates.

### Files to create
- `packages/shared/src/types/telegram.ts`
- `packages/shared/src/validators/telegram.ts`
- `server/src/routes/agent-tools.ts`
- `server/src/__tests__/telegram-approvals-callback.test.ts`
- `server/src/__tests__/telegram-status-mirror.test.ts`
- `server/src/__tests__/heartbeat-telegram-tool-context.test.ts`

### Files to modify
- `packages/shared/src/types/index.ts`
- `packages/shared/src/validators/index.ts`
- `packages/shared/src/api.ts`
- `packages/shared/src/index.ts`
- `server/src/routes/index.ts`
- `server/src/app.ts`
- `server/src/services/telegram.ts`
- `server/src/services/heartbeat.ts`
- `packages/adapters/claude-local/src/server/execute.ts`
- `packages/adapters/codex-local/src/server/execute.ts`
- `skills/paperclip/SKILL.md`

### Key interfaces (pseudocode)
```ts
// Shared request shape for agent tool endpoint
type TelegramSendRequest = {
  agentId: string;
  text: string;
  status?: "done" | "blocked";
  issueId?: string | null;
  idempotencyKey?: string;
};

// Callback data kept below Telegram 64-byte limit
type ApprovalCallbackData = `pc:a:${string}` | `pc:r:${string}`; // approve/reject + approvalId

// Injected adapter context contract
type PaperclipToolsContext = {
  telegram?: {
    sendEndpoint: "/api/agent-tools/telegram/send";
    defaultAgentId: string;
    supportsStatusFlags: true;
  };
};
```

### Approval inline keyboard flow
- On `activity.logged` where `action="approval.created"`:
  - Fetch approval details.
  - Post message in approvals topic.
  - Attach inline keyboard: Approve/Reject.
- On callback query:
  - Parse callback data.
  - Call `approvalService.approve` or `approvalService.reject`.
  - On success: edit message text to include final decision and remove buttons.
  - On already-resolved approval: answer callback with current status and do not mutate.
  - Log activity for callback decisions with source `telegram_callback`.

### Status mirroring flow
- Subscribe to live events.
- Mirror only when:
  - event type is `activity.logged`
  - action is `issue.updated`
  - `details.status` is `done` or `blocked`
- Build compact one-liner and send to Status topic.
- Deduplicate with in-memory TTL key: `companyId:issueId:status:runId`.

### Telegram tool injection into adapter execution context
- In `heartbeat.ts`, before `adapter.execute(...)`, enrich context:
```ts
const toolsContext: PaperclipToolsContext = {
  telegram: {
    sendEndpoint: "/api/agent-tools/telegram/send",
    defaultAgentId: agent.id,
    supportsStatusFlags: true,
  },
};

await adapter.execute({
  ...adapterCtx,
  context: { ...adapterCtx.context, paperclipTools: toolsContext },
});
```
- In adapter executors, forward `context.paperclipTools` into env (e.g., `PAPERCLIP_TOOLS_JSON`) for skills/prompts.
- `skills/paperclip/SKILL.md` documents `telegram.send(...)` behavior via authenticated API call.

### Test plan
- Callback tests: approve, reject, already-approved idempotency behavior.
- Status mirror tests: done/blocked are mirrored; other status updates ignored.
- Dedupe test: repeated same done event emits one status message.
- Tool endpoint auth tests:
  - agent can send for self
  - agent cannot spoof another agent ID
  - company mismatch rejected
- Heartbeat context test: `paperclipTools.telegram` present for adapter execute call.

### Deployment notes
- Verify bot has permission to post in Approvals and Status topics.
- Validate callback behavior from mobile client.
- If tool endpoint fails, heartbeat/task processing must continue unaffected.

---

## Phase 4: Reliability, Webhook Mode, CLI/Docs, Operational Hardening
Deployable outcome: production-safe behavior with retry policy, optional webhook mode, and operator tooling.

### Files to create
- `cli/src/prompts/telegram.ts`
- `server/src/__tests__/telegram-retry-policy.test.ts`
- `server/src/__tests__/telegram-webhook-security.test.ts`

### Files to modify
- `server/src/services/telegram.ts`
- `server/src/index.ts`
- `server/src/app.ts`
- `cli/src/index.ts`
- `cli/src/commands/configure.ts`
- `cli/src/commands/env.ts`
- `doc/DEVELOPING.md`
- `doc/telegram-spec.md`

### Retry/log/degrade strategy
- Retry on transient failures only: network errors, HTTP 429, HTTP 5xx.
- Backoff: exponential with jitter, max 3 attempts.
- Respect Telegram `retry_after` when present.
- Do not retry permanent failures: 400/401/403/404.
- Never throw Telegram failures into core workflows:
  - wakeups still queue
  - issue/approval mutations still commit
- Log with structured fields: `companyId`, `agentId`, `topicId`, `telegramMethod`, `attempt`, `errorCode`.
- Emit activity event for repeated failures: `telegram.delivery_failed`.

### Polling vs webhook mode
- Default: polling (`PAPERCLIP_TELEGRAM_MODE=polling`) for local/private deployments.
- Optional webhook (`PAPERCLIP_TELEGRAM_MODE=webhook`) for authenticated/public deployments.
- Webhook security:
  - random secret path segment and secret-token header validation
  - reject updates not from configured chat/thread context
- Keep same handler logic for both modes so behavior remains identical.

### BotFather setup checklist
- `/newbot` to create bot token.
- Add bot to supergroup and grant topic-post permissions.
- `/setprivacy` -> Disable (to receive non-command topic messages).
- `/setjoingroups` -> Enable.
- `/setcommands` -> `new - Create a Paperclip issue`.
- Obtain `chatId` by reading first update after posting in group.
- Run topic sync after setup and after major agent roster changes.

### Test plan
- Retry policy unit tests for 429 and transient network errors.
- Permanent error test confirms no retry loop.
- Webhook secret validation tests.
- CLI configure test includes telegram section persistence.
- End-to-end smoke (manual): message agent topic -> wakeup -> agent tool send -> status mirror -> approval callback.

### Deployment notes
- Roll out behind config flag (telegram disabled by default).
- Enable Phase 4 after Phase 3 is stable in staging.
- Verify full pre-handoff checks:
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm build`

## Final Acceptance Criteria
- One supergroup with Topics supports agent conversation, status feed, and approvals actions.
- `/new` works in any topic with deterministic owner resolution.
- Agent topic messages wake the correct agent via heartbeat.
- Agent tool can send Telegram updates and mirror done/blocked to Status topic.
- Approve/Reject buttons mutate approval state idempotently.
- Telegram outages do not break core Paperclip orchestration.
