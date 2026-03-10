# Remote Execution Implementation Plan

## Overview

This plan implements the model defined in [doc/ssh-remote-execution-spec.md](../ssh-remote-execution-spec.md):

- existing agents keep their normal adapter type and identity
- issues can opt into `Run remotely`
- remote execution persists as a per-issue lease
- the remote runtime reuses the same repo, branch, and lease across resumes
- successful runs push a branch and create or update a PR

This replaces "dedicated remote agents" as the primary model. Remote becomes an execution venue, not an adapter identity.

## Goals

1. Let the board mark an issue to run remotely without changing the assigned agent.
2. Persist remote state per issue so comments and follow-up runs reuse the same remote workspace.
3. Keep local and remote session state separate and predictable.
4. Reuse existing adapter semantics (`claude_local`, `codex_local`, `opencode_local`, `cursor`) on remote hosts.
5. End remote code runs in a reviewable artifact: stable branch plus PR metadata.

## Non-Goals

- General-purpose distributed job scheduling across a host fleet.
- Full container isolation in V1.
- Perfect local-to-remote session portability for every adapter.

## Current Baseline

Relevant existing surfaces:

- issue-level execution lock fields already exist on `issues` in [packages/db/src/schema/issues.ts](/Users/brentbaum/dev/tools/paperclip-trial/paperclip/packages/db/src/schema/issues.ts)
- issue-level assignee overrides already exist in [packages/shared/src/types/issue.ts](/Users/brentbaum/dev/tools/paperclip-trial/paperclip/packages/shared/src/types/issue.ts)
- workspace resolution already happens in [server/src/services/heartbeat.ts](/Users/brentbaum/dev/tools/paperclip-trial/paperclip/server/src/services/heartbeat.ts)
- the current SSH path is still modeled as an adapter type in [packages/shared/src/constants.ts](/Users/brentbaum/dev/tools/paperclip-trial/paperclip/packages/shared/src/constants.ts), [server/src/adapters/ssh/execute.ts](/Users/brentbaum/dev/tools/paperclip-trial/paperclip/server/src/adapters/ssh/execute.ts), and [ui/src/adapters/ssh/config-fields.tsx](/Users/brentbaum/dev/tools/paperclip-trial/paperclip/ui/src/adapters/ssh/config-fields.tsx), but this plan removes that path instead of preserving it
- issue creation already has a place for per-issue assignee behavior in [ui/src/components/NewIssueDialog.tsx](/Users/brentbaum/dev/tools/paperclip-trial/paperclip/ui/src/components/NewIssueDialog.tsx)

This means the implementation should extend the issue/run model rather than invent a parallel agent model.

## Key Decisions

1. `Run remotely` lives on the issue, not the agent.
2. Remote execution requires a repository source, preferably from project workspace metadata with fallback inference from the assigned agent's configured `cwd`.
3. Remote state persists as a first-class lease record.
4. Session state must be keyed by execution venue and remote lease context to avoid local/remote collisions.
5. The remote worker evolves into a generic adapter host, not a Claude-only SSH wrapper.
6. The current `ssh` adapter path should be deleted as part of this work, not preserved as a legacy option.

## TDD Strategy

This feature should be built test-first around stable seams, not around ad hoc SSH/manual runs.

### Recommended test pyramid

1. Pure unit tests for:
   - execution mode validation
   - repo source resolution
   - branch naming
   - session scope keying
   - lightweight agent-file filtering
   - runtime file remapping
   - git identity resolution
2. Service/integration tests against the app DB for:
   - issue remote mode persistence
   - remote target validation
   - lease creation/reuse
   - heartbeat venue resolution
3. Worker protocol integration tests for:
   - remote worker payload generation
   - remote event parsing
   - branch/PR metadata propagation
4. Smoke tests against a real SSH target for:
   - SSH connectivity
   - worker presence
   - end-to-end remote execution on an actual machine

### Recommended harnesses

