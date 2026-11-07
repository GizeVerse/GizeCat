# Desktop Cat v1.1: code map of what to extend (worktree `v1.1`)

Everything below was read in the source (VERIFIED) unless it is labelled INFERRED or MEASURED. No repository files were changed. The only scratch file is `<local scratch>\v11research\codemap\taskbar.ps1`.

## 1. Movement (`src/core/movement`)

- **Types**
  - `Surface {kind:'floor'|'window', key, windowId, displayIds, y, x0,x1, landX0,landX1, pieces}` is in world.ts:20-36. `FloorPiece` is at 10-17.
  - `SimSupport = floor|window|air|held` is in shared/sim.ts:85-89. `Platform{windowId,y,x0,x1}` is in shared/world.ts:61-66.
  - `MoverMode = ground|crouch|air|held` is at mover.ts:68.
  - Every surface is horizontal. `sameSurface` is at world.ts:321-325.
- **Floors**: one per display at the bottom of `workAreaPx`. Neighbouring floors join within `floorJoinToleranceDip` 6 (world.ts:267-313, constants.ts:33).
- **Walls**: only the edges of the union of work areas: `clampInside` world.ts:153-157, and the in-air bounce at mover.ts:668-686. Window sides never collide.
- **Window tops**: `windowSurfaces()` world.ts:236-265 rejects a top when:
  - no display is at its midpoint;
  - `y-0.8·bh < wa.y` (no head room);
  - `bottom-y < 0.5·bh` (too close to the floor);
  - it is narrower than `0.9·bw`.
  The stand range is inset by 0.25·bw.
- **Per tick**: `sense()` mover.ts:265-272. It is emptied when perching is off and filters off-limits displays.
- **Jump planning**: `planLeg` 870-895 (walk / direct jump / one intermediate window / `drop`) → `planJumpLeg` 897-932 (max 420 DIP up, 600 DIP across) → `solveChecked` 934-943 (the sampled arc must stay inside the work areas ±2 px). `canReach` is at 296-305.
- **Jump execution**: take-off point reached → crouch (539-546) → `stepCrouch` 557-613 revalidates the target and launches with `ignoreWindowId` set to the old perch → `stepAir` 615-692. If the target disappears mid-flight, a free fall continues (646-649). Free fall lands through `findLanding` 694-717, an analytic descending crossing that skips windows whose `getWindowRect` is null.
- **Landing**: `land` 795-817 falls back to the floor if the window rect is gone. `setGrounded` 819-835 creates `Perch{windowId,rect,missingSince}`.
- **Riding a perch**: `ride` 720-760 reads the live rect every tick, applies its dx and sets y = rect.y. The perch is lost when:
  - the rect is null (minimized, closed or cloaked);
  - the window covers the work area (`coversWorkArea` 776-780, i.e. maximized);
  - the cat is more than 0.25·hw past a side;
  - the head-room or floor-proximity check fails;
  - the segment is missing from the platform list for longer than `perchGraceMs` 450, or `perchMovingGraceMs` 2500 while moving (constants.ts:39-42, used at mover.ts:753).
  On loss it starts a zero-velocity flight and sets `perchLost`.
- **Drag and throw**: `startDrag` 359-373 clears the perch, `stepHeld` 467-481, `endDrag` 376-410.
- **Pounce**: `hopTo` 335-346.
- **Off-limits displays**: 257-262 and 953-1002. `relocate` is at 434-442.
- **World changes**: `revalidate` 1011-1050.

## 2. Behaviour (`src/core/behavior`)

- **Tick order** (sim.ts:277-330): set off-limits displays → `sense(walkablePlatforms(env.platforms))` (289, 515-519, drops private windows except the current perch) → `updateMode` → events → `updateActivity` → `mover.step` (with `safeWindowRect` 430-439) → `onMoverStep` → `reconcilePhysical` → `drives` → `advance`/`reconsider` → `compose`.
- **Physical states**
  - The set is at states.ts:16; transitions at 58-83.
  - Entered from: `onMoverStep` 913-932 (crouch → `jumping` with suspend, or `cancelCrouch` if refused; `perchLost` → `falling`), `reconcilePhysical` 934-949, `onDragStart` 1771-1783, `onDragEnd` 1785-1795, `releaseIfHeld` 823-829, lost drag 1598-1612.
  - Left through: `landing` 250 ms (1210-1212) → resume of the suspended activity within 60 s (709-723). `enterLanding` 1614-1639 picks the follow-up; a `'perch'` fall adds fear and leads to `startled`.
