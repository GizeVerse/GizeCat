# Desktop Cat — Privacy policy

Desktop Cat is a local desktop companion. It has **no accounts, no telemetry, no analytics, no crash upload and no update pings**. With default settings it makes **no network requests at all**.

## What the cat observes (always on, stays on this PC)

| Signal | How | What is kept |
|---|---|---|
| Cursor position | `GetCursorPos`, polled while the app runs | Nothing persisted |
| Time since last input | `GetLastInputInfo` (one number) | Nothing persisted |
| "Typing-like" activity | Inferred when input happens without cursor movement. **No keyboard hook is installed; no key, character or text is ever read.** Scrolling may also count. | Nothing persisted |
| Foreground/other app windows | Win32 window events and enumeration: window rectangle, minimised/maximised state, executable file name (e.g. `code.exe`) to pick a coarse category (code, browser, video…) | Nothing persisted |
| Window titles | Read **only** while screen analysis is enabled, **only in memory**, **only** to check privacy exclusions (e.g. "password", "bank"). Never logged, persisted or transmitted. | Nothing |
| Displays | Monitor geometry and scale factors | Nothing persisted |

The clipboard is never read.

## What is stored on disk

All in `%APPDATA%\Desktop Cat\` (removed by deleting that folder; kept on uninstall unless you choose otherwise):

- `settings.json` — your preferences.
- `cat-state.json` — the cat's personality numbers (e.g. curiosity 0.62), mood numbers, counters (how often it was petted), learned favourite resting spots (display + horizontal position) and a short list of recent cat events ("nap", "pet"). **No window titles, app names, screenshots or text.**
- `secrets.json` — only if you enter an AI API key: the key encrypted with Windows DPAPI via Electron `safeStorage` (readable only by your Windows account).
- `logs\` — rotating diagnostic logs (max ~3 MB). Logs never contain window titles, API keys or image data; key-like strings are redacted.

You can clear the interaction history or reset the personality in **Settings → Personality**.

## Screen analysis (optional, OFF by default)

Screen analysis only runs after you explicitly opt in from the Privacy page; the opt-in records a timestamp, and without it the capture code refuses to run.

- **Local statistics** mode: on certain events (and at most every N seconds you choose), the app grabs a **small downscaled frame** (≈256 px wide) of a region (around the cat by default), blacks out the cat itself and any excluded windows, computes a handful of numbers (brightness, contrast, colourfulness, edge density, change since the last frame) and **discards the pixels immediately**. Nothing leaves the PC. These numbers are not "understanding" — they only tell the cat "dark/bright", "busy/quiet", "something changed/moving".
- **AI vision** mode: additionally, occasionally (default at most every 2 minutes and 12×/hour), a small JPEG (≤512 px) of the same masked region is sent to the AI provider **you configured**:
  - *Ollama* or an *OpenAI-compatible local server* on `localhost` — the image stays on your PC.
  - A non-local endpoint or *Anthropic (cloud)* — the image leaves your PC. This requires the separate **"Allow cloud processing"** switch; otherwise such requests are refused in code. The tray icon tooltip and the Privacy page always show "AI (cloud)" while this is active.
  - The model may only answer with a tiny structured report (scene type, energy, interest, one of 8 allowed cat reactions, a ≤80-character caption). Anything else is rejected. The model cannot run commands or control your PC.
- **Never captured:** windows of excluded processes (password managers, Windows credential/UAC/lock screens, authenticators — editable list) or whose titles match excluded patterns (password, sign in, bank, payment, private/incognito browsing… — editable list), the secure desktop, or anything while the session is locked.
- **Privacy pause** (tray menu or Settings) stops all capture instantly and is remembered across restarts.
- **Preview what the cat sees** (Settings → Privacy) shows exactly the masked frame that would be analysed. It is not saved.

Screenshots are never written to disk.

## Network access

| Feature | When | Destination |
|---|---|---|
| None (default) | — | — |
| AI vision, local provider | Only in AI mode | The URL you configured (default `127.0.0.1`) |
| AI vision, cloud provider | Only in AI mode **and** "Allow cloud processing" on | The provider you chose (e.g. `api.anthropic.com`), with your API key |

There is no automatic update check. Installing a new version is a manual action.

## Your controls

Hide the cat (tray / `Ctrl+Alt+Shift+C`), pause it, turn off interactions (fully click-through), privacy-pause or disable screen analysis, revoke consent, clear history, reset personality, export diagnostics (a JSON file you can inspect before sharing), uninstall.
