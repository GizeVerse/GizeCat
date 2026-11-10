# GizeCat on Windows (1.4.0 release candidate)

Windows 10/11 is the only platform where GizeCat has been validated on hardware, through release 1.3.0 on a Windows 11 x64 PC ([test report](../TEST_REPORT.md)). 1.4.0 is a release candidate: it adds an installer for Windows on Arm PCs. **The 1.4.0 installers have not been installed or run on any PC.** Statuses use the 1.4.0 vocabulary in [README.md](README.md#status-vocabulary-for-140).

## Which installer

| Your PC | Installer | Status |
|---|---|---|
| Almost every Windows PC (Intel or AMD processor) | `Desktop-Cat-Setup-1.4.0-x64.exe` | COMPILED_OR_PACKAGED; not run for 1.4.0 |
| A Windows on Arm PC (for example one with a Snapdragon processor) | `Desktop-Cat-Setup-1.4.0-arm64.exe` | COMPILED_OR_PACKAGED; checked statically; runtime THEORETICALLY_COMPATIBLE_NOT_EXECUTED |

To check your PC: **Settings → System → About**, then look at **System type**. "x64-based processor" means x64. "ARM-based processor" means ARM64.

- The x64 installer also installs on Windows 11 on Arm. The app then runs under Windows' x64 emulation (THEORETICALLY_COMPATIBLE_NOT_EXECUTED).
- Windows 10 on Arm has no x64 emulation, so the x64 build cannot run there (BLOCKED_BY_PLATFORM). The ARM64 build has not been tried on Windows 10 on Arm.
- If you start the ARM64 installer on a PC that is not Windows on Arm, it shows "This Desktop Cat installer is for Windows on Arm (ARM64) PCs. On this PC, use the x64 installer instead: Desktop-Cat-Setup-1.4.0-x64.exe" and stops without installing anything. A silent run (`/S`) stops with exit code 1.

The installer, the shortcuts and the Apps entry are still named **Desktop Cat** ([why](../gizeverse/12-branding.md)).

## Install, step by step

1. Download the installer for your PC and `SHA256SUMS.txt` from the release page on GitHub (<https://github.com/GizeVerse/GizeCat/releases>).
2. Check the download. In PowerShell, in your Downloads folder: `Get-FileHash .\Desktop-Cat-Setup-1.4.0-x64.exe -Algorithm SHA256`. The hash must match the line for that file in `SHA256SUMS.txt`.
3. Quit a running GizeCat first: right-click its tray icon, then **Quit**.
4. Run the installer. It installs for your Windows account only, into `%LOCALAPPDATA%\Programs\DesktopCat`. No administrator rights are needed.
5. The installer is **not code-signed**, so SmartScreen may say "Windows protected your PC". Choose **More info → Run anyway** if the hash matched. When Smart App Control is on, it can block unsigned installers, and it has no per-app exception ([what to do](troubleshooting.md#smart-app-control-blocks-the-installer)).
6. The cat appears at the bottom of your screen, and a Welcome page explains the controls. If it does not: [troubleshooting](troubleshooting.md#the-cat-does-not-appear).

## Upgrading and switching architecture

- Your cat and settings live in `%APPDATA%\Desktop Cat`, which every version uses. 1.4.0 keeps the same app identity, so installing it over 1.3.0 is an upgrade that keeps them. For 1.3.0, the upgrade from 1.2.0 was tested on a disposable machine; **the upgrade to 1.4.0 has not been run** (THEORETICALLY_COMPATIBLE_NOT_EXECUTED).
- To switch between x64 and ARM64, install the other installer over the existing app. It is the same app, so the installer treats it as an upgrade: the install folder, the Apps entry and your data stay (THEORETICALLY_COMPATIBLE_NOT_EXECUTED).
- To move your cat to another device, save it to a file: **Settings → Personality → Take your cat to another device** ([guide](profile-transfer.md)).

## Permissions

- **No administrator rights** and no elevation.
- **Starts when you sign in**, on by default. The first start shows a one-time notice. Turn it off in Settings → General, or in Task Manager → Startup apps; the app never overrides a Task Manager disable.
- **Screen analysis is off by default.** Only the consent dialog can turn it on ([privacy](../PRIVACY.md)).
- 1.4.0 adds no permission and no new data. The ARM64 installer is the same app with the ARM64 build of its one native library (koffi).

## What works and what does not

What the Windows app does (validated on Windows 11 x64 through 1.3.0; meant to be unchanged in 1.4.0, which has not run):
- the cat in transparent overlays on every display; only its body takes clicks;
- window tops and sides, the auto-hiding taskbar, and Edge and Chrome tab strips as places to walk;
- petting, clicking, dragging and throwing; the tray menu; the `Ctrl+Alt+Shift+C` shortcut;
- optional screen analysis (local statistics or AI vision), off by default.

On Windows on Arm, all of this exists in the ARM64 build but has never run. The tab-strip helper (`DesktopCatUia.exe`) is a .NET Framework "any CPU" program; by Microsoft's documentation, as read by the design pass, it runs under x64 emulation on Windows 11 on Arm (THEORETICALLY_COMPATIBLE_NOT_EXECUTED).

What it does not do:
- appear above exclusive-fullscreen games, the lock screen or UAC prompts, or take input over windows of apps running as administrator (Windows rules);
- walk on top, left or right taskbars, or on Firefox tab strips.

## Limitations

- Windows 10 and multi-monitor or mixed-DPI setups have not been tested on hardware.
- Nothing ARM64 has run on hardware.
- There is no automatic update. Install a new version over the old one.

## Signing and store status

| Item | Status |
|---|---|
| Unsigned installers, x64 and ARM64 | COMPILED_OR_PACKAGED. SmartScreen warns, and Smart App Control may block them |
| Code-signed installers (fewer SmartScreen warnings; Smart App Control) | REQUIRES_OWNER_CREDENTIALS (a code-signing certificate). The path exists: the manual `release.yml` workflow, job `windows-signed`, with `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` in the `windows-signing` environment. It has never been started ([release automation](release-automation.md)) |
| Signing with a key held only on a hardware token or cloud HSM | NOT_IMPLEMENTED |
| Microsoft Store listing | NOT_IMPLEMENTED |

## Uninstall

1. Quit the cat from its tray menu.
2. **Settings → Apps → Installed apps → Desktop Cat → Uninstall.** This also removes the startup entry.
3. Your cat is kept in `%APPDATA%\Desktop Cat`, so a reinstall brings it back. Delete that folder to remove it completely.

## Feedback

Open an issue at <https://github.com/GizeVerse/GizeCat/issues>. Use **Platform report** for Windows on Arm, Windows 10 or multi-monitor results, and **Bug report** for problems. Settings → Diagnostics → Export diagnostics writes a JSON file you can read before you attach it; it contains no API keys or window titles. If the overlay ever blocks clicks, quit GizeCat (tray menu, or Task Manager) and say so first in your report.
