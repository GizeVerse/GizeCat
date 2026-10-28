---
name: handoff
description: Write or resume a session handoff — goal, branch, verified vs unverified state, next steps — so long or interrupted work can be recovered. Use when ending a long session, before compaction, when the user steps away, or when asked to continue or resume earlier work.
---

# Handoff

## Write
Write `.claude/handoff.md` (gitignored, local; at most ~40 lines). The SessionStart hook shows its first lines in the next session.

```
# Handoff — <goal in one line>
Updated: <ISO timestamp> | Branch: <branch> | Worktree: <path> | PR: <url or none>

## Done
- <item> — REAL/MOCKED/SIMULATED/UNVERIFIED (<evidence pointer>)

## In progress
- <what is half-done, with file paths>

## Next
1. <concrete step with the exact command>

## Needs the user
- <decision, credential, access>

## Gotchas
- <traps found: flaky test, slow service, env quirk>
```

- If the branch has a PR, put the same state in the PR body's `## Handoff` section (`gh pr edit <n> --body-file …`). That copy survives machine changes and cloud sessions; the local file does not.
- Durable facts that outlive this task (a deployment's state, machine rules) belong in memory or project docs, not in the handoff.

## Resume
1. Read `.claude/handoff.md` (or the PR's Handoff section), then run `git status`, `git log --oneline -10`, and `node .claude/scripts/verify.mjs --list`.
2. Treat earlier "done" claims as UNVERIFIED until a verification of the current tree passes. The SessionStart summary shows whether the last record is stale.
3. Continue from **Next**. Update the handoff when a step finishes or the plan changes.
