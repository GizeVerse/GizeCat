# Desktop-pet reference study (checked 2026-10-28)

**Labels:** **V** means I read it in the repo, the docs or the GitHub API. **I** means inference. Nothing was installed or run.

## 1. Per-repo findings

### diablovocado/Pixel-Pet (https://github.com/diablovocado/Pixel-Pet)
- **Activity:** 0★. Created 2026-07-25, last push 2026-08-23. No issues (V).
- **Stack:** Electron `^43.2.0` with plain-JS `main.js`/`renderer.js` and `node-global-key-listener`. The `util.isObject` polyfills in `main.js` are needed to make that listener load. The repo also bundles an unrelated React/TanStack/Lovable landing page (V).
- **Window:** a full-screen overlay sized to the primary display's `bounds`, with `focusable:false` and `setAlwaysOnTop(true,'floating')` (V). The Electron docs say `floating`…`status` sit **below the Windows taskbar** (V, [base-window.md](https://github.com/electron/electron/blob/main/docs/api/base-window.md)).
- **Click-through:** the renderer `mousemove` hit-tests the cat, then sends IPC to `setIgnoreMouseEvents(!on,{forward:true})` (V, `src/renderer/interactions.js`).
- **Art:** a 24×20 canvas grid at scale 7, drawn over the PNG `pepperino_cropped.png`, with procedural blink, ear twitch and pupil shift (V).
- **Behaviour:** a priority-stack FSM (`src/renderer/behavior.js`) (V):
  - sleeps after 60 s of idle and wakes when idle drops below 2 s
  - "hunt" when the mouse moves faster than 180 px/s within 320 px
  - typing makes it "excited"
  - a slow hover on the head for 1 s makes it purr
  - squash/stretch while dragged, with a damped-cosine bounce on landing
- **Awareness:** macOS only. It uses `osascript` for the frontmost app and `AXFullScreen`, and `pgrep`/`ps` with a CPU > 3 % rule to guess "Claude is thinking". All of this silently does nothing on Windows (V).
- **License:** the README says MIT, but there is **no LICENSE file** and GitHub detects none (V). The assets include `assets/bongo_cat_frames/*`, which is Bongo Cat meme derivative art (V for the filenames, I for the origin).
- **Flaws:** walk targets are random (x, y) points anywhere on screen, so the cat floats mid-desktop with no floor (V).

### JOhnsonKC201/pixelpets (https://github.com/JOhnsonKC201/pixelpets)
This is the most mature reference and the closest to our stack.
- **Activity:** 13★, v0.5.0, last push 2026-10-25, 87 PRs (V).
- **Stack:** Electron `^44.9.1`, electron-builder `^26.15.3` NSIS (`oneClick:false`, `perMachine:false`), `electronFuses` hardened, `uiohook-napi` for global key and wheel input, and `node:test` (V). This confirms Electron 44.9.x and electron-builder 26 work together for NSIS.
- **Window:** a full primary-display overlay with `focusable:false`, `sandbox:true`, `contextIsolation:true` and `setAlwaysOnTop(true,'screen-saver')` (V, `src/main.js`).
- **Click-through (worth copying):**
  - The renderer sends a "hot" rect (`setHot`) over IPC.
  - Main polls `screen.getCursorScreenPoint()` at about 30 Hz (20 Hz in low power).
  - It calls `setIgnoreMouseEvents(wantIgnore,{forward:true})` **only when the value changes**.
  - Their reason, in the code: "a renderer stall can never leave the screen stuck capturing clicks" (V).
- **Keep on top:** `src/main/keep-on-top.js` runs every 700 ms on win32: `setAlwaysOnTop(false)`, then `setAlwaysOnTop(true,'screen-saver')`, then `moveTop()` (V).
- **Geometry:** `src/main/geometry.js` takes the floor from `display.workArea` in DIP, sent from main. The stated reason is that the renderer's `window.screen` "mixes physical and logical pixels" at non-100 % DPI (V).
- **Robustness:**
  - `render-process-gone` reloads with exponential backoff and gives up after 5 crashes (V).
  - The preload calls `removeAllListeners` before each `on` so handlers don't stack after a reload (V).
- **Art and sound:** one role-coded procedural sprite recoloured into 15 coats, with every pose built on the same grid and quantised poses memoised (V, `docs/architecture.md`). The only painted PNGs are the climb frames, made from "prompts" in an external frame pack, so their provenance is unclear (V for the text, I that they are AI-generated). All audio is synthesised with Web Audio (V).
- **Behaviour:**
  - eyes follow the cursor, kneads while you type, purrs, mochi spring drag
  - a butterfly visitor with stalk, swat and pounce, plus fetch
  - "Focus Guard" defers notifications during meetings or quiet hours and delivers them later as one digest (V)
