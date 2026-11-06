# Roadmap

GizeCat is the first character of GizeVerse. These are directions, not dates or promises. What each platform can do today is in [docs/gizeverse/capability-matrix.md](docs/gizeverse/capability-matrix.md); how much of it has been run is in the [GizeVerse reports](docs/gizeverse/).

## Now: v1.2 on Windows, GizeVerse foundation

- Windows 10/11 desktop cat (v1.2.0), validated on Windows 11.
- A platform layer, a capability model with honest statuses, and fail-safe overlays (none where clicks could be blocked).
- macOS and Linux X11 profiles. Linux has run only in a container (virtual X server); macOS has never run.
- A web host: the real character in a browser page, with touch gestures.

## Next milestone

1. **Release hygiene**
   - Electron 44.10.x, behind a Windows regression run. Electron 44 is end-of-life on 2027-03-02.
   - Plan the move off synchronous safeStorage, which Electron 45 deprecates.
   - Owner decisions: security and conduct contacts; homepage and maintainer for Linux deb/rpm; whether and where to publish.
2. **Branding, installer side.** Rename the installer, shortcut and Apps-list names to GizeCat, only after `scripts/upgrade-test.ps1` passes from 1.2.0 on a disposable Windows user or VM.
3. **Real-hardware platform runs**
   - A macOS run of the checklist in [04-macos.md](docs/gizeverse/04-macos.md).
   - A Linux X11 desktop run (GNOME on Xorg, KDE X11, Xfce with compositing).
   - A Windows 10 run and a multi-monitor, mixed-DPI run.
4. **Linux packaging that keeps the Chromium sandbox:** a deb with an AppArmor profile, or a Flatpak. The AppImage is refused on systems that force `--no-sandbox`.
5. **Wayland users:** a windowed or in-page companion mode, because overlays stay off on Wayland and XWayland.
6. **Web host:** an installable PWA. Optionally a Capacitor wrapper for Android and iOS, after the App Store guideline 4.2 question is answered.

## Later

- **Window surfaces off Windows** (X11 `_NET_CLIENT_LIST_STACKING`; macOS with a consent design). Each needs a per-OS process identity for the privacy exclusions first.
- **Startup at sign-in off Windows** (XDG autostart, SMAppService). Opt-in, disclosed, never hidden.
- **A second GizeVerse character** through `CharacterDescriptor`, once the cat's behaviour is factored into a reusable sim.
- **Localisation** beyond English.

## Not planned

- Keyboard hooks, keystroke or clipboard capture, telemetry, or hidden persistence.
- Screen perception on by default, or perception on mobile.
- Native Android overlays that rely on reduced opacity to pass touches through ([why](docs/gizeverse/08-mobile-boundaries.md)).
