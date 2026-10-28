# Desktop Cat — Threat model

Scope: the Electron application (main process, two sandboxed renderers, koffi Win32 bindings), its local files and the optional AI providers. Method: STRIDE over the data flows below, plus abuse cases specific to a screen-observing companion.

## Assets

1. The user's screen contents and window metadata (titles, apps) — highest sensitivity.
2. Optional AI API keys.
3. Normal use of the PC (the overlay must never trap input or focus).
4. Local state files (settings, cat state, logs).

## Trust boundaries & data flows

```
 Win32 (user32/dwmapi/shell32) ──koffi──►  MAIN (trusted, Node)  ──HTTPS/HTTP──►  AI provider (optional)
 desktopCapturer frames ──────────────►     │  ▲                                     (untrusted output)
                                             │  │ validated IPC (zod + sender check)
                         overlay renderer ◄──┘  └── settings renderer
                         (sandboxed, no Node, CSP, custom scheme)
 %APPDATA%\Desktop Cat\*.json  ◄── atomic writes / validated reads (untrusted input)
```

## Threats and mitigations

| # | Threat (STRIDE) | Mitigation | Status |
|---|---|---|---|
| T1 | Renderer compromise → Node/OS access (E) | `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`; preloads expose only typed functions (never `ipcRenderer`); custom `desktop-cat://` scheme with path-traversal checks; strict CSP (`default-src 'none'`); navigation, `window.open`, webviews and all permission requests denied. | Implemented |
| T2 | Malicious/garbled IPC payloads (T, D) | Every inbound channel zod-validated, numeric ranges bounded, unknown keys rejected; sender frame/webContents must be one main created; overlay messages rate-limited. | Implemented |
| T3 | Settings patch smuggling unsafe values (T) | `applySettingsPatch` rejects any leaf that does not survive strict parsing unchanged; unknown sections/keys rejected. | Implemented + unit-tested |
| T4 | Prompt injection via on-screen text into the AI model (T, E) | Model output must be a strict JSON object matching `SceneReportSchema`; reactions from an 8-item allow-list mapped to existing cat behaviours; captions sanitised and never executed or shown on the desktop; no tool/function execution path exists. Worst case: the cat reacts oddly. | Implemented |
| T5 | Screenshot exfiltration (I) | Off by default; explicit consent timestamp required in code; cloud endpoints require separate `allowCloud`; loopback detection resistant to `localhost.evil.com`, userinfo, IPv6/decimal tricks; frames tiny, masked, in-memory, never persisted; exclusions for password/auth/banking/private windows; capture blocked when locked; privacy pause; tray always shows the mode. | Implemented |
| T6 | Window titles leaking into logs/diagnostics (I) | Titles never leave the win32 module (not in `WindowInfo`), read only when exclusions need them; logger redacts key-like strings; diagnostics export contains no titles. | Implemented |
| T7 | API key disclosure (I) | Stored DPAPI-encrypted via `safeStorage`; refused if encryption unavailable; never sent to renderers (only a boolean); never logged; sent only in the provider's auth header to the configured host; redirects to other hosts refused. | Implemented |
| T8 | Overlay blocks the desktop (D) | Overlays are click-through by default; main enables interaction only while the cursor is inside the cat's reported hit region and the renderer is healthy and recently reported; non-focusable windows never take focus; renderer hang/crash → forced click-through + recreate with backoff; tray Quit, global hide shortcut, and "interactions off". | Implemented |
| T9 | Corrupt/hostile state files (T, D) | Field-level schema defaults, quarantine of unparsable files, atomic writes with `.bak`; bounded arrays and string lengths. | Implemented |
| T10 | Resource exhaustion (D) | Bounded event queues (drop oldest), coalescing, capped logs (rotation), capture/AI rate limits and circuit breaker, adaptive tick rates, no unbounded timers. | Implemented; long-run measured in TEST_REPORT |
| T11 | Keylogging concern (I, repudiation of trust) | No keyboard hook; `GetAsyncKeyState` only for the left mouse button during drags; idle time only. Documented in PRIVACY.md. | Implemented |
| T12 | Covert persistence (E) | Launch at login only through the user-visible setting (`HKCU\…\Run` via Electron), off by default, never re-enabled automatically. No services, scheduled tasks or elevation (`asInvoker`). | Implemented |
| T13 | DLL/binary tampering of the install (T) | Per-user install under `%LOCALAPPDATA%\Programs`; Electron fuses (run-as-node, NODE_OPTIONS, inspect flags disabled; asar integrity) in packaged builds. Builds are **unsigned** unless a signing identity is supplied → SmartScreen warning. | Partially (no code signing available) |
| T14 | Supply chain (T) | Exact-pinned dependencies with lockfile; install scripts gated by npm `allowScripts`; minimal runtime deps (koffi, zod); `npm audit` in CI. | Implemented |

## Out of scope / residual risk

- A local attacker running as the same Windows user can read DPAPI-protected secrets and modify the app; this is the Windows security boundary, not ours.
- The overlay is not shown above the secure desktop, exclusive-fullscreen games, or windows of elevated apps (UIPI); this is a platform limitation, not a vulnerability.
- Unsigned builds cannot prove origin; distribute checksums and sign releases when an identity is available.
