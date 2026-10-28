# Engineering standard (kit-owned — edit in claude-standard, not here)

**Definition of done.** The change exists and has tests that fail without it. `node .claude/scripts/verify.mjs fast` passes on the final tree. Every claim in the report carries a label. A Stop hook enforces this once per stop.

**Honesty labels.** Label claims REAL, MOCKED, SIMULATED or UNVERIFIED (defined in the `verify` skill). Never present mocked or simulated behaviour as real. Never claim deployment, device, cloud or third-party success you did not observe. A config file existing is not evidence that a feature works.

**Git.**
- Work on a feature branch or worktree, never on main/master.
- Commit in small conventional commits and stage explicit paths.
- Open draft PRs.
- Never force-push, push to main/master, merge, use `--no-verify`, or discard uncommitted work you did not create. A PreToolUse hook enforces these.
- A repo may grant a standing exception to one of these rules. It must do so in its own CLAUDE.md, and mirror it in `.claude/standard.json` under `guard.disable` (for example `["push-protected"]`). An exception stated in only one of the two places does not apply.

**Skills.** `implement` (execution loop), `verify`, `audit`, `security-audit`, `release`, `handoff`.
**Agents.** `verifier` (refutes claims), `reviewer` (diff review), `security-reviewer`. Give an agent claims and scope, not your conclusions.

**Context.**
- Read files narrowly: targeted `grep`, line ranges.
- Delegate wide searches to Explore agents and keep only the findings.
- Keep logs on disk; `verify.mjs` writes `.claude/state/logs/`.
- For long work, keep `.claude/handoff.md` current.

**Environment.** Local sessions run on Windows: prefer Git Bash syntax in the Bash tool. Cloud sessions run on Linux and have no user-level `~/.claude` config, so everything a task needs must be in the repo.
