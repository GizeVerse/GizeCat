# Desktop Cat — Privacy policy

Desktop Cat is a local desktop companion. It has **no accounts, no telemetry, no analytics, no crash upload and no update pings**. With default settings it makes **no network requests at all**.

## What the cat observes (always on, stays on this PC)

| Signal | How | What is kept |
|---|---|---|
| Cursor position | `GetCursorPos`, polled while the app runs | Nothing persisted |
| Time since last input | `GetLastInputInfo` (one number) | Nothing persisted |
| "Typing-like" activity | Inferred when input happens without cursor movement. **No keyboard hook is installed; no key, character or text is ever read.** Since v1.2 clicks no longer count (the state of the mouse buttons is checked, see below); scrolling may still count. | Nothing persisted |
| App windows | Win32 window events and enumeration: window rectangle, minimised/maximised state and the executable file name (e.g. `code.exe`), to pick a coarse category (code, browser, video…), to know where the cat can stand, and to recognise private apps. Other shown windows (dialogs, pop-ups) are enumerated for the same purposes. | Nothing persisted |
| Window titles | Read **only while screen analysis is on** (a mode chosen, consent given, not privacy-paused), **only in memory**, **only** to check privacy exclusions (e.g. "password", "bank"), for every shown window including dialogs and pop-ups. Never logged, persisted or transmitted. While analysis is off, titles are not read at all. | Nothing |
| Displays | Monitor geometry and scale factors | Nothing persisted |
| Taskbars (v1.1) | Position of the taskbar windows (`Shell_TrayWnd` / `Shell_SecondaryTrayWnd`, found by class name), their auto-hide state (`SHAppBarMessage`) and how far an auto-hide taskbar is slid in — so the cat can ride it. Sampled a few times per second, faster only while it moves or the pointer is at its edge. No screenshots. | Nothing persisted |
| Tab strips (Edge and Chrome since v1.1; Windows Terminal since v1.2; File Explorer only once its long-run test has passed, off in 1.2.0 unless the test report says otherwise) | Notepad, VS Code and other Electron apps, and Firefox are **never queried**: the app and the helper both check the program and window class from plain Windows data before any accessibility call, because first contact could switch on those apps' accessibility engines or touch a saved session. A small helper program shipped with the app (`resources\native\DesktopCatUia.exe`) reads, through Windows UI Automation, only the **rectangles** of the tab strip, its tabs, the new-tab button and the window buttons, which tab is selected and how many tabs there are, and listens for tab-switch events — so the cat can walk on the strip without covering controls. It **never reads tab names, titles, addresses or page content**, never clicks, and never queries private/excluded windows. On by default; turn off with Settings → Behavior → *Walk on browser tabs* (the helper then never starts). It runs only while the cat is awake and a browser is relevant — the one it is on or near, plus (since v1.1.1) up to three other visible, non-maximized Edge/Chrome windows it could climb to (measured every 3 s) — and exits after a minute without one, e.g. while the cat sleeps, is paused or hidden. | Nothing persisted, nothing sent |
| Your startup entry (v1.1) | The app reads and writes only its own value `io.github.enesiltas.desktopcat` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (and reads the matching `…\Explorer\StartupApproved\Run` value, i.e. whether you disabled it in Task Manager). | The entry itself, while launch at sign-in is on |

The clipboard is never read. `GetAsyncKeyState` is used only for the **left, right and middle mouse buttons** (to end a drag safely, so clicks are not mistaken for typing, and so the cat stops hunting when you click); it is never called for a keyboard key.

Two more things stay on your PC and never reach the logs (v1.2):

- **Click guard.** The rectangles of all visible top-level windows, private ones included, are used only inside the main process to keep the overlay click-through while the cat clings to a screen edge or hops off a covered surface. They are never passed to the behaviour engine, logged or exported.
- **Behaviour profile.** Settings → Diagnostics → Behaviour and the diagnostics export show counts and durations for this session (time calm and active, trips up, stays and how they ended, hunts, falls, reactions, time spent typing-like or with a maximized window in front), never which windows or apps. The log lines (`stay ended`, `behavior summary`) carry the same kind of numbers, without typing time.

**Sound (v1.2).** Off by default. When you turn it on, the cat's sounds are synthesized in the overlay; there are no recordings and no microphone access.

## What is stored on disk

