# Launch at sign-in for Desktop Cat (Electron 44.9.3): technical brief

v1's launch-at-login status check is wrong for the default install path, and v1 dev runs write a broken startup entry under the production value name. I propose a main-owned state model with a strict write gate. One product decision is needed from the owner: how to treat v1's `false` value.

## 1. Current implementation (VERIFIED by reading the files)
- **`src/main/lifecycle/loginItem.ts`**
  - The value name is `LOGIN_ITEM_NAME = 'io.github.enesiltas.desktopcat'`. It is the same string as `APP_USER_MODEL_ID` in `index.ts:16`.
  - It writes only when the setting changes.
  - Arguments are `['--launched-at-login']` when packaged and ``[`"${appRoot}"`, flag]`` when unpackaged.
  - `writesEnabled: !boot.flags.test`, so **`npm run dev` writes an `electron.exe` entry under the production value name**.
- **`src/main/app.ts:154-161`**: `isActive()` returns `openAtLogin && executableWillLaunchAtLogin !== false`. Lines 413-415 call set and then re-read on a setting change.
- **`src/shared/settings.ts:91`**: `launchAtLogin: field(z.boolean(), false)` with `SETTINGS_SCHEMA_VERSION = 1`. The settings store saves the whole object, so **every v1 `settings.json` contains `"launchAtLogin": false`, whether or not the user ever touched it**.
- **`build/installer.nsh`**: `customUnInstall` deletes the Run and StartupApproved values unless `${isUpdated}`. electron-builder always passes `--updated` to the old uninstaller during an upgrade (`app-builder-lib/templates/nsis/include/installUtil.nsh:205`), so upgrades keep the entry.
- **Default per-user install folder — corrected after a real install:** `%LOCALAPPDATA%\Programs\DesktopCat\`, with the uninstaller `Uninstall DesktopCat.exe`. electron-builder derives both from `win.executableName` (`DesktopCat`), not from `productName`; an earlier draft of this brief said `Desktop Cat`, which was wrong.
- **Existing tests**: `install-test.ps1` and `smoke-packaged.mjs` have no login checks. `tests/unit/main/lifecycle.test.ts:292` has one test with a fake API.

## 2. What Electron 44.9.3 actually does
VERIFIED from the v44.9.3 sources `shell/browser/browser_win.cc`, `shell/common/command_line_util_win.cc` and `gin_converters/login_item_settings_converter.cc`. GitHub tree: https://github.com/electron/electron/blob/v44.9.3/shell/browser/browser_win.cc; the files were fetched through the cdn.jsdelivr.net/gh mirror. Docs: https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows

```ts
setLoginItemSettings(s: { openAtLogin?: boolean; path?: string; args?: string[]; enabled?: boolean /*default true*/; name?: string /*default AUMID*/ }): void
getLoginItemSettings(o?: { path?: string; args?: string[] }): { openAtLogin: boolean; executableWillLaunchAtLogin: boolean; wasOpenedAtLogin: boolean;
  launchItems: { name: string; path: string; args: string[]; scope: 'user' | 'machine'; enabled: boolean }[] }
```

**Writing (`setLoginItemSettings`)**
- It writes a REG_SZ under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, named `name`, or the AppUserModelID if `name` is not set.
- The data is `AddQuoteForArg(path)` followed by `' ' + AddQuoteForArg(arg)` for each argument. Any token containing a space, `\` or `"` is quoted using CommandLineToArgvW rules: `"` becomes `\"` and trailing backslashes are doubled.
- Quotes around `path` are stripped before re-quoting. Quotes around **args are not** stripped.
- `enabled: true` **deletes** `…\Explorer\StartupApproved\Run\<name>`. `enabled: false` writes REG_BINARY `03` followed by eleven `00` bytes. `openAtLogin: false` deletes both values.

**Reading (`getLoginItemSettings`)**
- `openAtLogin` reads the value named after the **AppUserModelID**; the `name` you pass is parsed but ignored. It is an exact, case-sensitive comparison with the formatted command line, and it ignores StartupApproved.
- `launchItems` and `executableWillLaunchAtLogin` enumerate HKCU and HKLM Run. They match the program case-insensitively against `CommandLine::FromString(options.path).GetProgram()`, so **an unquoted path containing a space gets split and never matches**.
- `enabled` is true when there is no StartupApproved value. Otherwise the bytes are compared as a C string to `""` or `"\x02"`, so only a first byte of `00`, or `02` followed by `00`, counts as enabled.

**Live probes** (REAL: Electron 44.9.3 run under the machine lock with unique names `DesktopCatProbe-b5c5ef46` and `DesktopCatProbe-73cc4cfa`; the cleanup run in `finally` was confirmed by a separate read-back):

