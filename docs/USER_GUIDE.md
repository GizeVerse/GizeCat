# Desktop Cat — User guide

## First start

1. Run `Desktop-Cat-Setup-<version>.exe`. It installs for your Windows account only (no administrator rights). The build is not code-signed, so SmartScreen may say "Windows protected your PC": choose **More info → Run anyway** if you trust the file you built or downloaded.
2. The cat wakes up with a stretch at the bottom of your screen. A **Welcome** page opens once: it explains the controls and confirms that screen analysis is **off**.
3. The cat lives in the **notification area** (tray). If you don't see the icon, open the `^` overflow and drag it onto the taskbar.
4. **Desktop Cat starts automatically when you sign in to Windows** (new in v1.1, on by default; a one-time notification tells you when this was switched on). Turn it off in Settings → General (Task Manager → Startup apps then lists Desktop Cat as *Disabled*), or directly in Task Manager → Startup apps. If you turn it off in Task Manager, Desktop Cat never turns it back on by itself; to re-enable it, enable it there again. It may appear a few seconds after sign-in, because Windows delays startup apps.

## Interacting with the cat

| You do | The cat… |
|---|---|
| **Move the cursor back and forth over it** (no click) | Gets petted: eyes close, it leans in and purrs. Bond grows. |
| **Click** it | Looks at you, flicks an ear or meows. Clicking a lot in a row annoys it; keep going and it walks away to hide. |
| **Double-click** it | A happy hop. |
| **Press and drag** | Picks it up by the scruff. Drop it anywhere — on the floor, on top of a window, on another monitor. Fling it and it flies (and may be a bit grumpy after a hard throw). |
| **Right-click** it | Quick menu: Pet, Call to cursor, Play, Go to sleep / Wake up, Pause/Resume, Hide, Settings…, Quit. |
| Move the cursor fast near it | Sometimes it gives chase for a few seconds (adjustable: Settings → Behavior → Chase length), may finish with a little pounce, then loses interest. A playful cat sometimes dodges a cursor rushing at it, then crouches facing it. |
| Call it (tray, right-click menu, settings) | It usually comes over. An annoyed, scared or sleepy cat may ignore one call with a flick of the tail — never twice in a row, at most about one call in three. |

Everywhere else the overlay is **click-through**: clicks go to the windows under it. Only the cat's own body catches the mouse.

## What it does on its own

The cat mostly sits, grooms, watches, loafs and naps, with short bursts of activity: wandering, zoomies, rolling over, batting at the cursor, coming over to ask for attention after a long quiet stretch (it meows once; ignore it and it gives up). It reacts to the desktop:

- A new window appears → it may get curious and go have a look, or jump onto its title bar and sit there. Move that window and it rides along; minimise or close it and the cat drops down, startled. A window pushed in front of its spot makes it hop down calmly.
- **Climbing (v1.1, reachable from the floor since 1.1.1):** it leaps up at the side of a window, catches it and climbs, pulls itself onto the top at the corner, walks along the top edge, sits there looking down into the window, and climbs back down the side. It goes exploring every few minutes when a window edge is reachable (personality decides how often; less while you type). Maximized windows offer nothing to climb: they cover the whole screen and their top is the screen's edge. *Settings → Behavior → Climb windows* turns this off; *Settings → Diagnostics → Surfaces* explains what the cat can reach right now.
- **The taskbar (v1.1):** with an auto-hiding taskbar, the cat notices it sliding in. Sometimes it hops on and rides it; when the taskbar slides away it is set down calmly on the screen's edge. It does not react every time, and less and less often when the taskbar keeps popping up. Even when it sits on or next to the taskbar, it can never catch clicks meant for the taskbar's buttons or stop it from appearing (those areas always pass clicks through). *Play with the taskbar* turns the voluntary reactions off (a taskbar sliding in under the cat still lifts it, so it never stands inside it).
- **Browser tabs (v1.1, Edge and Chrome):** the cat may stroll along a browser's tab strip, sit there, and glance at the tab you just switched to. It only uses the shape of the strip (never tab names or page content), never clicks, and keeps clear of the new-tab and window buttons. It does not use the strip of a maximized window (no room above it). *Walk on browser tabs* turns this off. Other browsers (e.g. Firefox) are not supported yet; the cat simply treats their windows like any other window.
- You switch apps a lot → it watches instead of running around.
- A video, game or media player is in front (windowed) → it stays calmer and watches.
- Now and then it wanders into a corner of the screen, or gives a small start at nothing in particular — rarely.
- Windows of private apps (password managers, banking, sign-in dialogs; see Privacy & Vision → exclusions) are never followed, inspected or sat on. Title-based exclusions only apply while screen analysis is on, because titles are not read otherwise.
- You type for a while → it settles nearby and watches you work (no keys are recorded — see the privacy policy).
- You are away → it falls asleep, preferably in one of its favourite spots; when you come back it wakes with a stretch.
- A fullscreen app, game or video is in front on its monitor → it gets out of the way (hidden by default; configurable to "quiet" or "ignore").
- Screen locked / PC sleeping → it sleeps.