- Primary red/green loop: hermetic unit and DB-backed integration tests in Vitest.
- Preferred remote integration harness: disposable local SSH target container or VM when a local container runtime is available.
- Real Tailscale host: smoke coverage only, not the main TDD loop.

Local SSH target commands:

```sh
./scripts/ssh-test-target.sh start
ssh -i /tmp/paperclip-ssh-test-target/id_ed25519 -p 2222 brewuser@127.0.0.1 'echo ok'
./scripts/ssh-test-target.sh stop
```

### Why

- The feature has a lot of orchestration logic that does not need a real machine to test.
- Real SSH hosts are useful for final proof, but too slow and too stateful for the tight red/green cycle.
- A local SSH container is the best deterministic remote harness when Docker/OrbStack is available.
- If no local container runtime is available, keep the core integration tests hermetic and run real-host smoke tests by explicit env opt-in.

## Workstreams

## 1. Data Model And Shared Contracts

### 1.0 Remove `ssh` as an agent adapter type

Remove `ssh` from first-class adapter registration:

- shared adapter constants
- server adapter registry
- UI adapter registry
- agent configuration UI

Any remaining remote execution configuration should move to remote execution targets, not agent adapter config.

### 1.1 Issue execution policy

Add explicit issue-level execution fields.

Recommended additions to `issues`:

- `execution_mode: text not null default 'default'`
- `execution_target_id: uuid null`

Shared contract updates:

- extend `Issue` type/validator
- extend create/update issue schemas
- keep `assigneeAdapterOverrides` focused on adapter behavior, not venue

### 1.2 Remote execution targets

Add a company-scoped table for remote targets, for example `remote_execution_targets`:

- `id`
- `company_id`
- `name`
- `host`
- `user`
- `worker_path`
- `api_url`
- `supported_adapters_json`
- `default_repo_auth_strategy`
- `default_pr_auth_strategy`
- `max_concurrent_leases`
- `metadata`
- timestamps

Purpose:

- separate host configuration from agent config
- make remote selection reusable across issues
- support future host pools

Note:

- `api_url` is reserved for future target-local APIs and is not required for SSH execution in the current design

### 1.3 Remote issue leases

Add a first-class `remote_execution_leases` table:

- `id`
- `company_id`
- `issue_id`
- `agent_id`
- `adapter_type`
- `execution_target_id`
- `status`
- `remote_root`
- `repo_url`
- `base_ref`
- `branch_name`
- `pull_request_url`
- `pull_request_number`
- `last_pushed_commit_sha`
- `session_state_json`
- `last_run_id`
- `expires_at`
- `destroyed_at`
- timestamps

Invariants:

- at most one active lease per `(issue_id, adapter_type, execution_target_id)`
- lease must belong to same company as issue and agent

### 1.4 Session persistence changes

Current `agent_task_sessions` uniqueness is `(company, agent, adapter, taskKey)`.

That is not strong enough once the same task can run locally or remotely. Extend session persistence with one of:

- `execution_scope: local | remote`
- `remote_execution_lease_id: uuid | null`

Recommended approach:

- add `execution_scope`
- add `remote_execution_lease_id`
- update uniqueness to include both

This avoids local/remote resume collisions.

### 1.5 Exact Phase 1 file-by-file task list

Schema:

- update [packages/db/src/schema/issues.ts](/Users/brentbaum/dev/tools/paperclip-trial/paperclip/packages/db/src/schema/issues.ts) with `execution_mode` and `execution_target_id`
- update [packages/db/src/schema/agent_task_sessions.ts](/Users/brentbaum/dev/tools/paperclip-trial/paperclip/packages/db/src/schema/agent_task_sessions.ts) with venue-aware session fields
- add `packages/db/src/schema/remote_execution_targets.ts`
- add `packages/db/src/schema/remote_execution_leases.ts`
- export both from [packages/db/src/schema/index.ts](/Users/brentbaum/dev/tools/paperclip-trial/paperclip/packages/db/src/schema/index.ts)
- generate and apply a migration

Shared contracts:

