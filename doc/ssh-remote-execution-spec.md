# SSH Remote Execution Spec

## Overview

Remote execution lets an existing Paperclip agent run a specific issue on an SSH-reachable machine and submit a PR from that remote workspace.

This is not a separate "remote agent" type. The agent keeps its normal adapter type and identity. Remote execution is a per-issue execution venue selected by the board with a `Run remotely` option.

The system creates a persistent remote workspace lease for the issue, materializes the repository there, overlays a lightweight slice of agent-context files into that clean checkout, runs the normal adapter loop remotely, and keeps reusing that same remote workspace for later comments, resumes, and follow-up runs on the issue.

The old `ssh` adapter model is replaced by this design. Remote execution is no longer represented as a first-class agent adapter type.

## Product Decision

### Core rule

- Agent identity stays stable.
- Adapter semantics stay stable.
- Execution venue is selected per issue or per run.

### Why

Paperclip is a control plane, not an execution-plane identity system. "Remote" is where the agent runs, not what kind of agent it is.

This keeps:

- org structure clean
- capabilities tied to the real agent
- budgeting and activity attribution tied to the same employee
- local and remote execution available without cloning the employee record

## User Experience

### Board flow

1. Assign an issue to an existing agent.
2. Toggle `Run remotely`.
3. Choose or inherit a remote execution target.
4. Start the run.
5. Watch transcript/logs as usual.
6. Receive branch and PR metadata when the run completes.

### Expected behavior

- The first remote run for an issue provisions a remote workspace lease.
- Later runs for the same issue reuse that lease by default.
- Follow-up comments on the issue resume in the same remote workspace and branch.
- The agent can still work locally on other issues.
- A single issue should not bounce between local and remote session state implicitly.

## Recommended Architecture

### 1. Existing adapter + remote venue

Keep existing adapter types such as:

- `claude_local`
- `codex_local`
- `opencode_local`
- `cursor`

Add a remote execution layer that can host one of those adapters remotely.

The server decides:

- which adapter logic to run
- whether to run it locally or remotely
- which workspace and session state to attach

### 2. Persistent per-issue remote lease

When an issue is marked `Run remotely`, Paperclip creates a remote lease for that issue:

- one remote host assignment
- one remote workspace root
- one remote repo clone/worktree
- one remote branch
- one remote agent-context overlay area

That lease persists until one of:

- the issue is completed
- the issue is cancelled
- the lease expires by TTL
- the board explicitly resets or destroys it

### 3. Lightweight agent-context overlay, not full working-directory copy

Do not copy the agent's whole local working directory to the remote host.

Instead, transfer only a lightweight, allowlisted context overlay:

- agent markdown files such as `AGENTS.md`, `CLAUDE.md`, `CODEX.md`, `README.md`, and similar task/memory docs
- issue-aware prompt context and task/session metadata
- transient runtime support files needed by the adapter for this run
- Paperclip-issued auth material for the run

Do not transfer:

- the whole repository working tree
- full home directories
- arbitrary caches
- machine-specific absolute paths
- existing login/session stores by default
- broad secret files from the local machine

## Why Not Copy The Whole Working Directory

### Pros

- simple to describe
- can preserve some ad hoc local memory

### Cons

- copies too much irrelevant state
- risks copying secrets and auth artifacts unintentionally
- breaks on absolute paths and machine-specific assumptions
- increases transfer cost on every run
- makes resume semantics fragile
- makes local and remote divergence harder to reason about

Full working-directory transfer is acceptable only as a last-resort debugging mode, not as the default design.

## Architecture