- **Transitions**
  - `request` 568-588 blocks requests while physical or away, unless the cause is `physical` or `lifecycle`. Paths go through `PATH_INTERMEDIATES` (states.ts:179-211).
  - `go` 623-666 applies the guards (states.ts:151-164) and starts the exit cooldown (646).
  - `refresh` 605-621, `advance` 683-735.
- **States that use platforms**
  - `inspectingWindow`: variant `'explore'` is gated by `perchOnWindows`, the others by `inspectWindows` (531-548). `updInspect` 1373-1400; exit memory 1121-1126.
  - Walking `follow` 1252-1259; wandering down from a window 2261-2264; favourite spots on windows 2325-2328.
- **Where jumps to platforms are decided**: decide.ts:179-181 (the explore candidate), `perchTarget` sim.ts:2296-2309, `updInspect` 1386-1388, and any `goTo` with `allowJump` (1271).
- **Window handlers**
  - `handleEvent` 1643-1764. Privacy verdicts are recorded in every mode (1665-1675); reactions only in normal mode.
  - `onWindowAppeared` 1903-1923, `onWindowClosed` 1925-1934, `onForeground` 1936-1951, `onMoveStart` 1953-1965, `onMoveEnd` 1967-1975.
  - Minimized only clears the moving flag (1733-1735).
- **Cooldowns and habituation**: `Habituation` stimuli.ts:8-35, `Cooldowns.ready/set/take` 38-52, `RecentIds` 55-74, `windowRelevance` 109-129, `windowRelevanceFor` sim.ts:2188-2202.
- **DecisionView**: declared at decide.ts:42-79, built at sim.ts:2222-2254.
- **Output**: `compose` 2452-2514. `boundsPx` is always an upright box above the anchor (2509).
- **Test fixtures** (`tests/unit/core/behavior/fixtures.ts`)
  - `display`/`world`/`SINGLE`/`DUAL_*` at 15-41 model a taskbar as a shorter work area, with no floor inset.
  - `Harness` 47-138: `env.windows` becomes `platformsFrom` (157-161) plus `getWindowRect` (95). `buildEnv` lists every SimEnv field (82-102).
  - `settingsWith` 163, `insideAnyWorkArea` 169, `decisionView`/`scoreOf` 174-210.
- **Fuzz test** (sim-fuzz.test.ts:31-255): windows move on 5% of ticks (158-164). Invariants at 193-240: `air` support only in air states (210); the teleport check skips window supports (211-213); almost every state must be visited (263).

## 3. Host and Win32

- **Host** (catHost.ts `step` 239-293)
  - Platforms come from `getPlatforms(PLATFORM_MAX_AGE_MS=1000)` (23, 257).
  - The env snapshot `base` (260-274) is reused for every sub-step of ≤250 ms (277-281): platforms are frozen per host tick, `getWindowRect` stays live.
  - Fullscreen displays refresh every 1 s (253-256). The tick delay is the sim's `nextTickMs` clamped to 16–1000 ms (291-292). Cursor polling is a separate timer (312-337).
- **Window tracker** (windowTracker.ts)
  - `getPlatforms` 433-448 uses `listOccluders` (else the app-window list).
  - `invalidateGeometry` (120-123) runs only on settled window bursts (212/220/238), a new foreground window (254), reconcile (328) and exclusion changes (536). It does not run on a foreground or z-order change.
  - Bursts coalesce after 150 ms quiet, at most 600 ms (83-84). `debugInfo` is at 541-552.
- **computePlatforms** platforms.ts:53-76: an edge offers no platform if the window is minimized, maximized, fullscreen or private (56); every occluder above cuts it. `MIN_PLATFORM_WIDTH` = 80 px (8).
- **Win32 API** (win32Api.ts)
  - `describeHwnd` 288-350 drops `Shell_TrayWnd` and the other shell classes (constants.ts:67-72, check at 301).
  - `getWindowRect` 388-398 returns DWM extended frame bounds for any HWND, with no class filter.
  - `listOccluders` 515-529 includes the taskbar and skips this app's overlays.
  - Hook kinds (120-131; constants.ts:18-23): foreground, move/size start/end, minimize, show/hide/destroy, cloak, `OBJID_WINDOW` only (427). There is no LOCATIONCHANGE or REORDER hook.
- **Native bindings** (native.ts 116-171): includes `FindWindowExW` (257). There is no `FindWindowW` or `SHAppBarMessage` binding.
- **Floor inset**: `simWorld` simWorld.ts:12-25 shortens the sim's work areas by 4 DIP.
- **Overlays** use the raw work area: overlayWindow.ts:21-26, at `'screen-saver'` level (58). The px↔DIP origin is `workAreaPx` (displayMath.ts:11-19).

