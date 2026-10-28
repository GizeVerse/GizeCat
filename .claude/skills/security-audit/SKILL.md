---
name: security-audit
description: Threat-focused security review of a change or component — attack surface, authz, input handling, secrets, dependencies — with exploit evidence, false-positive analysis and fix-retest. Use for changes touching auth, money, uploads, external input, secrets or permissions, or when asked for a security review.
---

# Security audit

Scope is your own code and local or test environments. Never probe production systems, third-party services or other people's infrastructure without the user's explicit authorization for that target.

## 1. Attack surface
List the entry points (HTTP routes, webhooks, queues, CLI, file and URL inputs, LLM/tool inputs), the trust boundaries, the assets (accounts, money, personal or health data, secrets, admin actions), and who can reach each entry point unauthenticated. Read the project's invariants in CLAUDE.md first. They often name the assets that matter most.

## 2. Check by class
- **Authn/authz:** missing checks, IDOR (object ids from the client), role confusion, privilege escalation through update endpoints.
- **Injection:** SQL/NoSQL, command, template, prompt injection into tool-using agents, header/log injection.
- **Web:** XSS, CSRF on cookie-auth state changes, SSRF (user-supplied URLs fetched server-side), open redirects, path traversal, unsafe upload (type, size, storage location, served as HTML).
- **Data:** secrets in code, logs or errors; personal data in logs and analytics; missing deletion; weak crypto or home-made tokens; non-constant-time compares.
- **Abuse:** rate limits on auth, signup and expensive endpoints; unbounded pagination and payloads.
- **Integrity of money and records:** races, missing transactions, float money, missing idempotency keys, replayable webhooks.
- **Supply chain:** run `npm audit --omit=dev` / `pip-audit` / `flutter pub outdated` when available. Report only reachable, relevant issues.

## 3. Each finding
Give: the vulnerable code (file:line); a concrete exploit scenario (who sends what to reach which asset); the evidence (a failing test or a local request/response that demonstrates it, or careful static reasoning labelled as such); severity; confidence. Add a **false-positive check**: the strongest reason it might not be exploitable, and whether that reason holds.

## 4. Fix and retest
- Fix at the trust boundary.
- Add a regression test that performs the attack and fails before the fix.
- Rerun the exploit and the `verify` tier, and report both results.
- If a fix is out of scope, record it as an open finding with severity.

## 5. Second look
For high-stakes changes, hand the diff and threat model to the `security-reviewer` agent for an independent pass. Use the built-in `/security-review` for a quick scan of pending changes. Report the agreed findings and the disagreements.
