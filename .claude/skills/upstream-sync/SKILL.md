---
name: upstream-sync
description: "Sync the fork with upstream (origin/master). Merges upstream commits, resolves conflicts using fork maintenance rules, validates the build, creates a PR against fork/master, and auto-merges. Use when asked to 'sync upstream', 'merge upstream', 'update from upstream', 'fork sync', or when a Paperclip task mentions keeping the fork up to date."
---

# Upstream Fork Sync

Sync brentbaum/paperclip (fork) with paperclipai/paperclip (origin). This is a merge-based workflow — never rebase.

## Remotes

| Remote | Repo | Purpose |
|--------|------|---------|
| `origin` | paperclipai/paperclip | Upstream source of truth |
| `fork` | brentbaum/paperclip | Our fork with custom features |

## Quick Overview

1. Stash uncommitted work
2. Create sync branch from current master
3. Merge upstream with `--no-ff`
4. Resolve conflicts using the rules below
5. Regenerate pnpm-lock.yaml
6. Validate (typecheck, tests, build)
7. Check for upstream overlap with fork features
8. Commit, push, create PR against `fork/master`
9. Auto-merge the PR
10. Pop stash

## Step-by-Step

### 1. Prepare

```bash
git fetch origin fork --prune
git stash push -m "pre-sync" -- <any modified files>   # if working tree is dirty
git checkout master
git pull --ff-only fork master
git checkout -b sync/upstream-$(date +%Y%m%d)
```

If `sync/upstream-YYYYMMDD` already exists (same-day re-sync), append a suffix like `-2`.

### 2. Merge Upstream

```bash
git merge --no-ff origin/master
```

If there are no new upstream commits, exit early — nothing to sync.

### 2b. Snapshot Fork Delta (CRITICAL — do this before resolving conflicts)

Before touching any conflicts, capture the complete list of files our fork has changed relative to upstream. This is the authoritative record of fork work — it catches everything, not just what's listed in a manifest.

```bash
git diff --name-only origin/master...HEAD > /tmp/fork-delta-files.txt
```

This produces the list of every file our fork has modified, added, or deleted relative to upstream. Any file on this list represents intentional fork work and **must not be silently dropped** during conflict resolution.

### 3. Resolve Conflicts

**The golden rule: never silently discard fork changes.** If upstream and fork both modified a file, the merge result must preserve both sides' intent. Taking `--theirs` (upstream wins) is only safe for files where our fork made zero changes.

For every conflicted file, check whether it appears in the fork delta (`/tmp/fork-delta-files.txt`):

| Situation | Rule |
|-----------|------|
| File is in fork delta AND in conflict | **Must merge both sides.** Read both versions, understand what each side changed, and produce a result that keeps both. Never blindly take one side. |
| File is NOT in fork delta | **Upstream wins.** Safe to take `--theirs`. |
| `packages/db/src/migrations/*.sql` | Keep both. Never delete upstream migrations. |
| `packages/db/src/migrations/meta/_journal.json` | Manual merge. Keep all upstream entries with their original idx numbers. Fork entries use idx 9000+. Fork entries go after all upstream entries. |
| `packages/db/src/schema/*` | Merge both. Fork additions (extra columns, tables, indexes) layer on top of upstream schema. |
| `pnpm-lock.yaml` | Delete and regenerate (Step 4). |

#### Known Fork-Only Files

