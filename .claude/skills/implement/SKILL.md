---
name: implement
description: Execution loop for code changes in this repo — isolate, inspect, plan small, implement, verify, review, commit, report honestly. Use for features, fixes, refactors and long autonomous tasks.
---

# Implement

## 0. Isolate
- Never change code on `main`/`master`. Use a feature branch, or a worktree for parallel and background work.
- Check `git status` first. Pre-existing uncommitted changes belong to the user: work around them and never discard them.

## 1. Inspect before changing
- Read the CLAUDE.md invariants that touch the area, plus any `invariants` in `.claude/standard.json`.
- Read the code and the existing tests you will touch. Find the real entry point and call path. Don't assume a feature exists because a doc or a filename suggests it.
- For unfamiliar or broad areas, run the `audit` skill first, or delegate the wide search to an Explore agent and keep only the conclusions.

## 2. Plan
- State the smallest change that meets the goal, the files involved, and the tests that will prove it.
- For multi-part work, keep a task list (TaskCreate/TaskUpdate) and work one slice at a time.
- When ultracode or workflows are enabled and the work splits into independent parts, fan out with a workflow and use worktree isolation only for agents that write files.

## 3. Build in slices
- After each slice, run the narrowest relevant check (one test file or one package). Fix it before moving on.
- Add or adjust tests that fail without the change. Test behaviour at the boundary the user cares about.
- Keep integration seams honest. A stub, fake, demo mode or fallback must be named as one in code and in the report, and must never be the silent default on a production path.
- Match the surrounding code's style, naming and comment density. Make no unrelated refactors.

## 4. Verify
- `node .claude/scripts/verify.mjs fast` on the final tree. Use the `full` tier when you touched integration boundaries and its services are available.
- For non-trivial changes, ask the `reviewer` agent to review the diff and the `verifier` agent to check your claims. Fix what they confirm.
- Security-sensitive change (auth, money, uploads, external input, secrets, permissions): run the `security-audit` skill.

## 5. Commit
- One logical change per commit, with a conventional message (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`).
- Stage explicit paths, never `git add -A` blindly. Check `git diff --cached --stat` for stray files, build output and secrets.
- Push the feature branch when the repo has a remote. Never push to main/master, force-push, merge, or use `--no-verify`.

## 6. Report
- Lead with the outcome: done, partially done, or blocked.
- Give a claims table using the `verify` labels, with evidence.
- List what was not run and why, the decisions the user must make, and the next command.

## Recovering from failure
- After two failed attempts with the same approach, stop and debug systematically: reproduce, isolate, form one hypothesis, test it.
- If blocked by something only the user can provide (credentials, a product decision, access), make a reasonable assumption when it is cheap to reverse. Otherwise stop and ask one precise question.
- For long runs, keep `.claude/handoff.md` current (`handoff` skill) so an interrupted session can resume.
