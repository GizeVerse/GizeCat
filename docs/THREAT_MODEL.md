# Desktop Cat — Threat model

Scope: the Electron application (main process, two sandboxed renderers, koffi Win32 bindings), its local files and the optional AI providers. Method: STRIDE over the data flows below, plus abuse cases specific to a screen-observing companion. This model was checked by a 7-dimension adversarial review (63 findings, 53 confirmed and fixed with regression tests; see `docs/TEST_REPORT.md`).

## Assets

1. The user's screen contents and window metadata (titles, apps) — highest sensitivity.
2. Optional AI API keys.
3. Normal use of the PC (the overlay must never trap input or focus).
4. Local state files (settings, cat state, logs).

## Trust boundaries & data flows

```
 Win32 (user32/dwmapi/shell32) ──koffi──►  MAIN (trusted, Node)  ──HTTP(S)──►  AI provider (optional)
 desktopCapturer frames ──────────────►     │  ▲                                  (untrusted output)
                                             │  │ validated IPC (zod + sender check)
                         overlay renderer ◄──┘  └── settings renderer
                         (sandboxed, no Node, CSP, custom scheme)
 %APPDATA%\Desktop Cat\*.json  ◄── atomic writes / validated reads (untrusted input)
```

## Threats and mitigations

| # | Threat (STRIDE) | Mitigation |
|---|---|---|
| T1 | Renderer compromise → Node/OS access (E) | `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`; preloads expose only typed functions (never `ipcRenderer`); custom `desktop-cat://` scheme with path-traversal checks; strict CSP (`default-src 'none'`) as response header and meta; navigation, redirects, `window.open`, webviews, display-media and all permission requests denied; renderer network requests to non-app schemes cancelled. |
| T2 | Malicious/garbled IPC payloads (T, D) | Every inbound channel zod-validated, numeric ranges bounded, unknown keys rejected; sender frame/webContents must be one main created; two per-window overlay budgets (240/s for moves, hit regions and errors — the renderer itself caps moves at ~166/s — and 120/s for press/release/cancel/context/enter/leave), so press/release are never starved by moves. |
| T3 | Settings patch smuggling unsafe values (T) | `applySettingsPatch` rejects any leaf that does not survive strict parsing unchanged; unknown sections/keys rejected; `rejectConsentBypass` refuses patches that enable screen analysis or write the consent timestamp (only the consent actions can); global shortcuts must include Control, Alt or Super plus one non-reserved key — enforced in main, invalid stored values fall back to the default. |
| T4 | Prompt injection via on-screen text into the AI model (T, E) | Model output must be a strict JSON object matching `SceneReportSchema`; reactions from an 8-item allow-list mapped to existing cat behaviours; captions sanitised (control/bidi characters, URLs, e-mails, long numbers removed), never executed, never shown on the desktop; no tool/function execution path exists. Worst case: the cat reacts oddly. |
| T5 | Screenshot exfiltration (I) | Off by default; explicit consent timestamp required in code; cloud endpoints and cloud models require separate `allowCloud`; loopback detection resistant to `localhost.evil.com`, `*.localhost`, userinfo, IPv6/decimal tricks; models a loopback server forwards to the cloud (Ollama cloud models, aliases, `/v1`) are detected via the server and fail closed until confirmed local; frames tiny, masked, in-memory, never persisted; masks cover every shown window of excluded processes/titles including owned dialogs, tool windows and pop-ups; exclusions re-checked after each grab (frame dropped if a private window appeared or moved); nothing captured while a private window is in front, while locked, or if private windows cannot be located; privacy pause; tray always shows the mode. |
| T6 | Window titles leaking into logs/diagnostics (I) | Titles never leave the win32 module (not in `WindowInfo`); they are read only while screen analysis is on (title patterns are installed only then); logger redacts key-like strings; diagnostics export contains no titles. |
| T7 | API key disclosure (I) | Stored DPAPI-encrypted via `safeStorage`; refused if encryption unavailable; no `.bak` or quarantine copy of `secrets.json`, so a removed key is gone and can never be restored from a copy; never sent to renderers (only a boolean); never logged; sent only in the provider's auth header to the configured host; redirects refused; key changes abort in-flight requests and reset the circuit breaker. |
| T8 | Overlay blocks the desktop (D) | Overlays are click-through by default; main enables interaction only while the cursor is inside the cat's reported hit region and the renderer is healthy. The renderer re-reports its region at least every ~0.75 s while showing the cat; 3 s of silence or an `unresponsive` event → immediate click-through and any press/drag ends; the overlay is recreated (with backoff) if still silent 5 s later. Non-focusable windows never take focus; tray Quit, global hide shortcut, and "Interactions off" always work. |
| T9 | Corrupt/hostile state files (T, D) | Field-level schema defaults; unreadable files quarantined (max 3 copies) and a file that exists but cannot be read is never overwritten; atomic writes with `.bak` (not for secrets); settings restored from `.bak` reset screen-analysis consent and `allowCloud`; bounded arrays and string lengths. |
| T10 | Resource exhaustion (D) | Bounded event queues (drop oldest), coalescing, capped logs (the cap holds even when rotation is blocked), capture/AI rate limits and circuit breaker, adaptive tick rates, no unbounded timers — measured in `docs/TEST_REPORT.md`. |
| T11 | Keylogging concern (I) | No keyboard hook; `GetAsyncKeyState` only for the left mouse button during drags; idle time only. Documented in PRIVACY.md. |
| T12 | Covert persistence (E) | Launch at login only through the user-visible setting (`HKCU\…\Run`, fixed value name), off by default, never re-enabled automatically, removed by the uninstaller; no services, scheduled tasks or elevation (`asInvoker`). Crash-guard relaunches are bounded (3 per 10 min) and disabled when the history cannot be persisted. |
| T13 | Tampering with the installed app (T) | Per-user install; Electron fuses verified on the packaged exe (RunAsNode, `NODE_OPTIONS` and inspect flags disabled; embedded ASAR integrity and only-load-from-ASAR enabled); test hooks are never installed in packaged builds. Builds are **unsigned** unless a signing identity is supplied → SmartScreen warning. |
| T14 | Supply chain (T) | Exact-pinned dependencies with lockfile; install scripts gated by npm `allowScripts`; one runtime dependency shipped as a module (koffi; zod is bundled); `npm audit` in CI. |

## Out of scope / residual risk

- A local attacker running as the same Windows user can read DPAPI-protected secrets and modify the app; this is the Windows security boundary, not ours.
- The overlay is not shown above the secure desktop or exclusive-fullscreen games, and cannot receive input over windows of elevated apps (UIPI); this is a platform limitation.
- AI providers' handling of images is governed by their own policies; cloud use is opt-in.
- Unsigned builds cannot prove origin; distribute checksums and sign releases when an identity is available.