- update [packages/shared/src/constants.ts](/Users/brentbaum/dev/tools/paperclip-trial/paperclip/packages/shared/src/constants.ts) to remove `ssh` from agent adapter types and add remote execution constants
- update [packages/shared/src/types/issue.ts](/Users/brentbaum/dev/tools/paperclip-trial/paperclip/packages/shared/src/types/issue.ts)
- update [packages/shared/src/validators/issue.ts](/Users/brentbaum/dev/tools/paperclip-trial/paperclip/packages/shared/src/validators/issue.ts)
- add shared types/validators for remote targets and leases

Server/API:

- update issue create/update handling in [server/src/routes/issues.ts](/Users/brentbaum/dev/tools/paperclip-trial/paperclip/server/src/routes/issues.ts)
- add remote target routes and service
- add lease read/reset routes and service

Initial tests to write before implementation:

- issue validator accepts `executionMode=remote` only with valid target ids
- `ssh` is no longer accepted as an agent adapter type
- agent task sessions do not collide across `local` and `remote`
- a lease cannot point across companies

## 2. API And Service Layer

### 2.1 Issue APIs

Update issue routes and validators to accept:

- `executionMode`
- `executionTargetId`

Validation rules:

- `executionMode = remote` requires `assigneeAgentId`
- `executionMode = remote` requires a resolvable repo source before run start
- `executionTargetId` must belong to the same company

### 2.2 Remote target APIs

Add CRUD endpoints for board use:

- list/create/update/archive remote execution targets

This should mirror the rest of the company-scoped admin surfaces.

### 2.3 Lease APIs

Add read/reset actions for remote leases:

- get lease by issue
- reset/destroy lease
- optionally force reprovision

This is important for recovery when a remote host or repo gets into a bad state.

## 3. Heartbeat And Orchestration

### 3.1 Execution venue resolution

Extend [server/src/services/heartbeat.ts](/Users/brentbaum/dev/tools/paperclip-trial/paperclip/server/src/services/heartbeat.ts) so a run resolves:

- adapter type from the assigned agent
- execution mode from the issue
- remote target from the issue or company defaults
- lease record for remote runs

This should happen before adapter execution begins.

### 3.2 Workspace resolution

Keep using project workspace repo metadata as the source of truth where possible.

Adjust workspace resolution so remote runs derive:

- `repoUrl`
- `baseRef`
- stable branch name
- remote lease root

If project metadata is absent, remote mode should fall back to git-based inference from the assigned agent's configured `cwd`. Remote mode should still fail clearly if no repo source can be resolved.

### 3.3 Session separation

Update task session lookup/upsert logic so:

- local runs only see local sessions
- remote runs only see sessions tied to the relevant lease
- switching an issue from local to remote does not silently reuse an invalid session ID

### 3.4 Run metadata

Include remote metadata in run context and UI-visible state:

- execution mode
- target id/name
- lease id
- branch name
- PR URL

## 4. Remote Runtime And Worker

### 4.1 Generalize the remote worker

The current worker in [packages/remote-worker/src/worker.ts](/Users/brentbaum/dev/tools/paperclip-trial/paperclip/packages/remote-worker/src/worker.ts) is Claude-oriented.

Refactor it into a generic remote adapter host that can:

- receive `adapterType`
- receive adapter config + agent/runtime file materializations
- materialize a clean remote repo worktree
- overlay lightweight agent files and transient runtime files
- invoke the matching adapter runtime remotely
- stream structured events back

### 4.1.1 Maximal reuse rule

Remote Codex and remote Claude should not be implemented as separate adapters.

Required rule:

- one Codex adapter core
- one Claude adapter core
- two transports for each: local and remote

That means the worker should call the same adapter-core code used by local execution for:

- prompt building
- env wiring
- instructions loading
- session compatibility checks
- stream parsing
- usage/cost extraction
- adapter-specific failure detection

Those shared prompt builders should be issue-aware by default so remote and local runs both start from the assigned issue context rather than a generic continuation prompt.

