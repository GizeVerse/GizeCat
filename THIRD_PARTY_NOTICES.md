# Third-party notices

Desktop Cat is MIT-licensed (see `LICENSE`). It ships or bundles the following third-party software.

## Shipped in the installer

| Component | Version | License | Notes |
|---|---|---|---|
| Electron | 44.9.3 | MIT | `LICENSE.electron.txt` in the install folder |
| Chromium and its dependencies | 152 (via Electron) | BSD-3-Clause and others | `LICENSES.chromium.html` in the install folder |
| Node.js (via Electron) | 24.22 | MIT and others | included in Electron's notices |
| koffi | 3.3.4 | MIT, © Niels Martignène | native FFI module, `resources/app.asar.unpacked/node_modules/koffi` |
| @koromix/koffi-win32-x64 | 3.3.4 | MIT, © Niels Martignène | prebuilt koffi binary (x64 installer only) |
| @koromix/koffi-win32-arm64 | 3.3.4 | MIT, © Niels Martignène | prebuilt koffi binary (ARM64 installer only, 1.4.0) |
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

## License texts

The license texts of the third-party code that ships as a module or is bundled into the application JavaScript, copied unchanged from the installed packages. The application bundle drops license comments (`legalComments: 'none'` in `scripts/build.mjs`), so zod's notice is reproduced here. Electron, Chromium and Node.js carry their own notice files (see the first table).

### zod 4.6.7

Bundled into the application JavaScript. Copied from `node_modules/zod/LICENSE`.

```text
MIT License

Copyright (c) 2025 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### koffi 3.3.4, @koromix/koffi-win32-x64 3.3.4 and @koromix/koffi-win32-arm64 3.3.4

Shipped as a module; each Windows installer carries koffi and the one platform package for its architecture. Copied from `node_modules/koffi/LICENSE.txt`. Neither `@koromix/koffi-win32-x64` nor `@koromix/koffi-win32-arm64` contains a license file of its own; each `package.json` declares the MIT license and the same author as koffi.

```text
MIT License

Copyright (C) 2026  Niels Martignène <niels.martignene@protonmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the “Software”), to deal in
the Software without restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
```

### node-addon-api (vendored in koffi 3.3.4)

Copied from `node_modules/koffi/vendor/node-addon-api/LICENSE.md`.

```text
The MIT License (MIT)

Copyright (c) 2017 [Node.js API collaborators](https://github.com/nodejs/node-addon-api#collaborators)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### node-api-headers (vendored in koffi 3.3.4)

Copied from `node_modules/koffi/vendor/node-api-headers/LICENSE`.

```text
MIT License

Copyright (c) 2021 Node.js

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Android app

The Android app (`android/`, 1.4.0) wraps the same web bundle in a native WebView, so it includes zod (see above). Its APK and AAB also contain the libraries below, from Google Maven and Maven Central. The list is the resolved runtime classpath of the Gradle build: `androidx.webkit` and `androidx.core` are the only direct dependencies, and the rest are transitive. R8 removes the code the app does not use. All of them are licensed under the Apache License 2.0 (<https://www.apache.org/licenses/LICENSE-2.0>).

| Component | Version | License |
|---|---|---|
| androidx.webkit:webkit | 1.14.0 | Apache-2.0, © The Android Open Source Project |
| androidx.core:core | 1.17.0 | Apache-2.0, © The Android Open Source Project |
| androidx.core:core-viewtree | 1.0.0 | Apache-2.0, © The Android Open Source Project |
| androidx.annotation:annotation-jvm | 1.8.1 | Apache-2.0, © The Android Open Source Project |
| androidx.annotation:annotation-experimental | 1.4.1 | Apache-2.0, © The Android Open Source Project |
| androidx.arch.core:core-common, core-runtime | 2.2.0 | Apache-2.0, © The Android Open Source Project |
| androidx.collection:collection-jvm | 1.4.2 | Apache-2.0, © The Android Open Source Project |
| androidx.concurrent:concurrent-futures | 1.1.0 | Apache-2.0, © The Android Open Source Project |
| androidx.interpolator:interpolator | 1.0.0 | Apache-2.0, © The Android Open Source Project |
| androidx.lifecycle:lifecycle-common, lifecycle-runtime | 2.6.2 | Apache-2.0, © The Android Open Source Project |
| androidx.profileinstaller:profileinstaller | 1.3.0 | Apache-2.0, © The Android Open Source Project |
| androidx.startup:startup-runtime | 1.1.1 | Apache-2.0, © The Android Open Source Project |
| androidx.tracing:tracing | 1.2.0 | Apache-2.0, © The Android Open Source Project |
| androidx.versionedparcelable:versionedparcelable | 1.1.1 | Apache-2.0, © The Android Open Source Project |
| org.jetbrains.kotlin:kotlin-stdlib | 2.2.10 | Apache-2.0, © JetBrains s.r.o. and Kotlin Programming Language contributors |
| org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm, kotlinx-coroutines-android | 1.8.1 | Apache-2.0, © JetBrains s.r.o. and contributors |
| org.jetbrains:annotations | 23.0.0 | Apache-2.0, © JetBrains s.r.o. |
| com.google.guava:listenablefuture | 1.0 | Apache-2.0, © The Guava Authors |
| org.jspecify:jspecify | 1.0.0 | Apache-2.0, © The JSpecify Authors |

The launcher icon is the app's own artwork: `build/icon.png`, copied unchanged to `android/app/src/main/res/drawable-nodpi/gizecat_icon.png`. Android System WebView draws the page; it is part of the device and is not redistributed.

Build tools, not shipped in the APK or AAB: the Android Gradle Plugin 9.0.1 with its D8/R8 and lint (Apache-2.0), the Kotlin compiler 2.2.10 built into it (Apache-2.0), and Gradle 9.1.0 (Apache-2.0). The Gradle wrapper (`android/gradlew`, `android/gradlew.bat`, `android/gradle/wrapper/gradle-wrapper.jar`; Apache-2.0, © the original authors of Gradle) is committed in the repository, so the build can download its pinned Gradle distribution.

The Android app does not show these notices yet. Before a store release it needs an in-app licenses page, or a copy of this section in the bundled page.