- **CHANGELOG lessons (V):**
  - A cursor resting on the pet purred forever. Fixed: the voice now settles after 8 s.
  - The swat whoosh fired about every 350 ms.
  - The pounce caught the butterfly 0 times in 316 tries.
  - `setVisibleOnAllWorkspaces` on a timer made the overlay strobe on macOS.
  - Unsigned builds trigger SmartScreen.
- **Scope creep:** IMAP mail, calendar, a launcher and an iPad shell server.
- **License:** MIT, and the README says "All art, code and sound here are original" (V).

### NatBrian/mochi-llm-pet (https://github.com/NatBrian/mochi-llm-pet)
- **Activity:** 22★, last push 2026-06-11, effectively dormant (V).
- **Stack:** Python 3.11, PyQt6, pywin32, mss, Pillow and psutil. No license (V).
- **Window:** a **small moving** frameless Qt tool window (about 300×246 logical px) with `WS_EX_LAYERED|TOOLWINDOW|NOACTIVATE`. Click-through toggles `WS_EX_TRANSPARENT` only when "cursor over sprite" flips. It calls `move()` only when the integer position changes and repaints only when the frame changes; the code comments say both are there to avoid flicker (V, `deskpet/ui/*`).
- **DPI:** `SetProcessDpiAwarenessContext(-4)` (per-monitor v2) is set before the Qt app starts (V).
- **Perception:**
  - `EnumWindows`, skipping invisible, untitled, `WS_EX_TOOLWINDOW` and DWM-cloaked (`DWMWA_CLOAKED=14`) windows
  - `Shell_TrayWnd` for the taskbar rect
  - `GetLastInputInfo` for idle time
  - `GetClipboardSequenceNumber` plus a hash, never the clipboard content (V)
- **LLM design (worth copying):** three clocks: sensors every few ms, the LLM on its own thread, the body at 60 fps.
  - A trigger manager decides when to call the model: a jittered heartbeat, a world-fingerprint check that skips unchanged heartbeats, a minimum interval, and immediate events.
  - The model returns a closed-vocabulary JSON intent: `verb`, `target`, `edge`, `emotion`, `emote`, `say`, `thought`.
  - `brain/parse.py` strips `<think>` and code fences, takes the first balanced `{}`, coerces values to enums and **never throws**; bad output becomes "idle".
  - A rule-based intent is used immediately at startup, a generation counter drops stale intents, and reflexes (pet, poke, throw) skip the model entirely (V).
- **Needs:** energy empties after about 90 min awake and refills after about 20 min of napping; mood drifts back to neutral over about 10 min; bond and xp grow with interaction. Stored in SQLite (V).
- **Physics:** gravity 1600 px/s², restitution 0.45, and window tops act as one-way platforms (V).
- **Vision:**
  - `mss` grabs the whole of monitor 1, downscales it and encodes it as JPEG q70 (V).
  - Window titles are shared by default (V).
  - The pet is not excluded from its own screenshot (I).