These files are entirely custom to our fork (they don't exist upstream at all). In conflicts, our version wins outright:

- `server/src/adapters/telegram/` — Telegram adapter
- `server/src/services/telegram.ts` — Telegram service
- `server/src/services/telegram-new-parser.ts` — Telegram parser
- `server/src/routes/telegram.ts` — Telegram routes
- `server/src/adapters/ssh/` — SSH adapter
- `server/src/services/remote-execution.ts` — Remote execution service
- `server/src/services/remote-execution-runner.ts` — Remote execution runner
- `packages/remote-worker/` — Remote worker package
- `ui/src/components/LiveRunWidget.tsx` — Inline live run transcript
- `ui/src/pages/Inbox.tsx` — Enhanced inbox with document queries
- `server/src/services/cron.ts` — Cron scheduling
- `ui/src/adapters/ssh/` — SSH UI adapter files
- `ui/src/components/AgentFilesWorkspace.tsx` — Agent files workspace

But this list is not exhaustive — the fork delta from Step 2b is. If a file appears in the fork delta but isn't listed here, it still has fork changes that must be preserved.

#### Files With Fork Modifications (Both Sides Changed)

These files exist upstream but our fork has added to them. Auto-resolved merges may silently drop our additions — always verify:

- `ui/src/pages/AgentDetail.tsx` — Files tab (fork) alongside Skills tab (upstream)
- `server/src/index.ts` — Telegram service init, self-restart handler registration
- `scripts/dev-runner.mjs` — Supervisor loop with self-restart (built mode)
- `package.json` — `dev` script uses built mode supervisor
- `server/src/app.ts` — documentRoutes, processControlRoutes, telegramRoutes
- `server/src/routes/index.ts` — telegram + remoteExecution exports
- `ui/src/lib/queryKeys.ts` — documents query keys

#### Merging Shared Files (Both Sides Changed)

When a file appears in both the fork delta and the conflict list, you must read both sides and merge manually. Common patterns:

- **Type/union additions**: include values from both sides (e.g., `"files" | "skills"` not just one)
- **Import additions**: keep imports from both sides
- **Route/export additions**: keep all routes/exports from both sides
- **Tab/UI additions**: keep tabs from both sides, add both content sections

**Never use `git checkout --theirs` on a file that has fork changes.** If you're unsure whether the fork changed a file, check the delta list.

#### _journal.json Merge Strategy

The migration journal needs special care:

1. Keep all upstream entries with their original sequential idx (0, 1, 2, ... N)
2. Our fork entry `0035_fork_additions` gets idx `9000` (not its original idx)
3. Any future fork migrations use idx 9001, 9002, etc.
4. All fork entries go after the last upstream entry in the array

### 4. Regenerate Lockfile

```bash
rm pnpm-lock.yaml
pnpm install --no-frozen-lockfile
```

### 5. Validate

Run all validation steps. Fix any issues caused by the merge on the sync branch before proceeding.

```bash
pnpm typecheck
pnpm test:run
```

**Interpreting test results:** Some tests may have pre-existing failures unrelated to the merge (e.g., fork-only tests referencing unimplemented functions, ESM dependency issues). Compare failures against what was failing on master before the merge — only new failures need fixing.

If typecheck fails due to leftover references from one side of a conflict (e.g., a type that was renamed upstream but our code still references), fix the code to match.

### 5b. Post-Merge Fork Delta Verification

After all conflicts are resolved and the build passes, verify that no fork changes were silently lost:

```bash
# Compare the merged result against upstream — this is our new fork delta
git diff --name-only origin/master...HEAD > /tmp/fork-delta-after.txt

# Check if any files from the original fork delta disappeared
comm -23 <(sort /tmp/fork-delta-files.txt) <(sort /tmp/fork-delta-after.txt) > /tmp/fork-lost-files.txt
```

If `/tmp/fork-lost-files.txt` is non-empty, those files had fork changes before the merge but now match upstream exactly — meaning fork work was discarded. Investigate each one and restore the fork changes if they were intentional.

This step is what prevents features like the AgentDetail Files tab from being silently dropped when taking upstream's version of a shared file.

### 6. Check for Upstream Feature Overlap

Compare recent upstream commits against our fork features:

```bash
git log --oneline origin/master@{7.days.ago}..origin/master
git diff origin/master..HEAD --stat
```

Check if upstream implemented anything that overlaps with our fork patches:
- Telegram integration
- SSH remote execution
- Scheduled issues (scheduledAt field)
- Live run inline transcript
- Inbox UI enhancements
- Voice messages

If overlap is detected, note it in the PR description. Update FORK.md status entries to `partial-upstream` or `upstreamed` as appropriate.

### 7. Commit

```bash
git add -A
git commit -m "chore(sync): merge origin/master $(date +%Y-%m-%d)

- Merged N upstream commits
- Conflicts resolved: [list files]
- Overlap detected: [list or 'none']

Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

### 8. Push and Create PR

```bash
git push -u fork sync/upstream-$(date +%Y%m%d)

gh pr create --repo brentbaum/paperclip \
  --base master \
  --head sync/upstream-$(date +%Y%m%d) \
  --title "chore(sync): merge origin/master $(date +%Y-%m-%d)" \
  --body "## Upstream Sync
- Merged origin/master as of $(git rev-parse --short origin/master)
- Conflicts resolved: [list or 'none']
- Overlap detected: [list or 'none']

### Validation
- [x] pnpm install
- [x] pnpm typecheck
- [x] pnpm test:run
- [ ] Fresh DB smoke test (manual)"
```

### 9. Auto-Merge

```bash
gh pr merge --repo brentbaum/paperclip --merge
git checkout master
git pull --ff-only fork master
git branch -D sync/upstream-$(date +%Y%m%d)
```

### 10. Restore Working State

```bash
git stash pop   # if stashed in Step 1
```

### 11. Update Paperclip Issue (if running in a heartbeat)

If this was triggered by a Paperclip task, update the issue status to `done` with a comment summarizing what was merged, conflicts resolved, and any overlap detected.

## Recovery

**Merge fails (can't resolve conflicts):**
```bash
git merge --abort
# Retry on fresh branch, resolve subsystem-by-subsystem
```

**Tests/typecheck fail after merge:**
Fix on the sync branch, push again. If stuck: revert the merge on the branch and try a smaller upstream range.

**Migration conflict (duplicate column):**
Never edit an applied migration. Add a new corrective 9xxx migration with idempotent guards (`IF NOT EXISTS`, `IF EXISTS`).

**Bad sync already merged:**
```bash
git revert -m 1 <merge_commit_sha>
git push fork master
# Reattempt on fresh branch
```
