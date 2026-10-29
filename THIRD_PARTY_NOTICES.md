# Third-party notices

Desktop Cat is MIT-licensed (see `LICENSE`). It ships or bundles the following third-party software.

## Shipped in the installer

| Component | Version | License | Notes |
|---|---|---|---|
| Electron | 44.9.3 | MIT | `LICENSE.electron.txt` in the install folder |
| Chromium and its dependencies | 152 (via Electron) | BSD-3-Clause and others | `LICENSES.chromium.html` in the install folder |
| Node.js (via Electron) | 24.22 | MIT and others | included in Electron's notices |
| koffi | 3.3.4 | MIT, © Niels Martignène | native FFI module, `resources/app.asar.unpacked/node_modules/koffi` |
| @koromix/koffi-win32-x64 | 3.3.4 | MIT, © Niels Martignène | prebuilt koffi binary |
| node-addon-api (vendored in koffi) | as bundled by koffi 3.3.4 | MIT, © Node.js API collaborators | `node_modules/koffi/vendor/node-addon-api` |
| node-api-headers (vendored in koffi) | as bundled by koffi 3.3.4 | MIT, © Node.js | `node_modules/koffi/vendor/node-api-headers` |

The UI Automation helper `resources\native\DesktopCatUia.exe` (v1.1) is original code from `native/uia-helper/`, compiled with the .NET Framework C# compiler. It uses the .NET Framework and its UI Automation assemblies (`UIAutomationClient`, `UIAutomationTypes`, `WindowsBase`) that are part of Windows; none of them are redistributed.

## Bundled into the application JavaScript

| Component | Version | License |
|---|---|---|
| zod | 4.6.7 | MIT, © Colin McDonnell |

## Build and test tools (not shipped)

electron-builder 26.18.1 (MIT), esbuild 0.28.2 (MIT), TypeScript 6.0.3 (Apache-2.0), Vitest 5.0.5 (MIT), Playwright 1.64.1 (Apache-2.0), ESLint 10.13.0 (MIT), typescript-eslint 8.72.1 (MIT), @electron/fuses 2.1.3 (MIT). NSIS (zlib/libpng license) is downloaded by electron-builder to build the installer and its stub is part of the installer executable.

## Artwork, icons and sounds

All cat artwork, animations, emotes and icons are original and drawn procedurally in code (`src/renderer/overlay/cat/`, `scripts/gen-icons.cjs`). No third-party art, sprites, fonts or sounds are included. The research references studied (Pixel-Pet, pixelpets, mochi-llm-pet, deskcat, desktop-pet-cat) were used for ideas only; no code or assets were copied (see `docs/research/reference-pets.md`).

The settings window uses the Windows system fonts (Segoe UI Variable, Segoe Fluent Icons / MDL2 Assets) installed with Windows; no font files are bundled.