```text
┌────────────────────┐
│ Paperclip Server   │
│ heartbeat service  │
└─────────┬──────────┘
          │
          │ resolve issue execution policy
          ▼
┌───────────────────────────────┐
│ Execution Orchestrator        │
│ adapter = codex_local/etc     │
│ venue = local | remote        │
└─────────┬─────────────────────┘
          │
          │ if remote
          ▼
┌───────────────────────────────┐
│ SSH Remote Runtime            │
│ host selection                │
│ remote lease lookup/create    │
│ repo materialization          │
│ agent file overlay            │
└─────────┬─────────────────────┘
          │
          ▼
┌───────────────────────────────┐
│ Remote Issue Workspace        │
│ /runs/{issueId}/              │
│   repo/                       │
│   agent-files/                │
│   runtime/                    │
│   metadata.json               │
└─────────┬─────────────────────┘
          │
          ▼
┌───────────────────────────────┐
│ Normal Adapter Runtime        │
│ codex / claude / cursor       │
│ running on remote host        │
└─────────┬─────────────────────┘
          │
          ▼
┌───────────────────────────────┐
│ Git Branch + PR              │
│ pushed from remote workspace │
└───────────────────────────────┘
```

## Execution Model

### Venue selection

Add an issue-level execution policy:

- `executionMode: "default" | "remote"`

Optional future expansion:

- `executionTargetId`
- `executionProfileId`

This should be distinct from raw adapter config overrides. Adapter config says how the agent behaves. Execution mode says where the run occurs.

### Remote run lifecycle

1. Board creates or updates issue with `executionMode = "remote"`.
2. Heartbeat/run orchestration resolves adapter type from the assigned agent.
3. Orchestrator loads or creates a remote lease for `(company, issue, agent, adapter, execution target)`.
4. Remote worker ensures the repo exists remotely.
5. Remote worker checks out or creates a dedicated ticket branch.
6. Agent-context files and transient runtime files are synced into the remote worktree as needed.
7. The normal adapter process starts on the remote machine.
8. Logs and transcript stream back to Paperclip.
9. On success, remote worker commits if needed, pushes branch, and creates or updates a PR.
10. Remote lease remains alive for later resumes until completion or cleanup.

## Repository Strategy

### Required input

Remote execution requires a repository source. The preferred source is the project workspace already associated with the issue or project:

- `repoUrl`
- base branch or `repoRef`

If project metadata does not provide a repository source, Paperclip should fall back to repository inference from the assigned agent's configured working directory:

- git repo root from `cwd`
- remote URL, preferring `origin`
- current branch or ref

If no repository source can be inferred, the run should fail early with a clear error.

### Remote checkout layout

Recommended remote layout:

```text
~/paperclip-remote/
  leases/
    {companyId}/
      {issueId}/
        repo/
        agent-files/
        runtime/
        metadata.json
```

### Branch strategy

Each remote issue lease owns one branch, for example:

- `paperclip/{issueIdentifier}`
- `paperclip/{issueIdentifier}-{agentName}`

Properties:

- stable across resumes
- unique per issue lease
- safe to push repeatedly

## Agent State Strategy

### Agent-context overlay

The synced agent context should be explicit and lightweight.

Default contents:

- agent markdown files from the configured working directory
- top-level repo guidance docs such as `AGENTS.md`, `CLAUDE.md`, `README.md`
- selected task or memory markdown files needed for continuity
- remote run metadata and issue-aware prompt inputs

Rules:

- allowlist by file type and path
- optimize for small, human-authored context files
- skip heavy build/output/cache directories
- do not copy adapter home directories by default

### Runtime support files

Some adapters need transient runtime files for a single invocation, for example an appended system prompt file or a temporary `--add-dir` source.

Those files may be materialized on the remote host for the duration of the run, but they are execution inputs, not the remote session model.

### Session separation

Local and remote sessions must be treated as separate execution state.

Do not reuse a local session ID as if it were valid remotely unless the adapter explicitly supports portable session resume and the required state has been migrated.

Task session persistence should be keyed strongly enough to avoid collisions across:

- adapter type
- execution venue
- remote lease or execution target
- task key / issue ID

## Remote Worker Responsibilities

The remote worker should evolve from "run claude over SSH" into "host normal adapter execution remotely."

Responsibilities:

- receive a run payload from Paperclip
- create or reuse the remote lease
- sync agent-context files and transient runtime files into the lease
- materialize repo and branch
- invoke the selected adapter runtime remotely
- stream logs and structured events back
- push branch and create/update PR
- persist remote session metadata for later resumes

## Adapter Parity And Code Reuse

### Core rule

