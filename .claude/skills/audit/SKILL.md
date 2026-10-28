---
name: audit
description: Evidence-backed audit of a codebase area, feature set or claim — what exists, what really works, what is mocked, simulated or missing. Use when asked to audit, assess, inspect or "check the state of" something, or before planning large work in unfamiliar code.
---

# Audit

An audit changes no code. Its output is a map and a list of verified findings.

## 1. Scope
Restate the target and the questions. List what you will read and what you will run. Note anything out of reach in this environment (services, devices, credentials, cloud) up front.

## 2. Inspect first
- Read the docs that state rules (CLAUDE.md, files it links, ADRs) and treat them as claims to check, not facts.
- Locate entry points, wiring/config, tests and CI. Use `git log --oneline -20 -- <path>` to see recent movement.
- For a broad scope, split by subsystem and delegate each part to an Explore agent (or a workflow when ultracode is on). Keep the conclusions, not the file dumps.

## 3. Establish reality per capability
For each capability, assign a `verify`-skill label with evidence:
- trace the call path from entry point to effect (file:line);
- run the cheapest command that exercises it (a test, a CLI call, a request against a local server);
- look for seams where reality is swapped out: mocks in production paths, feature flags defaulting to fake, demo data, `TODO`/`NotImplemented`, silent `catch` blocks, hard-coded responses.

## 4. Findings
For each finding give:

| field | content |
|---|---|
| title | one line |
| severity | critical / high / medium / low, judged by impact on users and data, not code style |
| evidence | file:line, and command + output excerpt where something was run |
| confidence | confirmed (reproduced) / likely (strong static evidence) / suspected |
| impact & fix | what goes wrong for whom; the smallest credible fix |

Before reporting a critical or high finding, challenge it. Try to refute it yourself, or hand it to the `verifier` agent. Drop or downgrade findings that don't survive, and say so.

## 5. Report
Lead with the answer: the overall state in 3–5 lines. Then the capability table (capability, label, evidence), the findings ranked by severity, the open questions, and what could not be checked here.