All in `%APPDATA%\Desktop Cat\` (removed by deleting that folder; kept on uninstall unless you delete it):

- `settings.json` (+ `settings.json.bak`, the previous version) — your preferences, including the launch-at-sign-in state (preference, who decided it, and the program path last registered — which contains your Windows user folder; the diagnostics export replaces that path, and any other path inside your user profile, with `%USERPROFILE%`).
- `cat-state.json` (+ `cat-state.json.bak`) — the cat's personality numbers (e.g. curiosity 0.62), mood numbers, counters (how often it was petted), learned favourite resting spots (display + horizontal position) and a short list of recent cat events ("nap", "pet"). **No window titles, app names, screenshots or text.**
- Up to 3 `*.corrupt-<time>.json` copies per file, kept only if a file was unreadable, for inspection.
- `secrets.json` — only if you enter an AI API key: the key encrypted with Windows DPAPI via Electron `safeStorage` (readable only by your Windows account). **No backup or quarantine copy of this file is ever kept; removing a key deletes it from disk.**
- `relaunch-history.json` — timestamps of automatic restarts after crashes (bounded).
- `logs\` — rotating diagnostic logs, capped at ~3 MB even if another program holds the file open. Logs never contain window titles, API keys or image data; key-like strings are redacted. Since v1.1.1 a `surfaces summary` line (at most once a minute, only when it changes) records how many window edges, tab strips and taskbars the cat can see and reach, as counts, kinds and a reason code — never which windows or apps. The same counts (plus your displays' sizes and scaling and the cat's position) appear in Settings → Diagnostics → Surfaces and in the diagnostics export; the optional surface outlines draw the edges' positions on your own screen only.

If settings ever have to be restored from `settings.json.bak`, screen-analysis consent and "Allow cloud processing" are reset to off, so a restore can never re-enable something you turned off.

You can clear the interaction history or reset the personality in **Settings → Personality**.

## Screen analysis (optional, OFF by default)

Screen analysis only runs after you explicitly opt in from the Privacy page; the opt-in records a timestamp, and without it the capture code refuses to run. A settings change cannot turn analysis on — only the consent dialog can.

- **Local statistics** mode: on certain events, and never more often than the interval you set (minimum 5 s), the app takes a **short burst of three reduced-resolution grabs about 0.15 s apart** (counted as one capture). Windows/Electron grabs each display as a whole, at reduced resolution, into memory; the app immediately crops it to the chosen region (around the cat by default), blacks out the cat itself and every shown window of an excluded app or title (including their dialogs and pop-ups) **before** any resizing, analysis, preview or AI encoding, then releases the display image. From the small (≈256 px wide) masked frames it computes a handful of numbers (brightness, contrast, colourfulness, edge density, change and motion within the burst) and **discards the pixels** (leftover buffers are zeroed; memory owned by Electron is freed by the garbage collector). Nothing leaves the PC. These numbers are not "understanding" — they only tell the cat "dark/bright", "busy/quiet", "something changed/moving", "video-like" (sustained fast change in colourful content) or "a new element appeared". The exclusions are checked again right after each grab; if a private window appeared or moved meanwhile, the frames are dropped.
- **AI vision** mode: additionally, occasionally (default at most every 2 minutes and 12×/hour), a small JPEG (≤512 px) of the same masked region (the first frame of the burst only) is sent to the AI provider **you configured**:
  - *Ollama* or an *OpenAI-compatible server* on `localhost` — the image goes to that server on your PC. **Such servers can forward some models to a cloud service** (Ollama "cloud" models, also via `/v1` or under another name). Before the first image the app asks the server (`/api/version`, `/api/show`) whether the model is local; models it forwards, and any model the server has not confirmed as local, are treated as cloud.
  - A cloud model, a non-local endpoint or *Anthropic* — the image leaves your PC. This requires the separate **"Allow cloud processing"** switch; otherwise such requests are refused in code. The tray tooltip and the Privacy page show "AI (cloud)" while this is active.
  - The model may only answer with a tiny structured report (scene type, energy, interest, one of 8 allowed cat reactions, a ≤80-character caption). Anything else is rejected. The model cannot run commands or control your PC. Captions are never shown on the desktop or stored; the only place one appears is the result of "Test connection" (synthetic picture) in Settings.
- **Never analysed, previewed, sent or kept:** windows of excluded processes (password managers, Windows credential/UAC/lock screens, authenticators — editable list) or whose titles match excluded patterns (password, sign in, bank, payment, private/incognito browsing… — editable list), including their dialogs and pop-ups — they are blacked out in memory right after the reduced-resolution display grab, before anything else happens. Nothing at all is captured while such an app is in front, on the secure desktop, while the session is locked, or if private windows cannot be located.
- **Privacy pause** (tray menu or Settings) stops all capture instantly and is remembered across restarts. Capture is also suspended while the cat is hidden (including a hidden start) or the PC is locked.
- **Preview what the cat sees** (Settings → Privacy) shows the masked frame that is analysed or, in AI mode, the masked JPEG exactly as it would be sent. It is not saved and not sent.

Screenshots are never written to disk.

## Network access

| Feature | When | Destination |
|---|---|---|
| None (default) | — | — |
| AI vision, local server | Only in AI mode, model confirmed local | The URL you configured (default `127.0.0.1`), including metadata requests (`/api/version`, `/api/show`, `/api/tags`, `/v1/models`) that carry no screen data |
| AI vision, cloud | Only in AI mode **and** "Allow cloud processing" on | The provider/server you chose (e.g. `api.anthropic.com`), with your API key |
| "List models" / "Test connection" buttons | Only when you click them | The configured endpoint; the test sends a synthetic picture, never your screen |

There is no automatic update check. Installing a new version is a manual action.

## Your controls

Hide the cat (tray / `Ctrl+Alt+Shift+C`), pause it, turn off interactions (fully click-through), privacy-pause or disable screen analysis, revoke consent, clear history, reset personality, turn off *Walk on browser tabs*, *Play with the taskbar* or *Climb windows* (Settings → Behavior), turn off launch at sign-in (Settings → General, or Task Manager → Startup apps — the app never overrides a Task Manager disable), export diagnostics (a JSON file you can inspect before sharing), uninstall (also removes the startup entry).