Remote `codex_local` and remote `claude_local` must reuse the same adapter logic as local `codex_local` and local `claude_local`.

Do not create:

- a `codex_remote` adapter
- a `claude_remote` adapter
- a second copy of prompt/env/session logic inside the SSH worker

Remote execution should change the transport and filesystem roots, not the adapter behavior.

### Required layering

Split adapter execution into two layers:

1. Adapter core
2. Execution transport

Adapter core owns:

- prompt construction
- instructions file loading
- Paperclip env wiring
- skill injection rules
- session resume compatibility checks
- command-line args for the tool
- stream/result parsing
- usage/cost extraction
- adapter-specific error detection

Prompt construction must be issue-aware by default. When an issue identifier, title, or description is available, the adapter should start from that work context rather than a generic "continue your work" prompt.

Execution transport owns:

- where the process runs
- how stdin/stdout/stderr are carried
- how cwd is provisioned
- how remote agent/runtime files are materialized

That gives two transports over one adapter core:

- local transport: spawn the tool on the Paperclip host
- remote transport: send an adapter run request to the worker, then spawn the same tool on the remote host

### Shared result contract

Both transports must return the same `AdapterExecutionResult` shape and use the same session codec behavior.

This means:

- run status calculation stays in one place
- local and remote transcripts stay structurally consistent
- session persistence logic does not fork by adapter

### Codex reuse strategy

For `codex_local`, reuse all existing logic for:

- prompt rendering
- `CODEX_HOME` and related env wiring
- instructions loading
- skill mounting/injection
- session resume checks
- Codex JSONL parsing
- usage/cost extraction

Only the following should vary for remote:

- cwd points at the lease repo
- transport is SSH worker instead of direct local spawn
- transient runtime files may be uploaded and path-remapped for the remote host

### Claude reuse strategy

For `claude_local`, reuse all existing logic for:

- prompt rendering
- `.claude` / skill directory handling
- instructions loading
- session resume checks
- Claude stream-json parsing
- login-required / failure detection
- usage/cost extraction

Only the following should vary for remote:

- cwd points at the lease repo
- transport is SSH worker instead of direct local spawn
- transient runtime files may be uploaded and path-remapped for the remote host

### Recommended code shape

Refactor each adapter into:

- shared adapter-core helpers
- thin local `execute()` wrapper
- thin remote worker entrypoint wrapper

Conceptually:

```text
codex_local/
  core/
    build-runtime-config
    build-command
    parse-output
    session-rules
  server/execute-local
  worker/execute-remote

claude_local/
  core/
    build-runtime-config
    build-command
    parse-output
    session-rules
  server/execute-local
  worker/execute-remote
```

The worker should import adapter-core logic, not duplicate it.

### What must not be duplicated

Do not duplicate these between local and remote implementations:

- prompt templates
- instructions prelude behavior
- Paperclip env var mapping
- session id compatibility checks
- stream parsers
- login/failure heuristics
- usage/cost parsing
- skill discovery rules

If one of those needs to change for Codex or Claude, both local and remote paths should pick it up from the same code.

## Run Payload

Adapter-specific details may vary, but the payload should look conceptually like:

```json
{
  "runId": "uuid",
  "companyId": "uuid",
  "agentId": "uuid",
  "issueId": "uuid",
  "adapterType": "codex_local",
  "executionMode": "remote",
  "adapterConfig": {
    "model": "gpt-5-codex",
    "instructionsFilePath": "/abs/path/to/CODEX.md"
  },
  "executionTarget": {
    "host": "100.122.157.11",
    "user": "brewuser"
  },
  "lease": {
    "leaseKey": "company/issue/agent/target",
    "remoteRoot": "~/paperclip-remote/leases/company/issue"
  },
  "repo": {
    "repoUrl": "git@github.com:org/repo.git",
    "baseRef": "main",
    "branchName": "paperclip/REF-23"
  },
  "agentFiles": {
    "files": [
      {
        "relativePath": "memory/MEMORY.md",
        "content": "..."
      }
    ]
  },
  "runtimeFiles": {
    "files": [
      {
        "sourcePath": "/tmp/paperclip-system-prompt.txt",
        "remoteRelativePath": "runtime/system-prompt.txt"
      }
    ]
  },
  "context": {
    "issueIdentifier": "REF-23",
    "issueTitle": "Implement remote PR flow",
    "issueDescription": "...",
    "wakeReason": "issue_assignment"
  },
  "env": {
    "PAPERCLIP_API_URL": "http://100.89.193.88:3100",
    "PAPERCLIP_API_KEY": "..."
  }
}
```