Only transport and filesystem roots should differ.

### 4.1.2 Refactor target shape

For both `codex_local` and `claude_local`, split current implementation into:

1. shared adapter core helpers
2. local wrapper
3. remote wrapper

Recommended split:

- `buildRuntimeConfig(...)`
- `buildInvocation(...)`
- `parseExecutionResult(...)`
- `resolveSessionBehavior(...)`

Then:

- local wrapper uses local spawn/process transport
- remote wrapper uses worker transport and lease worktree paths plus transient runtime path remapping

This keeps behavior aligned and prevents local/remote drift.

### 4.2 Agent file and runtime file sync

Build a lightweight sync layer on the server side.

Initial contents:

- allowlisted markdown agent files from the configured working directory
- top-level repo guidance docs such as `AGENTS.md`, `CLAUDE.md`, `README.md`
- transient runtime support files needed by the adapter invocation
- run-scoped Paperclip auth configuration
- issue-aware prompt inputs and run metadata

Rules:

- default allowlist, not recursive copy
- prefer small markdown files over broad directory sync
- skip heavy dirs like `node_modules`, `dist`, `build`, logs, and caches
- do not copy adapter home directories by default

### 4.3 Remote lease layout

Each lease should provision:

- `repo/`
- `agent-files/`
- `runtime/`
- `metadata.json`

The worker should treat the repo worktree as canonical, then overlay synced agent files and per-run runtime files into it before invoking the adapter.

### 4.4 Compatibility support

Phase the worker in with the highest-value adapters first:

1. `codex_local`
2. `claude_local`
3. `opencode_local`
4. `cursor`

If an adapter is unsupported on the selected target, fail with a clear environment error.

### 4.4.1 Concrete order for Codex and Claude

First land remote Codex by extracting and reusing the existing Codex local adapter internals.

Then land remote Claude using the same pattern.

The second adapter should be mostly plumbing work if the first refactor was done correctly. If Claude requires another round of architecture changes, the Codex extraction was not factored aggressively enough.

## 5. Git And PR Automation

### 5.1 Stable branch creation

For each lease, create or reuse a stable issue branch such as:

- `paperclip/{issueIdentifier}`
- `paperclip/{issueIdentifier}-{agentNameKey}`

Properties:

- idempotent across retries
- safe for repeated pushes
- independent from the base branch after creation

### 5.2 Push logic

On terminal success or explicit "ready for review" behavior:

- inspect repo dirty state
- create a commit when changes exist
- pass through the operator's resolved local git identity when available
- push branch to origin

If push fails:

- keep lease alive
- surface error on the run and lease

### 5.3 PR creation/update

Add PR automation using whichever mechanism is already available or most practical:

- GitHub CLI on the remote host, or
- GitHub API from the server

Recommended bias:

- use remote push from the host
- create/update PR from the server when possible, because credentials and retry logic are easier to centralize

Store:

- PR URL
- PR number
- last commit SHA

## 6. UI Changes

### 6.1 Issue creation/editing

Extend the issue UI so the board can:

- toggle `Run remotely`
- choose a remote execution target
- understand whether a repo source is available from the project or from the assigned agent's configured `cwd`

This belongs next to existing issue-level assignee execution options in [ui/src/components/NewIssueDialog.tsx](/Users/brentbaum/dev/tools/paperclip-trial/paperclip/ui/src/components/NewIssueDialog.tsx).

### 6.2 Issue detail and run detail

Display:

- execution mode
- remote target
- lease status
- branch name
- PR link
- reset remote workspace action

### 6.3 Remove SSH agent configuration

Delete `SSH (remote)` from agent configuration UI and replace the setup path with:

1. remote execution target management
2. issue-level `Run remotely`
3. lease visibility and reset flows

## 7. Environment Testing And Guardrails

### 7.1 Remote target environment checks

Add target-level checks for:

- SSH reachability
- worker presence
- git availability
- required adapter binaries
- repo auth
- PR auth

