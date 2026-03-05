# Telegram Integration Spec

Telegram supergroup with Topics enabled as a mobile interface to Paperclip.

## Channel Structure

```
Paperclip HQ (Supergroup, Topics enabled)
+-- Approvals        -- things waiting on you, inline buttons
+-- Status           -- DONE/BLOCKED feed (muted by default)
+-- Alice            -- chat with Alice
+-- Bob              -- chat with Bob
+-- Carol            -- chat with Carol
```

One topic per agent, auto-created when an agent is added. Two system topics (Approvals, Status) are created on setup.

## Per-Agent Topic

Flat conversation with the agent. No threads. You talk, they respond with personality derived from their existing fields (title, capabilities, role).

The agent topic is a DM-style chat. Messages you send trigger a wakeup. The agent responds via a telegram tool during execution.

Example:

```
You: Hey, the auth timeout is happening again on staging
Alice: On it -- I remember we hit this before with the Redis TTL.
       Let me check if it regressed.
Alice: Yep, the TTL got reset in last week's config migration.
       Fixing now and adding a test so it doesn't drift again.
Alice: Done -- PR #127 is up. Bumped TTL back to 3600s and
       added a config assertion.
You: /new Add retry logic to the webhook handler
Alice: Created PAP-47. I'll pick this up next.
```

## `/new` Command

Create a ticket from any topic.

```
/new Fix the auth timeout --owner alice

/new Add webhook retry logic
This should use exponential backoff with jitter.
Max 3 retries, then dead-letter to the failures queue.
```

| Part | Behavior |
|------|----------|
| First line after `/new` | Title |
| `--owner <name>` | Assigns to that agent. Defaults to the current topic's agent if in an agent topic. |
| Remaining lines | Description |

## Status Topic

Muted by default. Compact one-liners for DONE and BLOCKED events only.

```
[check] Alice -- PAP-42 "Fix auth timeout" -> done
[block] Bob -- PAP-45 "Add rate limiting" -> blocked: need staging Redis creds
[check] Carol -- PAP-44 "Update onboarding flow" -> done
```

## Approvals Topic

Approval requests with inline keyboard buttons.

```
Alice: PAP-42 -- requesting approval to deploy auth fix to prod
[Approve] [Reject]

Bob: PAP-48 -- wants to add a DB migration (new index on users.email)
[Approve] [Reject]
```

Tapping Approve/Reject calls the approvalService and posts confirmation.

## Message Flow

### You -> Agent (in their topic)

```
Your message
  -> bot receives update, maps topic_id -> agent_id
  -> heartbeat.wakeup(reason: "telegram_message", payload: { text })
  -> agent wakes, sees message, responds via telegram tool
  -> bot posts agent's response in same topic
```

Free-form chat, not ticket-scoped. The agent decides whether to create/update tickets based on the conversation.

### Agent -> You (status updates)

```
Agent completes/blocks a task
  -> live event emitted
  -> Telegram service posts to:
     1. Agent's topic (conversational update)
     2. Status topic (compact one-liner)
     3. Approvals topic (if approval needed)
```

## Agent Telegram Tool

Available to agents during execution:

```typescript
telegram.send(agentId, "Looking into this now...")
telegram.send(agentId, "Done -- PR #127 is up")
telegram.send(agentId, "Blocked -- need the staging API key")
```

Messages go to the agent's topic. DONE/BLOCKED messages are also mirrored to the Status topic automatically based on keyword detection or explicit status flags.

## Configuration

Added to the existing config schema:

```typescript
telegram: {
  botToken: string,       // Telegram Bot API token
  chatId: string,         // Supergroup chat ID
  topicMapping: Record<string, number>,  // agentId -> topic message_thread_id
  statusTopicId: number,  // Status topic message_thread_id
  approvalsTopicId: number // Approvals topic message_thread_id
}
```

## Implementation Components

| Component | Location | Purpose |
|-----------|----------|---------|
| Telegram bot service | `server/src/services/telegram.ts` | Bot setup, message routing, topic management |
| Telegram config | `packages/shared/src/config-schema.ts` | Bot token, chat ID, topic mappings |
| Telegram tool | Adapter execution context | `telegram.send()` for agents |
| `/new` parser | Bot command handler | Parse title, --owner, multiline description |
| Status mirror | Live events subscriber | DONE/BLOCKED -> Status topic |
| Approval buttons | Inline keyboard callbacks | Approve/reject -> approvalService |
| Topic provisioning | Setup command or auto-sync | Create/rename topics to match agents |

## Design Constraints

- Single human user (no multi-user permissions design needed)
- Agent personality comes from existing agent fields (title, capabilities, role) -- no separate soul document
- Company-scoped: all Telegram activity is within one company context
- Bot must map topic IDs to agent IDs bidirectionally
- Messages from the bot should be idempotent where possible (don't duplicate status messages)
