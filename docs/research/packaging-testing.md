# Desktop Cat: build, packaging and test toolchain (researched 2026-10-28)

Tags: **[V]** means I read it today in the docs, the source or the npm registry. **[I]** means inference that I have not checked; confirm it on the first real run. I ran nothing locally: no Electron, no installs, no local services.

## 0. Versions compared with the plan [V]

| Package | Plan | Current | Note |
|---|---|---|---|
| electron | 44.9.x | **44.10.0** (2026-10-27). Latest is 45.1.0, and 45.0.0 only shipped on 10-21 | 43, 44 and 45 all embed Node **24.22.1** |
| electron-builder | 26.x | `latest` = 26.18.0. `v26` tag = **26.18.1** (10-26). `next` = 27.0.0-alpha.13 | Electron ≥45 needs 26.18.1 (see §1) |
| typescript | 6.0.x | **6.0.3**. npm `latest` is now **7.0.2** | typescript-eslint 8.72.1 has peer `typescript >=4.8.4 <6.1.0`, so stay on 6.0.3 |
| others | — | typescript-eslint 8.72.1, eslint 10.13.0, vitest 5.0.5 (+ **required** peer vite 8.3.5), jsdom 30.1.3, esbuild 0.28.2, zod 4.6.7, @playwright/test 1.64.1, koffi 3.3.4, @electron/fuses 2.1.3 | |

- Pin `@types/node@^24`. That matches the Node inside Electron, and the electron package itself depends on `@types/node ^24.9.0`. Do not use 26, even though this machine runs Node 26.4.
- Pin exact versions (no `^`) for electron, electron-builder and koffi.
- **Recommendation:** use Electron 44.10.x for v1, but write the preload to Electron 45's rules (§4).

Sources: `registry.npmjs.org/-/package/<pkg>/dist-tags`, https://releases.electronjs.org/releases.json

## 1. electron-builder 26 (NSIS, per-user, no admin)

Verified from `release/v26`: `app-builder-lib/src/targets/nsis/nsisOptions.ts`, `options/CommonWindowsInstallerConfiguration.ts`, `templates/nsis/{installer.nsi,multiUser.nsh,uninstaller.nsh}`, `targets/targetUtil.ts` and https://github.com/electron-userland/electron-builder/blob/release/v26/website/docs/nsis.md.

**Install location and elevation**
- `oneClick` defaults to true and `perMachine` to false. Together they give `RequestExecutionLevel user` and install to `%LOCALAPPDATA%\Programs\<APP_FILENAME>`. On upgrade, the old `InstallLocation` in HKCU is reused.
- `APP_FILENAME` is the sanitized package.json **`name`** for a one-click per-user install. For assisted or per-machine installs it is the product filename. Don't change `oneClick` after you ship.

**Options that only apply to the assisted installer**
- `allowToChangeInstallationDirectory` and `allowElevation` only work in the assisted installer.
- With `oneClick:false` and `perMachine:false`, the installer shows a per-user/per-machine choice page. To force per-user, add `!macro customInstallMode` with `StrCpy $isForceCurrentInstall "1"` in `build/installer.nsh`.

**Uninstall and app data**
- `deleteAppDataOnUninstall` only works with one-click and defaults to false.
- It is skipped when `${isUpdated}`. When it runs, it removes `%APPDATA%\{APP_FILENAME, productFilename, package name}`.
- The uninstaller also accepts `--delete-app-data`.

**Shortcuts and naming defaults**
- `createDesktopShortcut` takes `true | false | "always"`. The default `true` creates it on fresh installs only.
- `createStartMenuShortcut` and `runAfterFinish` both default to true.
- `artifactName` defaults to `${productName} Setup ${version}.${ext}`.

