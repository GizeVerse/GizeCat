---
name: verify
description: Run this repo's verification tiers and label every claim REAL, MOCKED, SIMULATED or UNVERIFIED with evidence. Use before saying work is done, before a commit or PR, or when asked whether something works.
---

# Verify

## Run

```
node .claude/scripts/verify.mjs fast     # required for "done"; tiers live in .claude/standard.json
node .claude/scripts/verify.mjs full     # integration/e2e; needs services, run before PRs that touch boundaries
node .claude/scripts/verify.mjs --list   # show tiers and steps
node .claude/scripts/verify.mjs fast --only unit
```

- Steps run sequentially under a machine-wide lock; never start two verification runs at once.
- Output is a compact summary. Full logs are in `.claude/state/logs/<tier>-<step>.log`. Read a log with targeted `grep`/`tail` rather than pasting the whole file.
- The record `.claude/state/last-verify.json` binds the result to the tree content. Any later edit makes it stale, so the stop gate asks again.
- While iterating, run the narrowest check that covers the change (one test file, one package). Run the full tier once at the end.
- The Bash tool times out after 2 minutes by default. For longer tiers, pass a timeout of up to 600000 ms, or run in the background and wait for the notification.

## Labels

Use these words exactly in reports and PR bodies.

| Label | Meaning | Minimum evidence |
|---|---|---|
| **REAL** | Exercised in this session against the real component or dependency | command + exit code + the output lines that show it |
| **MOCKED** | Passed only with test doubles for named dependencies | which test, and what was mocked |
| **SIMULATED** | Ran against a stand-in: emulator, local container in place of a cloud service, synthetic data, faked env/platform | what stood in for what |
| **UNVERIFIED** | Not executed in this session, or only compiled/type-checked, or known only from docs/config | why it could not be run, and what would verify it |

Rules:
- "The config file exists", "the docs say so" and "it should work" are UNVERIFIED.
- A SKIP from `verify.mjs` (missing env or service) is UNVERIFIED, never a pass.
- Do not upgrade a label in later summaries. MOCKED stays MOCKED.
- Deployment, device, cloud-session and third-party claims are REAL only when observed directly. Give the URL or device and what you saw.

## When a check fails

1. Read the failing step's log tail and reproduce with the narrowest command.
2. Decide whether the failure is pre-existing. Check the base branch's CI (`gh run list --branch <base> -L 3`) or rerun that single test on a clean checkout. Report it with evidence. Don't fix or skip it silently.
3. If a test may be flaky, rerun it once. If it then passes, report it as flaky with both outcomes.
4. Never weaken an assertion, add a skip, raise a timeout to hide a hang, or mock the unit under test to get green.
5. After two failed fix attempts with the same idea, switch to systematic debugging: reproduce → isolate → form one hypothesis → test it → only then change code.

## Independent check

For non-trivial work, give the `verifier` agent the list of claims, not your conclusions. Merge its verdicts into the report. When the agent says REFUTED, re-run the check before you disagree.