- **Assets:** the Bow.Pixel "Cat 85+" `.aseprite` and `.png` files are committed to the repo. The itch page **forbids** "Redistribute the asset to others" (V, https://bowpixel.itch.io/meow-cat-85-animation).

### coglabss/deskcat (https://github.com/coglabss/deskcat)
- **Activity:** 4★, last push 2026-06-14 (V).
- **Stack:** Electron `^31`, `@electron/packager`, electron-store and Jest. The README avoided electron-builder because unpacking its signing tools "requires Developer Mode/admin" (V).
- **Window:** a workArea-sized overlay with `'screen-saver'` level and **`nodeIntegration:true, contextIsolation:false`** (V).
- **Click-through:** every renderer `mousemove` sends IPC `cat:hover`, which calls `setIgnoreMouseEvents(!over,{forward:true})` with no dedupe (V).
- **Art:** a 12×9 sheet of 32×32 frames (V).
- **Behaviour:** `MoodModel` with hunger, energy and happiness from 0 to 100, which picks the cat's state (V). Hunger rises by 0.3/s, so the cat starts begging about 200 s after a feed, which makes it a constant nag (I, from the rates). Mood is **not persisted**; the store holds only `muted` and `autostart` (V).
- **License contradiction:** the LICENSE note says the assets are "NOT included in this repository", but `bundled-assets/cat-art.zip` and `cat-sounds.zip` are committed (V).
  - The octopusinkus "Cat Pack" page has **no license text** (V, https://octopusinkus.itch.io/cat-pack).
  - The sounds are credited only generically to "Pixabay / Freesound" (V).

### slc-w/desktop-pet-cat (https://github.com/slc-w/desktop-pet-cat)
- **Activity:** 0★. Created 2026-10-10, last push 2026-10-11 (V).
- **Stack:** C# WPF on .NET Framework 4.8, compiled locally by the launcher (V).
- **License:** "No project license has been selected yet", so all rights are reserved (V). The repo also commits a copyrighted Nyan Cat reference JPG (V).
- **Window:** **one small window per pet** with `AllowsTransparency`, `Topmost`, `ShowActivated=false` and `WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW` (V). The window procedure:
  - answers `WM_MOUSEACTIVATE` with `MA_NOACTIVATE`
  - answers `WM_NCHITTEST` with `HTTRANSPARENT (-1)` when the sprite pixel's alpha is below 16 (V, `prototype/DesktopCat.cs`)

  Their own README says click-through into other apps is still "manual testing" (V). I recall that `HTTRANSPARENT` only passes clicks to windows on the same thread, but did not re-check this (I).
- **Window awareness (best recipe found):** `prototype/World.cs`, refreshed 4×/s (V):
  - `EnumWindows`, skipping its own handle, invisible, minimised (`IsIconic`) and cloaked (attr 14) windows
  - skips the `Progman`, `WorkerW` and `Shell_*` classes
  - bounds from `DWMWA_EXTENDED_FRAME_BOUNDS (9)`, falling back to `GetWindowRect`
  - tool windows, menus (`#32768`) and tooltips block windows behind them but are not perches
  - a perch must be taller than 80 px
  - windows in front cut away landing space; a moving window carries the cat; minimising or closing it makes the cat fall
- **Personality:** 7 traits from 0 to 100 (Playfulness, Sleepiness, Curiosity, Affection, Boldness, Sensitivity, Patience), plus presets (V):
  - interest in the cursor falls off softly with distance and cuts out at 6–8 body heights
  - engagement builds over about 0.7 s of cursor motion and fades slowly
  - nearby motion while asleep accumulates "disturbance" toward a wake threshold set by Patience and Sleepiness
  - there are `sleep_twitch`/`sleep_peek` frames, and a 10 % chance of a crouch-wiggle before a chase
  - an unreachable target gets a 1.8 s "watch" instead of a fake catch
  - it doesn't chase the cursor while the settings window is open
- **Persistence:** JSON with `SchemaVersion`, validated and clamped, and malformed files are backed up before overwrite (V).

## 2. Other well-known pets
- **WindowPet** (https://github.com/SeakMengs/WindowPet): Tauri, React and Phaser. MIT code, 671★, last push 2025-04 (V).
  - Full-screen overlay with pixel-perfect drag; `setIgnoreCursorEvents` is toggled with a delay "to avoid crash when call setIgnoreCursorEvents too fast" (V).
  - Its 45+ characters are inspired by Shimeji-ee; their art licensing varies (I).
- **VPet** (https://github.com/LorisYounger/VPet): 7070★, active (V). The code is Apache-2.0, but the animation art is owned by the VUP-Simulator team under separate terms. This is the usual split: the code is free, the art is not (V).
- **Shimeji-ee / oneko** (from memory, not re-checked):
  - Shimeji-ee: gravity, climbing screen and window edges, being thrown, behaviours chosen by weighted conditions.
  - oneko: idle actions (scratch, wash, yawn, sleep) start as soon as the cursor stops.
- **What makes them feel alive:**
  - physics and perches
  - small idle motions (blink, ear twitch, tail flick, breathing)
  - anticipation before an action (crouch-wiggle)
  - attention that builds and fades rather than switching instantly
  - visible failure ("watch")
  - rotating through variants and mostly staying silent
  - rate-limited sound
  - sleep that follows the user's idle time, with a gradual wake

## 3. Synthesis
**Adopt:**
1. Click-through owned by main (pixelpets): poll at 30 Hz in main, hit-test against a hot rect or coarse mask sent by the renderer, toggle only on change, and fall back to *ignore* on renderer crash or hang.
2. Window model from slc-w, ported to koffi: `EnumWindows`, `IsWindowVisible`, `IsIconic`, `DwmGetWindowAttribute(14 / 9)`, `GetClassNameW`, `GetWindowLongPtrW(GWL_EXSTYLE)`, with z-order occlusion. DWM bounds are in **physical** pixels, so convert them with `screen.screenToDipRect(win, rect)` (Windows-only, V in [screen.md](https://github.com/electron/electron/blob/main/docs/api/screen.md)).
3. Floor taken from `display.workArea` in main.
4. Mochi's brain pattern with zod 4 in place of their parser: closed-vocabulary intent, `safeParse` falling back to idle, a trigger manager, a generation counter, reflexes that skip the model, and code (not the model) deciding what to remember.
5. Trait-driven continuous scores (slc-w), needs that change over hours not minutes (mochi), and settings files with a schema version and backups.
6. Crash-reload backoff and listener replacement in the preload (pixelpets).

**Avoid:**
- `nodeIntegration:true` (deskcat).
- Toggling click-through from the renderer on every mousemove (deskcat, Pixel-Pet).
- Global keyboard hooks (`uiohook-napi`, `node-global-key-listener`): native-addon ABI churn and a keylogger look. Use `GetLastInputInfo` or `powerMonitor.getSystemIdleTime()` instead.
- `'floating'` level if the cat should ever overlap the taskbar.
- Random 2D wander targets anywhere on screen.
- Fast-decaying needs that turn into nagging.
- Sending the whole desktop and window titles to a cloud model by default.
- shell-command polling such as `osascript`/`pgrep`, and feature creep.

**Assets:** none are legally safe to reuse.
- Pixel-Pet: no LICENSE file, plus meme-derivative art.
- mochi: the Bow.Pixel license forbids redistribution.
- deskcat: the art has no license, and the sounds' provenance is vague.
- slc-w: unlicensed, and it includes copyrighted reference art.
- pixelpets: the art is technically MIT, but the climb frames' provenance is unclear and copying it would make our cat derivative.

**Decision:** draw original procedural art and synthesise sound. Reuse ideas, not files.

## 4. Risks & recommendations
1. **Transparent areas are not click-through by default.** The Electron docs say "You cannot click through the transparent area" (V, [custom-window-styles.md](https://github.com/electron/electron/blob/main/docs/tutorial/custom-window-styles.md)). Keep the default `setIgnoreMouseEvents(true,{forward:true})`; `forward` works on Windows (V).
2. **`setShape(rects)`** (Windows, experimental) makes clicks fall through outside the given rects (V). But it also clips drawing, so the speech bubble would need its own rect, and calling it every frame is untested (I). Prototype it only as a fallback.
3. **The 700 ms always-on-top toggle-and-`moveTop` loop** can fight other topmost apps and churn z-order (I). Re-assert on events (display changes, focus changes via a hook, `isAlwaysOnTop()` checks) on a slower timer.
4. **Vision:** call `setContentProtection(true)` (`WDA_EXCLUDEFROMCAPTURE` on Windows 10 2004+) so the cat isn't in its own screenshots (V, base-window.md). This also hides the cat from the user's screen recordings and takes effect only at the next composition (V), so make it an option that is on only while capture is enabled. Keep capture opt-in, downscaled, local-first, without titles, and never written to disk.
5. **Full-screen overlays are invisible to normal screen recorders**, so pixelpets self-captures with `--shot` (V for their claim). Plan the Playwright `_electron` tests around `webContents.capturePage()`/page screenshots, not OS capture (I).
6. **Packaging:** electron-builder 26.11.0 replaced `rcedit` with `resedit` (PR #9717, V), and the latest 26.x is 26.18.1, released 2026-10-26 (V). This probably removes the Developer-Mode symlink failure deskcat hit ([#8149](https://github.com/electron-userland/electron-builder/issues/8149), closed) (I). Confirm on the first local NSIS build.
7. **Unsigned NSIS builds trigger SmartScreen** (V, from both Electron repos). Say so in the README.
8. **Mixed-DPI multi-monitor setups** are untested in every repo (V). Start on the primary display only and add DPI-scale tests for 100, 125, 150 and 200 %.
9. **Behaviour tuning:** cap sounds and speech per source, settle a reaction after a few seconds of a still cursor, rotate through variant pools, and make silence the default (lessons from the pixelpets CHANGELOG and mochi's persona prompt).

**Sources:** https://github.com/diablovocado/Pixel-Pet · https://github.com/JOhnsonKC201/pixelpets · https://github.com/NatBrian/mochi-llm-pet · https://github.com/coglabss/deskcat · https://github.com/slc-w/desktop-pet-cat · https://github.com/SeakMengs/WindowPet · https://github.com/LorisYounger/VPet · https://bowpixel.itch.io/meow-cat-85-animation · https://octopusinkus.itch.io/cat-pack · https://github.com/electron/electron/blob/main/docs/api/base-window.md · https://github.com/electron/electron/blob/main/docs/api/screen.md · https://github.com/electron/electron/blob/main/docs/tutorial/custom-window-styles.md · https://github.com/electron-userland/electron-builder/issues/8149 · https://github.com/electron-userland/electron-builder/pull/9717