## 4. Renderer: adding a `climb` clip end to end

1. Add it to `ANIM_CLIPS` in shared/cat.ts:39-61 (and `ONE_SHOT_CLIPS` at 65 if it plays once).
2. In core clips.ts, add a `Phase` (5-27) and a `CLIP_MAP` entry (31-56). A new state also needs: `BEHAVIOR_STATES` cat.ts:5-31, `TRANSITIONS`/`STATE_SPECS` states.ts:58-131, `SELF_TIMED`/`AROUSAL` sim.ts:110-153, and the enter/update switches 1006-1217.
3. In the renderer: the `CLIPS` record (clips.ts:761-783 — a missing clip is a compile error), `crossFadeMs` 804-811, `loopPeriodS` 817-828.
   - Pose has global `rot`/`pivX`/`pivY` (pose.ts:5-15), applied in rig.ts:237-242.
   - Hit rects follow the posed points (scene.ts:284-320).
4. The IPC validator picks up new clips automatically (validate.ts:6, 33). `CatRenderState` (cat.ts:98-136) has no orientation field.
5. Tests that loop over every clip: renderer `clips.test.ts`:43,56,67,98; `animator.test.ts`:62,100,142; `presence.test.ts`:68-77 (the drawn extent must stay within `BODY_MARGIN_*`, renderMapping.ts:18-22); `reaction.test.ts`:205,368; `scene.test.ts`:48; `states.test.ts`:108-111; `sim-fuzz`:19,196; and scripts/preview-page/preview.ts:291-293.

## 5. Startup and settings

- **Schema** (settings.ts)
  - `SETTINGS_SCHEMA_VERSION` = 1 (10). `launchAtLogin` defaults to false (91).
  - `schemaVersion` is `z.literal(V).catch(V)` (183).
  - `migrateSettings` 207-215 only handles v0 → v1.
- **Store**: `settingsStore.load` 131-148 marks the store dirty only for corrupt or recovered files, so a migration result is not saved until the next patch. The store writes the full parsed object (89).
- **Startup sequence**
  - index.ts: the launched-at-login flag (61); settings load before `ready` (106-111).
  - app.ts: the login-item controller (154-161, `writesEnabled = !test`). The registry is written only when the setting changes (413-416). `startupPlan` 538, then 541-544, then Welcome 559 (startupState.ts:33-38).
  - Main-owned settings guard: startupState.ts:67-72, applied in handlers.ts:166.
- **Login item** (loginItem.ts): fixed value name (8), `--launched-at-login` argument (33), `isActive` 37-45, `onSettingChanged` 46-57. installer.nsh:7-8 removes the Run and StartupApproved values.
- **UI**: the toggle is general.ts:52, with the "inactive" note at 99-100. Strings are strings.ts:160-162; the diagnostics page shows the state at diagnostics.ts:99.
- **Catalog drift**: `fields.ts` covers numeric settings only. `catalog.ts` has compile-time completeness checks for `BEHAVIOR_IDS`/`STARTUP_STATES` (9, 22, 27-28). The tests are fields.test.ts:50,71,133-173.

## 6. Tests and hooks

- **Movement**: mover.test.ts (`Driver` 8-41 with `hiddenPlatforms`/`moving`; perch tests 176-221), world.test.ts, jump.test.ts.
- **Behaviour**: toggles.test.ts:45-72, sim-scenarios, states.test.ts.
- **Win32**: platforms.test.ts, windowTracker.test.ts:332-450, fakes.ts (`FakeNative` 52; `PRIMARY_MONITOR` at 50 has a 1152 px work area, i.e. a visible taskbar; `FakeExtendedWin32Api` 310), win32Api.real.test.ts.
- **Host**: catHost.test.ts. **Display**: simWorld.test.ts.
- **Startup**: settings.test.ts:18 (asserts the default is false), settingsStore.test.ts:123-138, lifecycle.test.ts:292-310, appStartupState.test.ts:90-213, e2e persistence.spec.ts:82 (asserts `schemaVersion` 1).
- **Test hooks** (testHooks.ts:22-42): `getSimOutput`, `getOverlays`, `getStatus`, `getSettings`, `getHostDebug`, `getStartup`, `injectEvent`, `forceInteractive`, `setTimeScale`, `runAction`, `patchSettings`, `saveNow`, `quit`. There is no hook for platforms, the tracker's debug info, or the intended login-item write.
- **e2e helpers** (tests/e2e/fixtures.ts): `launchApp` 26, `hook` 35, `waitForCat` 48, `quitApp` 60, `settingsPage` 74, `readLogLines` 92; plus `win32Probe.ts`.

