# Troubleshooting

| Symptom | What to do |
|---|---|
| **Black or grey rectangle instead of a transparent overlay** | Some GPU drivers render transparent windows opaque (Electron issue #40515). Settings → Diagnostics → turn **Hardware acceleration** off and restart the app. Updating the GPU driver also helps. |
| **Clicks don't reach my windows** | Only the cat's body should catch the mouse. Hide the cat (`Ctrl+Alt+Shift+C` or tray → Hide) to confirm; turn **Interactions** off in the tray to make it fully click-through; export diagnostics and report it. Quit is always available from the tray. |
| **I can't find the cat** | Tray → Show / Call. It hides on monitors with a fullscreen app (Settings → Behavior → Fullscreen behaviour). If a monitor was disconnected, the cat moves to a remaining one. |
| **The cat doesn't react to windows** | Settings → Diagnostics shows *Window awareness*: `event-hooks` (normal), `polling` (fallback, slower reactions) or `unavailable` (Win32 bindings failed to load — reinstall). Also check Settings → Behavior → React to windows. |
| **It doesn't appear over a game** | Exclusive-fullscreen games, the lock screen and UAC prompts are drawn on surfaces normal apps cannot cover. By default the cat also hides itself when a fullscreen app is in front. |
| **Can't drag the cat over an admin (elevated) window** | Windows blocks input from normal apps to elevated ones (UIPI). Expected. |
| **Shortcut doesn't work** | Another app may own the combination; Settings → General shows whether registration succeeded. Pick another combination (it must include Ctrl, Alt or Win plus a normal key; Shift alone is not enough). |
| **SmartScreen warning when installing** | The build is unsigned. More info → Run anyway, if you trust its source. |
| **Launch at sign-in doesn't happen** | Task Manager → Startup apps may have it disabled; the app respects that choice. Toggle it in Settings → General. |
| **AI: "model not found" / "key missing" / paused** | See [AI_SETUP.md](AI_SETUP.md). After 3 failures the AI backs off for up to 30 minutes; fixing the key/URL resets it. |
| **Corrupt settings** | The app recovers automatically (bad fields fall back to defaults; unreadable files are kept as `*.corrupt-*.json` in `%APPDATA%\Desktop Cat`). To start fresh, quit and delete that folder. |
| **High CPU** | Measured on the reference machine: about 0.5–0.7 % of one CPU core while the cat rests or sleeps, up to ~1.3 % while it is active, ~0.03 % while hidden (see TEST_REPORT.md). Much more than that is unusual. Export diagnostics (Settings → Diagnostics) and include it in a report. |

**Logs:** `%APPDATA%\Desktop Cat\logs\main.log` (JSON lines, rotated at 1 MB × 3). They never contain window titles, API keys or screen images.
