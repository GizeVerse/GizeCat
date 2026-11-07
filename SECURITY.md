# Security policy

GizeCat (formerly Desktop Cat) runs on your desktop and knows where your windows are. If you opt in, it also analyses small, masked parts of your screen. Reports about anything that weakens those protections are very welcome.

## Supported versions

| Version | Supported |
|---|---|
| 1.2.x | Yes |
| Older than 1.2 | No |

Only the Windows build is supported. Builds for macOS, Linux or the web are experimental and are not supported releases yet. Reports about them are still welcome.

## Reporting a vulnerability

Please do not open a public issue, pull request or discussion for a security problem.

- **How:** use GitHub's private vulnerability reporting: on the repository's **Security** tab, choose **Report a vulnerability** (https://github.com/GizeVerse/GizeCat/security/advisories/new). Only the maintainers see the report.
- If that button is not available, open a normal issue that only says you have a security report and asks for a private channel. Put no details in it.

Please include:
- the version (Settings → About) and where the build came from;
- your Windows version;
- steps to reproduce, or a proof of concept;
- what an attacker gains;
- whether screen analysis or AI vision was on, and which provider type.

Do not send real screen contents, API keys or other people's data. Use a test account or a synthetic setup.

## Scope

In scope:
- **Main process.** The Electron main process, the koffi Win32 bindings, the `desktop-cat://` protocol, the settings, cat-state and secret stores, the launch-at-sign-in entry and the crash guard.
- **IPC and renderer isolation.** The preload bridges, zod validation, sender checks and rate limits; the sandbox, context isolation, CSP, and the denial of navigation and permission requests.
- **Perception and the privacy gate.** Consent, privacy pause, exclusions and masking, the capture pipeline, the cloud switch and loopback detection, AI output validation and the reaction allow-list.
- **The UI Automation helper** (`DesktopCatUia.exe`): what it queries, what input it accepts and how it is started.
- **The installer.** The per-user NSIS install and uninstall, the Electron fuses on the packaged app, and the removal of the startup entry.

What matters most: anything that reads or sends screen contents, window titles, keystrokes or the clipboard; anything that turns on analysis or cloud processing without consent; leaks an API key; lets a renderer reach Node or the OS; makes the overlay block input to the desktop; or adds hidden persistence.

Out of scope:
- Attacks that need code already running as the same Windows user. Such code can read DPAPI-protected secrets and change the app; that is the Windows security boundary.
- Platform limits: the overlay cannot appear on the secure desktop or over exclusive-fullscreen games, and cannot take input over elevated apps (UIPI).
- The SmartScreen warning on unsigned builds. The builds are not code-signed; this is known.
- How an AI provider you configured handles the images it receives. Cloud use is opt-in and governed by the provider's own policies.
- Vulnerabilities in Electron, Chromium, Node.js or another dependency that this app's configuration does not expose. Please report those upstream. If the pinned version is affected, tell us so we can update it.
- Versions older than 1.2.
- Scanner output without a demonstrated impact.

## What to expect

These are goals, not promises:
- an acknowledgement within 7 days;
- a first assessment within 14 days;
- for a confirmed issue, a fix or a mitigation plan within 90 days, and updates to you along the way;
- coordinated disclosure on a date we agree with you, and credit in the release notes if you want it.

There is no bug bounty.

## More

- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md): assets, trust boundaries, threats and mitigations.
- [docs/PRIVACY.md](docs/PRIVACY.md): what the app observes, stores and sends.