| Test | Result |
|---|---|
| Path `C:\Users\Probe User\AppData\Local\Programs\Desktop Çat ğ 猫\DesktopCat.exe`, args `['--launched-at-login','C:\dir with space\x','"pre quoted"','tail\\','plain']` | REG_SZ, 149 UTF-16 units, non-ASCII kept: `"C:\Users\Probe User\AppData\Local\Programs\Desktop Çat ğ 猫\DesktopCat.exe" --launched-at-login "C:\dir with space\x" "\"pre quoted\"" "tail\\" plain` |
| Pre-quoted path | Same output. A pre-quoted *argument* becomes `"\"…\""`, which is broken. The d.ts advice "Take care to wrap paths in quotes" is out of date. |
| `get` with the unquoted path (spaces) | `openAtLogin: true`, **`executableWillLaunchAtLogin: false`, `launchItems: []`** |
| `get` with `'"'+path+'"'` | `executableWillLaunchAtLogin: true`, `launchItems: [{name, path, args: [], scope: 'user', enabled: true}]`. **Switch arguments are dropped from `args`.** |
| Lowercased quoted path | The item matches, but `openAtLogin` is false (case-sensitive comparison) |
| AppUserModelID different from `name` | `openAtLogin: false` |
| StartupApproved `03`+FILETIME, `03 00…`, `06 00…` | `enabled: false`; `openAtLogin` stays true |
| StartupApproved `02 00…` or `00 00…` | `enabled: true` |
| Calling `set(openAtLogin: true)` again while the value is `03` | The StartupApproved value is deleted, **erasing the opt-out** |
| `reg.exe query` output | Non-ASCII is mangled (`Desktop at g ?`), so never parse reg.exe output |
| koffi 3.3.4 from Node: `RegGetValueW` / `RegSetKeyValueW` / `RegDeleteKeyValueW` (HKCU as `intptr_t -2147483647`) | Exact UTF-16 round-trip. Returns 2 when the value is absent and 1630 for the wrong type. REAL (`koffi-reg.cjs`). |

**What this means for v1** (INFERRED from source and probes; not seen on a real install):
1. When the exe path contains a space (a user profile or custom install folder with a space — the default folder has none), `isActive()` is false. Settings shows the "launchInactive" warning even when the app really will start at sign-in.
2. In dev runs the pre-quoted `appRoot` argument produces a broken entry, and it can overwrite the installed app's entry.

## 3. Mechanisms compared
- **HKCU Run written by the app (recommended)**
  - Works for a standard user and is visible in Task Manager and Settings › Apps › Startup.
  - The user's opt-out lives in StartupApproved, and the uninstaller already cleans up.
  - Limits from https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys: the command line must be **at most 260 characters**; the order is not guaranteed; a program started from Run "**should not write to the key during its execution**"; and Windows may delay Run entries.
- **Startup-folder .lnk** (`shell.writeShortcutLink`): also visible, but its opt-out lives in a separate `StartupApproved\StartupFolder` key, Electron's getter can't see it, and the same delay applies. No advantage.
- **Run value written by NSIS at install time**: the installer can't see the in-app preference or a v1 opt-out, so two components would own the entry. `runAfterFinish: true` already launches the app after an interactive install, so the app can register itself then. Not recommended.
- **Task Scheduler logon task**
  - Per https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks, a non-admin can register a task for their own account with the interactive or S4U logon type and no password.
  - Whether a non-admin can add a *logon trigger* is UNVERIFIED. This session's token is High integrity (S-1-16-12288), so a standard-user test was not possible here.
  - It does not appear in Startup apps and has no StartupApproved opt-out (INFERRED), so it is less transparent. Not recommended.
