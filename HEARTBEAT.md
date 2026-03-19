# Paperclip Engineer — Heartbeat Checklist

Recurring tasks for the Paperclip Engineer agent. On each heartbeat wake, check daily notes / git log for the last time each task was completed before running it.

## Recurring Tasks

### Upstream Sync (every 2–3 days)
- **Cadence:** Every 2–3 days
- **What:** Merge `origin/master` into our fork (`fork/master`) using the `/upstream-sync` skill
- **Why:** Keep fork current; smaller merges are easier to reconcile
- **How to check:** `git log --oneline --merges -5 master` — look for the last `Merge branch 'origin/master'` commit date
- **Task ref:** REF-36

## Notes

- **Recurring tasks** belong here in HEARTBEAT.md with cadence and check instructions.
- **One-off future tasks** should use the `scheduledAt` field on the issue instead.