**Identity and app data path**
- The GUID is a UUIDv5 derived from `appId`, so **never change appId**. Call `app.setAppUserModelId(appId)` first thing in main.
- userData is `%APPDATA%\<productName || name>` ([app.md](https://github.com/electron/electron/blob/main/docs/api/app.md)). It sits outside the install directory, so it survives upgrades.
- Put `productName` in package.json so `electron .` and the packaged app use the same folder [I]. Alternatively, set userData explicitly before `ready`.

**What goes into the package**
- `package.json` and production `node_modules` are always included, whatever `files` says (`contents.md`).
- Smart unpack: any module containing `.node`, `.dll`, `.exe`, `.so` or `.dylib` is unpacked whole to `app.asar.unpacked` (`asar/unpackDetector.ts`).
- Windows icon: `.ico`, `.png` or `.svg`, minimum **256×256** (`icons-and-images.md`).

**Unsigned builds**
- The build succeeds. Since 26.16.1, "signing skipped" is logged at info level.
- Since 26.11, exe resource editing uses the JS `resedit` package instead of rcedit from winCodeSign. That probably avoids the Windows symlink-privilege extraction failure (#8149) when not signing [I].
- An unsigned installer triggers SmartScreen ("Unknown publisher" → More info → Run anyway). On Windows 11, Smart App Control may block it outright [I].

**Network use and caches at build time**
- Downloads: the Electron zip, plus `SHASUMS256.txt` on every build unless seeded or set via `electronDownload.checksums`. Also nsis-3.0.4.1 and nsis-resources-3.4.1 `.7z` from `github.com/electron-userland/electron-builder-binaries`.
- Caches: `ELECTRON_BUILDER_CACHE` (default `%LOCALAPPDATA%\electron-builder\Cache`) and `electron_config_cache` for Electron zips (default `%LOCALAPPDATA%\electron\Cache`, per [installation.md](https://github.com/electron/electron/blob/main/docs/tutorial/installation.md)).

**Known issues**
- Implicit publishing on CI (`onTagOrDraft`) is deprecated. Always pass `--publish never`.
- **Electron 45** ships `electron_wer.dll`, which must be renamed along with the exe. Only **26.18.1** does this (#10395, #10428).
- Open bug [#10454](https://github.com/electron-userland/electron-builder/issues/10454): if exactly one app process is running, the NSIS running-app check misses it (PowerShell 5.1 `.Count`), and the upgrade fails with "error 2". Make quitting clean and fast.
- I found no issues about Node 26 hosts in the tracker (searched today).

**koffi 3.3.4 layout** (jsdelivr `src/koffi/index.cjs`, `static.cjs`, `cnoke.cjs`)
- The binary now lives in optional per-platform packages. `@koromix/koffi-win32-x64` contains `win32_x64/koffi.node`.
- The loader tries, in order: a static `require('@koromix/koffi-<plat>')`; then `${__dirname}/../../../@koromix/koffi-<plat>`; then `process.resourcesPath/{koffi,koffi/build,node_modules/koffi/build}/<triplet>/koffi.node`.
- The `install` script (`cnoke --prebuild`) checks whether that require works. If it doesn't, it compiles from source with CMake.
- So **never use `--omit=optional`**, and don't let esbuild bundle koffi.
- Building for a different CPU architecture will be missing its binary, because npm filters optional packages by `cpu` [I].

```yaml
# electron-builder.yml
appId: <reverse-dns-you-own>.desktopcat   # immutable
productName: Desktop Cat
electronVersion: 44.10.0
directories: { output: release, buildResources: build }
files: ["dist/**/*", "!**/*.map"]
asar: true
asarUnpack: ["node_modules/koffi/**", "node_modules/@koromix/koffi-*/**"]  # explicit, on top of smart-unpack
extraResources: [{ from: assets/tray, to: tray }]
npmRebuild: false        # koffi ships prebuilt Node-API binaries [I]; nothing to compile
compression: normal      # 'store' for fast local test builds
win:
  target: [{ target: nsis, arch: [x64] }]   # Electron >=44 publishes no ia32
  icon: build/icon.ico                       # 16-256 px layers
nsis:
  oneClick: true
  perMachine: false
  createDesktopShortcut: true
  createStartMenuShortcut: true
  runAfterFinish: true
  deleteAppDataOnUninstall: false
  artifactName: "${productName}-Setup-${version}-${arch}.${ext}"
```

Keep koffi as the only runtime `dependency`. esbuild bundles everything else, so zod and the rest go in devDependencies.

## 2. Fuses

- Electron's [fuses.md](https://github.com/electron/electron/blob/main/docs/tutorial/fuses.md) lists 9 fuses, including `wasmTrapHandlers` [V].
- In builder 26, the `electronFuses` option (`FuseOptionsV1`) has no `wasmTrapHandlers` field. It is applied **after** `afterPack` and immediately before signing (`platformPackager.ts`) [V].
- Builder 26 embeds the Windows ASAR integrity resource itself (`electronWin.addWinAsarIntegrity`) [V].

```yaml
electronFuses:
  runAsNode: false                         # child_process.fork stops working; use utilityProcess
  enableCookieEncryption: true
  enableNodeOptionsEnvironmentVariable: false
  enableNodeCliInspectArguments: false     # stops Playwright driving the packaged exe
  enableEmbeddedAsarIntegrityValidation: true
  onlyLoadAppFromAsar: true
  loadBrowserProcessSpecificV8Snapshot: false
  grantFileProtocolExtraPrivileges: false  # serve UI via protocol.handle('app', ...)
```

- Check the result with `npx @electron/fuses read --app "release/win-unpacked/Desktop Cat.exe"`.
- The Playwright docs say: "Ensure that `nodeCliInspect` … fuse is **not** set to `false`" ([class-electron.md](https://github.com/microsoft/playwright/blob/main/docs/src/electron-api/class-electron.md)) [V].

## 3. Playwright 1.64 with Electron

Verified in [electron.ts](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/electron/electron.ts) and `loader.ts`:

**How launch works**
- `_electron` is re-exported from `@playwright/test`.
- Launch adds `--inspect=0 --remote-debugging-port=0`. Without `executablePath`, it uses `require('electron/index.js')` plus `-r loader.js`. The loader holds back `ready` and adds Chromium switches such as `--disable-backgrounding-occluded-windows` and `--force-color-profile=srgb`. A packaged exe gets no loader.
- On Windows it spawns with `shell:true` and quotes every argument, so avoid `%` and `"` in arguments [I]. `NODE_OPTIONS` is deleted.

**Closing**
- `close()` runs `app.quit()` in main and waits for the process to exit. A `before-quit` handler that calls `preventDefault` or hangs will hang test teardown.

**Electron binary download (Electron ≥42)**
- The binary downloads the first time `require('electron')` runs, not at postinstall (breaking-changes 42.0).
- Run `npx install-electron --no` before the tests.

**Isolating userData**
- `--user-data-dir=X` overrides `DIR_USER_DATA`, which is what `getPath('userData')` returns (`electron_main_delegate.cc`, `electron_api_app.cc`).
- `requestSingleInstanceLock` is keyed on the same directory. So a temp directory per test isolates both the data and the lock.
- This doesn't hold if the app calls `app.setPath('userData')` itself.

**Limits for this app** [I]
- `screenshot({ omitBackground: true })` keeps alpha ([V] in params.md). It captures only the renderer surface, not the desktop behind the window.
- CDP input bypasses OS hit-testing, so click-through (`setIgnoreMouseEvents`) can't be tested with `page.click`. Check it through the `browserWindow(page)` handle, or with a koffi `WindowFromPoint` probe.

```ts
import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join } from 'node:path';

export const test = base.extend<{ dir: string; app: ElectronApplication; cat: Page }>({
  dir: async ({}, use) => { const d = await mkdtemp(join(tmpdir(), 'dcat-')); await use(d); await rm(d, { recursive: true, force: true, maxRetries: 5 }); },
  app: async ({ dir }, use) => {
    const app = await electron.launch({ args: ['dist/main.cjs', `--user-data-dir=${dir}`], env: { ...process.env, DCAT_E2E: '1' }, timeout: 60_000 });
    await use(app);
    await Promise.race([app.close(), new Promise(r => setTimeout(r, 10_000))]); app.process().kill();
  },
  cat: async ({ app }, use) => use(await app.firstWindow()),
});
// Settings window opened later:
// const [settings] = await Promise.all([app.waitForEvent('window', p => p.url().includes('settings')), app.evaluate(({ BrowserWindow }) => { /* open */ })]);
// const onTop = await (await app.browserWindow(cat)).evaluate(w => w.isAlwaysOnTop());
```

`playwright.config.ts`: `workers: 1`, `fullyParallel: false`, `trace: 'retain-on-failure'`.

## 4. Vitest 5 and esbuild 0.28

**Vitest 5 changes** ([migration](https://github.com/vitest-dev/vitest/blob/main/docs/guide/migration/index.md)) [V]
- Needs Node ≥22.12 and vite ≥6.4 as a **required peer**.
- `clearMocks` now defaults to true.
- Inline projects inherit the root config, and **arrays are merged**, so don't set a root `include`.
- `vi.mock` must be at the top level.
- Unawaited `resolves`/`rejects` now fail the test.
- Reports go to `.vitest/`.
- The coverage provider defaults to `v8`.

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  restoreMocks: true,
  coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/**/*.d.ts', 'src/main/index.ts'], reporter: ['text', 'lcov'] },
  projects: [
    { test: { name: 'node', environment: 'node', include: ['src/{main,shared}/**/*.test.ts'] } },
    { test: { name: 'dom', environment: 'jsdom', include: ['src/renderer/**/*.test.ts'] } },
  ],
}});
```

**Preload rules for Electron 45** [V] ([breaking-changes 45.0](https://github.com/electron/electron/blob/main/docs/breaking-changes.md))
- Sandboxed preloads lose the `events`, `timers` and `url` shims and the `Buffer`, `setImmediate` and `clearImmediate` globals.
- Only `require('electron')`, `process` and `global` remain. Electron 44 still has the shims.
- Sandboxed preloads can't use ESM ([esm.md](https://github.com/electron/electron/blob/main/docs/tutorial/esm.md)).

```js
const common = { bundle: true, sourcemap: 'linked', logLevel: 'info' };
await Promise.all([
  esbuild.build({ ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist/main.cjs', platform: 'node', format: 'cjs', target: 'node24', external: ['electron', 'koffi'] }),
  esbuild.build({ ...common, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload.cjs', platform: 'browser', format: 'cjs', target: 'chrome152', external: ['electron'] }), // browser platform makes node: imports fail at build time [I]
  esbuild.build({ ...common, entryPoints: ['src/renderer/cat.ts', 'src/renderer/settings.ts'], outdir: 'dist/renderer', platform: 'browser', format: 'iife', target: 'chrome152' }),
]);
```

Add a post-build check that fails if `dist/preload.cjs` contains any `require(` other than `require("electron")`. esbuild doesn't type-check, so run `tsc --noEmit` separately.

## 5. TypeScript 6.0 and typescript-eslint

**TS 6.0 defaults** [V] ([announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/))
- `strict` is now true, `types` defaults to `[]`, `rootDir` defaults to `.`, and `noUncheckedSideEffectImports` is on.
- `moduleResolution node10` and `baseUrl` are deprecated. `outFile` is removed. `esModuleInterop` can no longer be false.

```jsonc
// tsconfig.base.json; main/preload/renderer/test configs extend it and set their own "types"/"lib"
{ "compilerOptions": {
  "target": "es2024", "lib": ["es2024"], "module": "preserve", "moduleResolution": "bundler",
  "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true, "noImplicitOverride": true,
  "verbatimModuleSyntax": true, "isolatedModules": true, "noEmit": true, "skipLibCheck": true, "types": [] } }
// main: "types": ["node"]   renderer: "lib": ["es2024", "dom"]
```

```js
// eslint.config.mjs (per the typescript-eslint Quickstart and Typed Linting pages)
import js from '@eslint/js'; import { defineConfig } from 'eslint/config'; import tseslint from 'typescript-eslint';
export default defineConfig(
  { ignores: ['dist/**', 'release/**', '.vitest/**'] },
  { files: ['**/*.ts'], extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
    languageOptions: { parserOptions: { projectService: true } } });
```

## 6. GitHub Actions (CI is currently not running on your account; this file is untested)

```yaml
name: ci
on: { push: { branches: [main] }, pull_request: {}, workflow_dispatch: {} }
permissions: { contents: read }
jobs:
  win:
    runs-on: windows-2025          # = windows-latest today
    timeout-minutes: 40
    env:
      ELECTRON_BUILDER_CACHE: ${{ github.workspace }}\.cache\eb
      electron_config_cache: ${{ github.workspace }}\.cache\electron
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: npm }
      - uses: actions/cache@v6
        with: { path: .cache, key: "eb-${{ hashFiles('package-lock.json') }}" }
      - run: npm ci
      - run: npx install-electron --no
      - run: npm run lint && npm run typecheck
      - run: npx vitest run --coverage
      - run: npm run build && npx playwright test
      - run: npx electron-builder --win nsis --x64 --publish never
      - uses: actions/upload-artifact@v7
        if: always()
        with: { name: desktop-cat-win, path: "release/*.exe\nplaywright-report/", if-no-files-found: warn }
```

Action versions checked today: checkout v7.0.1, setup-node v7.1.0, upload-artifact v7.0.2, cache v6.1.0.

## Risks & recommendations

1. **TypeScript 7 is npm `latest`.** A bare `npm i typescript` pulls 7.0.2, which typescript-eslint doesn't support. Pin `typescript@6.0.3`.
2. **Electron 45 is one week old.** Ship 44.10.x now and write the preload to 45's rules. If you move to 45, you also need electron-builder **26.18.1** (it's on the `v26` tag, not `latest`).
3. **The planned "44.9.x" is already out of date** (44.10.0 shipped 10-27). Pin exactly and update deliberately.
4. **Fuses and Playwright conflict.** Run end-to-end tests against the `dist/` dev build. Test the packaged exe separately: either a smoke test (launch it, check the log or window via koffi), or a test-only package built with `-c.electronFuses.enableNodeCliInspectArguments=true` [I].
5. **koffi:** keep it external in esbuild, never use `--omit=optional`, build x64 only, and after packaging confirm that `win-unpacked/resources/app.asar.unpacked/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node` exists.
6. **userData path:** lock `productName` and `appId` now. Use a separate dev userData folder or the `--user-data-dir` flag.
7. **Quitting:** a bounded, non-blocking `before-quit` keeps both Playwright `close()` and NSIS upgrades (#10454) working.
8. **Unsigned builds:** expect SmartScreen friction. Document "More info → Run anyway", and plan for Azure Trusted Signing if you distribute widely.
9. **Vitest 5:** install `vite` explicitly and don't set a root-level `include`.
10. **Network on first build:** the first build downloads from GitHub (Electron, NSIS). Cache `ELECTRON_BUILDER_CACHE` and `electron_config_cache`.