It remembers its personality, mood, favourite spots and what you do together between sessions.

## Tray menu

Show/Hide · Pause/Resume cat · Interactions (on/off — off makes the cat fully click-through) · Vision privacy pause (only if screen analysis is set up; the label shows the mode) · Call · Settings… · Quit.
Left-click the tray icon to show/hide the cat. The tooltip always shows the state and the vision mode (`Vision: off / local stats / AI (local) / AI (cloud)`); the icon gets an eye badge while screen analysis is active and a pause badge when paused.

**Keyboard shortcut:** `Ctrl+Alt+Shift+C` shows/hides the cat (change or disable it in Settings → General).

## Settings

| Page | What you can change |
|---|---|
| General | Name, launch at Windows sign-in (on by default; shows whether Windows will really start it, e.g. "Disabled in Startup apps"), how it starts (visible, hidden, paused, or as you left it), shortcut, pause/show/call |
| Appearance | Coat (ginger, gray, black, tuxedo, calico, siamese, cream), smooth or pixel style, size, opacity, animation speed, shadow, emotes, hide from screenshots/screen sharing |
| Behavior | Movement speed, how independent it is, cursor play, chase length, attention seeking, sensitivity to window/activity events, minutes of inactivity before it sleeps, multi-monitor roaming, reactions to typing/windows, fullscreen behaviour, individual behaviours on/off (incl. v1.1: *Play with the taskbar*, *Climb windows*, *Walk on browser tabs*) |
| Interaction | Interactions on/off, petting, dragging, throwing, patience (how quickly repeated clicks annoy it) |
| Privacy & Vision | Screen analysis mode and consent, privacy pause, capture region, interval, excluded apps and window titles, "Preview what the cat sees" |
| AI | Optional AI provider (Ollama, OpenAI-compatible server, Anthropic), model, API key, limits, connection test — see [AI_SETUP.md](AI_SETUP.md) |
| Personality | Traits, current mood numbers, counters, learned preferences, recent memories; reset personality; clear history |
| Diagnostics | Window-awareness mode, taskbar / window-surface / browser-tab-strip status (e.g. tab strips unavailable if the helper was blocked), **Surfaces** (v1.1.1: why the cat can or cannot leave the floor — edges found, usable and reachable, what it stands on, tab-strip helper state; optional on-desktop outlines of what it sees, off after a restart), resource use, log level, export diagnostics, open logs folder, GPU compatibility switch |
| About | Version, license, privacy promise |

## Uninstalling

Windows Settings → Apps → Installed apps → **Desktop Cat** → Uninstall. Your cat (settings and memories in `%APPDATA%\Desktop Cat`) is kept so a reinstall brings it back; delete that folder to remove it completely. The uninstaller removes the launch-at-sign-in entry; if you reinstall later and the entry was on, startup is switched on again (a Task Manager disable is kept).

## Limits (by design of Windows)

The cat cannot appear above: exclusive-fullscreen games, the lock screen / UAC prompts (secure desktop), or — for interaction — windows of apps running as administrator (Windows blocks input from normal apps to elevated ones). It also hides itself on monitors where a fullscreen app is in front, by default.