This can reuse logic from the current SSH adapter environment tests, but the tests should move under remote target validation rather than agent adapter validation.

### 7.2 Run-time preflight

Before starting a remote run, verify:

- issue has assignee
- issue has repo source
- target supports adapter type
- target can run the worker and reach required git remotes

Fail fast before creating a half-initialized run.

## 8. Rollout Strategy

### Phase 1: Schema and contract groundwork

- remove `ssh` from adapter registrations and UI
- add issue execution fields
- add remote targets
- add remote leases
- extend task sessions for venue-aware persistence

### Phase 2: Orchestration only

- resolve remote mode in heartbeat
- create and reuse leases
- no PR automation yet beyond branch push if necessary

### Phase 3: Remote adapter hosting

- generalize remote worker
- support `codex_local` first
- then add `claude_local`
- keep Codex and Claude on shared adapter-core modules with thin local/remote wrappers

### Phase 4: PR automation and UI polish

- create/update PRs
- expose branch/PR metadata in UI
- add lease reset flows

### Phase 5: Cleanup

- remove obsolete SSH-adapter-only code paths
- migrate docs and UI defaults fully to remote targets + issue remote mode
- remove dead tests and adapter-specific config screens

## Testing Plan

### Unit tests

1. Issue validation for remote mode and target selection.
2. Lease creation/reuse behavior.
3. Session lookup isolation across local and remote scopes.
4. Branch naming and repo source resolution.
5. Lightweight agent-file filtering, runtime file remapping, and git identity resolution.
6. Codex local and remote wrappers produce the same invocation config for the same logical run.
7. Claude local and remote wrappers produce the same invocation config for the same logical run.

### Integration tests

1. Creating an issue with `executionMode=remote` persists the right fields.
2. First remote run provisions a lease.
3. Follow-up comment on the same issue reuses the lease.
4. Local run on another issue for the same agent does not reuse the remote session.
5. Remote run with missing repo source fails cleanly.
6. Push/PR failures keep the lease recoverable.
7. Remote Codex run and local Codex run emit compatible `AdapterExecutionResult` fields.
8. Remote Claude run and local Claude run emit compatible `AdapterExecutionResult` fields.

### End-to-end tests

1. Remote Codex run creates code changes, pushes branch, and returns PR metadata.
2. Re-running the same issue resumes in the same remote workspace.
3. Lease reset destroys remote state and reprovisions cleanly.

## Risks And Mitigations

### Risk: Session portability is adapter-specific

Mitigation:

- separate sessions by venue
- do not promise local-to-remote resume by default

### Risk: Remote hosts drift from expected toolchain

Mitigation:

- target environment tests
- adapter support declarations per target

### Risk: Agent file sync still copies too much local context

Mitigation:

- allowlist exporter design
- markdown-first filtering
- no full-directory sync or adapter-home sync by default

### Risk: PR automation credentials become fragmented

Mitigation:

- centralize PR creation where practical
- keep remote host responsibilities narrow

## Acceptance Criteria

1. A board operator can assign an existing agent to an issue and mark it `Run remotely`.
2. The first remote run creates a persistent remote lease for that issue.
3. Later runs and comments on the issue reuse the same lease, repo, and branch until reset or cleanup.
4. Local and remote runs for the same agent do not collide in saved session state.
5. Remote runs fail clearly when no repo source or compatible remote target exists.
6. Successful remote runs surface branch and PR metadata in Paperclip.
7. The old `ssh` adapter path is removed from the product surface and replaced by remote targets plus issue-level remote execution.

## Recommended Execution Order

1. Ship data model and shared contract changes.
2. Wire issue-level execution mode into heartbeat orchestration.
3. Introduce target and lease services.
4. Extract shared adapter-core helpers from Codex local adapter.
5. Make the worker generic and land remote Codex on top of that shared core.
6. Extract Claude onto the same local/remote shared-core shape.
7. Add branch push + PR creation/update.
8. Add UI for remote mode, lease status, and reset flows.
9. Remove remaining SSH-adapter-specific code and tests.