## Measured (REAL: PowerShell P/Invoke, run under the machine lock)

While hidden, `Shell_TrayWnd` is visible and both `GetWindowRect` and the DWM frame are [0,1198,1920,1258]: a 2 px strip. The work area is [0,0,1920,1200]. `ABM_GETSTATE` = 1 (auto-hide). `ABM_GETTASKBARPOS` returns edge 3 (bottom) and [0,1140,1920,1200], the revealed rect, even while hidden. The sim floor is 1200 − 5 = 1195.

## Risks and traps

1. **Platform list lag.** The list can be up to 1 s old, stays frozen across sub-steps, and is not refreshed on z-order changes or programmatic moves (there is no LOCATIONCHANGE hook). The perch grace falls back to 450 ms on the first tick the rect stops moving (mover.ts:753), so the cat may drop after Win+Arrow or snap moves (INFERRED).
2. **The taskbar is not a platform.** Only `getWindowRect` and `listOccluders` see it. Routing it through `sense()` would tie it to "Sit on windows" (sim.ts:289).
3. **Size limit from the floor-proximity rule.** The revealed taskbar top is 55 px above the floor, so `bottom − y ≥ 0.5·bh` holds only for cat size ≤ 1.375 at 125%.
4. **Hidden taskbar is outside the sim world.** Its top (1198) is below the sim floor (1195), so `displayAt` returns null. The reveal and hide animations cross the inset band.
5. **Rising surfaces are not modelled.** Only descending landings exist. A taskbar sliding up under a standing cat leaves it at 1195, drawn on top of the taskbar.
6. **Every auto-hide would startle the cat.** Losing the perch sets the fall reason to `'perch'`, which adds fear and leads to `startled` (sim.ts:1631-1635). The clamp may also set `snap`.
7. **A normal (non-auto-hide) taskbar is outside the overlay.** The overlay matches the work area, which excludes the taskbar; the floor already sits on top of it. Drawing over the taskbar would need overlays sized to the full screen, a different px↔DIP origin, new overlay bounds checks (overlayManager.ts:201-205) and a change to e2e overlay.spec.ts:28.
8. **Possible clash with click-through (INFERRED).** A hit region near the bottom edge could make the overlay interactive there and block the auto-hide reveal or taskbar clicks (invariant T8).
9. **Climbing touches many horizontal-only assumptions.**
   - `Surface`, `SimSupport` and `MoverMode` only describe horizontal support.
   - The upright `boundsPx` drives presence, the click-through fallback and the cursor-poll rate.
   - `solveChecked` requires arcs to stay inside the work areas.
   - The fuzz invariants and the persisted `support`/spot kinds (catState.ts:42,98; sim.ts:2368) need the new kinds.
10. **An opt-out cannot be detected from settings.json.** v1 files always contain an explicit `launchAtLogin:false` because the whole object is written. Only registry residue or the 'login item updated' log lines (both UNVERIFIED, and logs rotate) could hint at a real opt-out. Also, because of `.catch(V)`, any parse that skips `migrateSettings` silently upgrades the version.
11. **Default-on needs a one-time explicit write.** No settings change event fires on a fresh install or migration. Writing on every start would clear a "Disabled" set in Task Manager (loginItem.ts:1-3). Persist a main-owned marker and mark the store dirty.
12. **Real registry writes outside tests.** `writesEnabled` is false only in test mode. `npm run dev` would register electron.exe plus the repo path. smoke-packaged.mjs:21-25 runs the packaged exe, where test mode is always off (index.ts:47), and would write the real HKCU Run value under the same name as a real install.
13. **Tests that pin old defaults** must change: settings.test.ts:18 and persistence.spec.ts:82.

## Recommendation

- Turn `Surface` into a tagged union (`floor`/`window`/`taskbar`/`tab`, plus vertical `side`). Keep a single planner (`planLeg`) and a single `ride()`, generalised to a surface-rect lookup instead of the window-only `getWindowRect`.
- Give the taskbar its own `SimEnv` field, polled every host tick, rather than a `Platform` entry. Add a non-startling fall reason for "surface retracted".
- Write the login item only when the app is packaged, not in test mode and not in smoke runs. Add a test hook that reports the intended write.