- **Startup delay**: the `Explorer\Serialize` key is absent in both HKCU and HKLM on this machine (VERIFIED), so Windows defaults apply. `StartupDelayInMSec` and `WaitForIdleState` are documented only by the community (https://www.elevenforum.com/t/enable-or-disable-delay-of-running-startup-apps-in-windows-11.9144/). Don't change the user's system; the cat may appear seconds to minutes after sign-in, and a fast startup on `--launched-at-login` helps.

## 4. Migration and state model
**New main-owned settings section** (schema v2; the renderer cannot patch it, same as consent). The user changes it only through a dedicated IPC action, `setLaunchAtLogin(on: boolean)`. That action is the only path allowed to write `enabled: true` over a disable made in Windows.
```ts
loginItem: { preference: 'unset' | 'enabled' | 'disabled';
  decidedBy: 'default' | 'user' | 'migration' | 'windows';
  disabledBy: null | 'user' | 'windows' | 'external';
  registeredPath: string | null; v1Value: boolean | null; noticeShown: boolean }
```

**Reading Windows state**: use koffi `RegGetValueW` for our value name only, never enumerating the key. Parse `argv[0]` with CommandLineToArgvW rules. Apply Electron's enabled rule to the StartupApproved bytes. The Electron getter is not needed (it depends on the AppUserModelID and splits paths on spaces).

**`reconcile()`**: a pure function that runs at boot when writes are allowed. Rules in priority order:
1. Run value present and StartupApproved disabled → `disabled`/`windows`. **Never write.**
2. Run value absent but a disabled StartupApproved value exists (orphan) → `disabled`/`external`.
3. Preference `unset` → adopt an enabled entry if one exists; otherwise register (`decidedBy: 'default'`).
4. Preference `enabled`, entry enabled, but `argv[0]` differs from `execPath` (case-insensitive), or the arguments differ, or the program is `electron.exe` (left by v1 dev) → **repair the entry** (`set` with `enabled: true`; StartupApproved is absent or `02` anyway). Skip the repair when the app was launched at sign-in (Microsoft rule above).
5. Preference `enabled`, Run value absent:
   - `registeredPath` is null (migration), or the uninstall marker exists → register again.
   - Otherwise → `disabled`/`external`; do not re-add.
6. `disabled`/`windows` and the entry is enabled again (the user re-enabled it in Task Manager) → `enabled`/`windows`.
7. If the settings file loaded as `unreadable` or `corrupt` → make no automatic writes that session.

**Uninstall marker**: in a real uninstall, `customUnInstall` writes `$APPDATA\Desktop Cat\login-item-removed-by-uninstall` if that folder exists. A reinstall then registers again instead of reading the missing value as an opt-out.

**Migration from v1** (pure function in `src/shared`):
- `true` → `enabled`/`migration`.
- `false` → **ambiguous**. The registry cannot tell "never touched" from "turned on, then off", because `openAtLogin: false` deletes both values (VERIFIED). This needs an owner decision:
  - **(a) Recommended:** treat it as `unset` (default-on), but switch to `disabled` if there is a StartupApproved orphan, or if the old logs contain `{"s":"login-item","m":"login item updated","d":{"openAtLogin":false}}`. The logs rotate across 3 files, so this check is best-effort. Show a one-time notice when the app turns startup on.
  - **(b) Strict:** v1 `false` becomes `disabled`, and only new installs get default-on.

**Write gate** — every condition must hold:
- `app.isPackaged`
- not test mode
- `DESKTOP_CAT_LOGIN_ITEM !== 'off'`
- `Uninstall DesktopCat.exe` (derived from the exe name) exists next to `execPath` (`release/win-unpacked` has no uninstaller)
- the command line is at most 260 characters

Unpackaged and dev runs only read the status and never write, which removes both v1 dev bugs. The environment switch can only disable writes, so it is safe to honour in packaged builds.

## 5. Testing plan
- **Unit tests** (vitest)
  - A `FakeWindowsLogin` that copies Electron's behaviour exactly: a TS port of `AddQuoteForArg`, StartupApproved deletion and the `03` write, the getter ignoring `name`, and the space split.
  - Golden strings from the probe table above.
  - Table tests across preference × Run state (absent, ours, stale, `electron.exe`) × StartupApproved (absent, `00`, `02`, `03`+FILETIME, `06`) × flags (launched at sign-in, unpackaged, test, no uninstaller, env off, over 260 characters).
  - A property test: random boot sequences with no user action never bring back an approved entry after a `user`, `windows` or `external` opt-out.
  - Migration cases: v1 `true`, `false`, missing, corrupt.
- **Real tests on Windows** (opt-in, under the lock)
  - Promote the scratch probe to a script.
  - Use a unique name `DesktopCatTest-<hex>` and write it to disk before touching the registry.
  - Delete the Run and StartupApproved values in `try/finally`, then confirm they are gone by reading back through .NET.
  - Add a koffi round-trip integration test with a unique value name.
- **`install-test.ps1` additions**
  1. Refuse to run if our Run value already exists.
  2. Install into a folder with a space (`$env:TEMP\dcat install <rand>`).
  3. First launch with a temp userData folder: assert, via .NET `GetValue`, that the value equals `"$target\DesktopCat.exe" --launched-at-login` and that no StartupApproved value exists.
  4. Point the value at a stale path and relaunch: it should be repaired.
  5. Write `03`+FILETIME and relaunch: the StartupApproved value and the Run value must be unchanged.
  6. Silent upgrade: the value survives.
  7. Uninstall: both values are gone. Clean up in `finally`.
- **`smoke-packaged.mjs`**: also set `DESKTOP_CAT_LOGIN_ITEM=off`, on top of the missing-uninstaller guard.

## 6. Recommendation
- Use HKCU Run through `setLoginItemSettings({ openAtLogin, path: process.execPath, args: ['--launched-at-login'], name: LOGIN_ITEM_NAME, enabled: true })`. Pass unquoted values; Electron quotes them correctly.
- Read the state with koffi `RegGetValueW`, not `getLoginItemSettings`. If the Electron getter is kept anywhere, pass a **quoted** path.
- Keep `name` equal to the AppUserModelID.
- Implement `reconcile()` with the write gate above, and add the uninstall marker.
- Get the owner's decision on option (a) or (b) for v1 `false`.
- Don't use Task Scheduler or the Startup folder, and don't touch the startup-delay settings.

Scratch files are in `C:\Users\enes1\.claude\jobs\4f08f8fb\tmp\v11research\login\`:
- `probe\main.js`, `probe2\main.js`
- `probe-result.json`, `probe2-result.json`
- `koffi-reg.cjs`
- `regval.ps1`
- `src\*.cc` (downloaded Electron sources)

No repository files were modified.