The important detail is that the payload should carry enough information for the remote side to invoke the same adapter core, not a second remote-only implementation.

## PR Submission

### Expected behavior

Remote execution is responsible for ending in a reviewable artifact, not only in a dirty workspace.

By default the remote worker should:

1. inspect whether the repo changed
2. create a commit if changes exist and policy allows it
3. use the operator's resolved local git identity for that commit when available
4. push the ticket branch
5. create or update a PR
6. report PR URL and branch metadata back to Paperclip

### Reported metadata

Paperclip should store or at least surface:

- branch name
- remote host
- lease identifier
- last pushed commit SHA
- PR URL
- PR number
- commit author identity used for the remote push
- push/create errors

## Authentication And Secrets

### Paperclip auth

Continue issuing run-scoped Paperclip credentials for the remote process.

### Model/vendor auth

Prefer one of:

1. Remote host pre-provisioned with vendor auth for the adapter.
2. Paperclip secret injection into the remote run environment.

Avoid copying vendor login state from the operator machine by default.

### Repo auth

Remote hosts must be able to:

- clone the repo
- push the issue branch
- create PRs through GitHub CLI or API

This should be provisioned as part of the remote execution target, not inferred from the local machine.

## Host And Lease Management

### Execution target

A remote execution target represents a reachable machine plus policy:

- SSH host/user
- worker path
- repo auth strategy
- PR auth strategy
- supported adapters
- optional concurrency limits
- optional default cleanup TTL

### Lease persistence

Paperclip should track remote leases explicitly.

Suggested fields:

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
- `session_state_json`
- `last_run_id`
- `expires_at`
- `destroyed_at`

## Cleanup Policy

Default cleanup behavior:

- keep active leases while issue is open
- mark completed/cancelled issues eligible for cleanup
- preserve PR metadata after cleanup
- allow manual reset without deleting issue history

Recommended cleanup actions:

- optional remote branch deletion is manual or policy-driven
- remote workspace deletion is automatic after TTL
- agent-files/runtime staging areas are deleted with the lease

## Failure Modes

Paperclip should produce explicit errors for:

- no repo source configured for remote run
- remote host unreachable
- agent file or runtime file sync failure
- adapter unavailable on target host
- remote session state corrupted
- push failed
- PR creation failed

A push or PR failure should not erase the remote lease. The board may need to inspect or retry it.

## Tradeoffs

### Recommended design: existing agents + remote lease

Pros:

- correct mental model
- clean user experience
- good session continuity
- works with current issue-centric workflow

Cons:

- more orchestration state than a simple stateless SSH command
- requires explicit lease lifecycle management

### Alternative: dedicated remote adapter type

Pros:

- smaller change to the current implementation

Cons:

- remote becomes part of identity rather than execution venue
- confusing for users
- awkward local/remote switching
- duplicates agents unnecessarily

### Alternative: copy full working directory

Pros:

- initially simple

Cons:

- fragile
- unsafe
- expensive
- hard to reason about

## Recommended Implementation Order

1. Add issue-level `executionMode = remote`.
2. Introduce remote execution target config.
3. Introduce remote lease records.
4. Change SSH worker to host adapter execution remotely instead of only Claude.
5. Add lightweight agent-file sync and transient runtime file sync.
6. Add stable remote branch management.
7. Add PR creation/update reporting.
8. Add lease cleanup and reset controls.

## Future Improvements

- host pools and scheduling
- containerized per-lease execution
- remote artifact capture (`git diff`, patches, screenshots)
- richer PR policies per company
- explicit richer local-to-remote state migration for adapters that support it
