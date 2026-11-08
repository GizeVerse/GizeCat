// The Android app (android/, guide in android/README.md), checked statically: no Gradle, no device.
// These pins keep the 1.4.0 design's privacy and security choices from drifting: no permissions,
// no cloud backup, a WebView that loads nothing but the app's own bundle, one narrow file bridge,
// no DevTools outside developer builds, and the frozen identifiers in src/shared/identity.ts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND } from '../../../src/shared/brand';
import { IDENTITY } from '../../../src/shared/identity';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const file = (...parts: string[]): string => path.join(ROOT, ...parts);
const read = (...parts: string[]): string => fs.readFileSync(file(...parts), 'utf8');
const KOTLIN_DIR = ['android', 'app', 'src', 'main', 'java', 'io', 'github', 'gizeverse', 'gizecat'];

/** Kotlin/Gradle source without block comments and whole-line `//` comments (keeps "https://" in strings). */
const stripCode = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const stripXml = (src: string): string => src.replace(/<!--[\s\S]*?-->/g, '');

const manifest = stripXml(read('android', 'app', 'src', 'main', 'AndroidManifest.xml'));
const activity = stripCode(read(...KOTLIN_DIR, 'MainActivity.kt'));
const bridge = stripCode(read(...KOTLIN_DIR, 'FileBridge.kt'));
const kotlin = `${activity}\n${bridge}`;
const gradle = stripCode(read('android', 'app', 'build.gradle.kts'));

/** The string literal assigned to `name` in Kotlin source (`const val NAME = "..."` or `name = "..."`). */
function literal(src: string, name: string): string {
  const value = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(src)?.[1];
  if (value === undefined) throw new Error(`no string literal for ${name}`);
  return value;
}

describe('Android manifest', () => {
  it('requests no permission: every uses-permission is a tools:node="remove" of a library one', () => {
    const uses = manifest.match(/<uses-permission\b[^>]*>/g) ?? [];
    for (const u of uses) expect(u).toContain('tools:node="remove"');
    expect(manifest).not.toMatch(/android\.permission\./);
    for (const p of ['INTERNET', 'SYSTEM_ALERT_WINDOW', 'FOREGROUND_SERVICE', 'READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE', 'MANAGE_EXTERNAL_STORAGE', 'ACCESS_NETWORK_STATE']) {
      expect(manifest).not.toContain(p);
    }
  });

  it('turns cloud backup off, keeps device transfer, and never allows cleartext or debugging', () => {
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
    expect(manifest).toContain('android:hasFragileUserData="true"');
    expect(manifest).toContain('android:usesCleartextTraffic="false"');
    expect(manifest).not.toContain('android:debuggable');
    const rules = stripXml(read('android', 'app', 'src', 'main', 'res', 'xml', 'data_extraction_rules.xml'));
    expect(rules).toContain('<device-transfer>');
    expect(rules).not.toContain('<cloud-backup');
  });

  it('is tablet-first: no forced orientation or aspect ratio, resizeable, one instance', () => {
    expect(manifest).not.toContain('screenOrientation');
    expect(manifest).not.toMatch(/(max|min)AspectRatio/);
    expect(manifest).toContain('android:resizeableActivity="true"');
    expect(manifest).toContain('android:launchMode="singleTask"');
    expect(manifest).toMatch(/android:name="android\.hardware\.touchscreen"\s+android:required="false"/);
  });

  it('keeps the live WebView through rotation, split screen, resizing, density and display moves', () => {
    const changes = (/android:configChanges="([^"]+)"/.exec(manifest)?.[1] ?? '').split('|');
    for (const c of ['orientation', 'screenSize', 'smallestScreenSize', 'screenLayout', 'density', 'keyboard', 'keyboardHidden', 'navigation', 'touchscreen', 'colorMode']) {
      expect(changes).toContain(c);
    }
    // These recreate the Activity on purpose: the theme, system bars and text are applied from scratch.
    for (const c of ['uiMode', 'locale', 'layoutDirection', 'fontScale']) expect(changes).not.toContain(c);
  });

  it('does no background work: no service, alarm, job, wake lock or battery-optimisation request', () => {
    expect(manifest).not.toContain('IGNORE_BATTERY_OPTIMIZATIONS');
    expect(manifest).not.toContain('WAKE_LOCK');
    for (const banned of ['AlarmManager', 'JobScheduler', 'WorkManager', 'startService', 'startForegroundService', 'bindService', 'PowerManager', 'WakeLock', 'ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS']) {
      expect(kotlin).not.toContain(banned);
    }
  });

  it('opts out of WebView metrics and declares no other exported component', () => {
    expect(manifest).toMatch(/android:name="android\.webkit\.WebView\.MetricsOptOut"\s+android:value="true"/);
    expect(manifest).not.toMatch(/<(provider|service|receiver)\b/);
    expect(manifest.match(/android:exported="true"/g)).toHaveLength(1);
  });
});

describe('Android WebView host', () => {
  it('serves the frozen origin: START_URL is androidWebOrigin + /assets/index.html', () => {
    expect(`https://${literal(activity, 'WEB_HOST')}`).toBe(IDENTITY.androidWebOrigin);
    expect(activity).toContain('const val WEB_ORIGIN = "https://$WEB_HOST"');
    expect(literal(activity, 'ASSET_PATH')).toBe('/assets/');
    expect(activity).toContain('const val START_URL = "$WEB_ORIGIN${ASSET_PATH}index.html"');
    expect(activity).toContain('.setDomain(WEB_HOST)');
    expect(activity).toContain('.setHttpAllowed(false)');
  });

  it('answers every request outside its own assets with a 404 and never navigates away', () => {
    expect(activity).toMatch(/url\.scheme == "https" && url\.host == WEB_HOST && url\.path\?\.startsWith\(ASSET_PATH\) == true/);
    expect(activity).toMatch(/return notFound\(\)/);
    expect(activity).toMatch(/shouldOverrideUrlLoading[^\n]*= !isOwn\(request\?\.url\)/);
  });

  it('locks the WebView settings down', () => {
    for (const s of [
      'javaScriptEnabled = true',
      'domStorageEnabled = true',
      'allowFileAccess = false',
      'allowContentAccess = false',
      'setGeolocationEnabled(false)',
      'javaScriptCanOpenWindowsAutomatically = false',
      'setSupportMultipleWindows(false)',
      'mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW',
      'mediaPlaybackRequiresUserGesture = true',
    ]) {
      expect(activity).toContain(s);
    }
  });

  it('has DevTools only in debuggable builds (release and trial are not debuggable)', () => {
    expect(activity).toContain('WebView.setWebContentsDebuggingEnabled(isDebuggable())');
    expect(activity).toMatch(/fun isDebuggable\(\): Boolean = \(applicationInfo\.flags and ApplicationInfo\.FLAG_DEBUGGABLE\) != 0/);
    expect(gradle).not.toMatch(/isDebuggable\s*=\s*true/);
  });

  it('exposes no JavaScript interface object, script injection, download listener or external intent', () => {
    for (const banned of ['addJavascriptInterface', 'addDocumentStartJavaScript', 'setDownloadListener', 'DownloadListener', 'ACTION_VIEW', 'ACTION_SEND']) {
      expect(kotlin).not.toContain(banned);
    }
    expect(kotlin).not.toMatch(/\bstartActivity\(/);
  });

  it('runs exactly one script, a fixed constant that closes the open dialog for Back', () => {
    // The only evaluateJavascript call, with the constant: never a string built from page or native data.
    expect(kotlin.match(/evaluateJavascript\(/g)).toHaveLength(1);
    expect(activity).toContain('wv.evaluateJavascript(CLOSE_TOP_DIALOG_JS) { result ->');
    expect(bridge).not.toContain('evaluateJavascript');
    const decl = /const val CLOSE_TOP_DIALOG_JS =\s*((?:"[^"\n]*"\s*\+?\s*)+)/.exec(activity)?.[1];
    expect(decl, 'CLOSE_TOP_DIALOG_JS must be string literals only').toBeDefined();
    const script = [...(decl ?? '').matchAll(/"([^"\n]*)"/g)].map((m) => m[1] ?? '').join('');
    expect(script).not.toContain('$');
    expect(script).toContain("document.querySelectorAll('dialog[open]')");
    expect(script).toContain('d.close()');
    // Without HTMLDialogElement the sheet still hears `close` (settingsPanel.ts resets its state there).
    expect(script).toContain("d.dispatchEvent(new Event('close'))");
    expect(script).toMatch(/return false;[\s\S]*return true;/);
  });
});

describe('Android back and lifecycle', () => {
  it('asks the page to close its dialog on Back before moving the app to the background', () => {
    // targetSdk 36 with the predictive-back opt-in: Android 13+ only calls OnBackInvokedCallback.
    expect(manifest).toContain('android:enableOnBackInvokedCallback="true"');
    expect(activity).toMatch(/if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.TIRAMISU\) \{[\s\S]*?onBackInvokedDispatcher\.registerOnBackInvokedCallback\(OnBackInvokedDispatcher\.PRIORITY_DEFAULT\) \{ onBack\(\) \}/);
    // Android 10-12: the WebView never passes the back key to the page.
    expect(activity).toMatch(/override fun onBackPressed\(\) \{\s*onBack\(\)\s*\}/);
    // Only when no dialog was open (or the page cannot answer) does the cat go to the background.
    expect(activity).toContain('if (result != "true") moveTaskToBack(true)');
    expect(activity).not.toMatch(/override fun onBackPressed\(\) \{\s*moveTaskToBack/);
    expect(activity).not.toMatch(/\bfinish\(\)/);
  });

  it('counts only renderer crashes, recreates the WebView only in front, and retries when reopened', () => {
    const gone = /override fun onRenderProcessGone\([^)]*\): Boolean \{([\s\S]*?)\n {8}\}/.exec(activity)?.[1] ?? '';
    expect(gone).toContain('if (detail?.didCrash() == true) {');
    // The only place a loss is recorded is inside the didCrash() branch.
    expect(activity.match(/renderCrashes\.addLast\(/g)).toHaveLength(1);
    expect(gone).toMatch(/if \(detail\?\.didCrash\(\) == true\) \{\s*val now = SystemClock\.elapsedRealtime\(\)\s*renderCrashes\.addLast\(now\)/);
    expect(gone).toContain('showMessage(R.string.renderer_failed)');
    // A lost renderer is replaced at once only while resumed, else on the next onResume.
    expect(gone).toContain('reattachPending = true');
    expect(gone).toContain('if (resumed) root.post { reattachIfPending() }');
    expect(gone).not.toContain('attachWebView()');
    expect(activity).toMatch(/fun reattachIfPending\(\) \{\s*if \(!reattachPending \|\| !resumed \|\| isDestroyed \|\| webView != null\) return/);
    expect(activity).toMatch(/override fun onResume\(\) \{\s*super\.onResume\(\)\s*resumed = true\s*reattachIfPending\(\)/);
    expect(activity).toMatch(/override fun onPause\(\) \{\s*resumed = false/);
    // Reopening (launcher, Recents, returning from another app) clears the crashes and retries.
    expect(activity).toMatch(/fun onReopened\(\) \{\s*renderCrashes\.clear\(\)\s*if \(webView == null\) reattachPending = true/);
    expect(activity).toMatch(/override fun onStart\(\) \{\s*super\.onStart\(\)\s*onReopened\(\)/);
    expect(activity).toMatch(/override fun onNewIntent\(intent: Intent\) \{\s*super\.onNewIntent\(intent\)\s*onReopened\(\)/);
    // A new WebView replaces a static message and never inherits onStop's process-wide pauseTimers().
    expect(activity).toMatch(/wv\.resumeTimers\(\)[\s\S]*?root\.removeAllViews\(\)\s*root\.addView\(wv,/);
  });
});

describe('Android file bridge', () => {
  it('is one web message listener named gizecatNative, for the exact app origin only', () => {
    expect(literal(bridge, 'BRIDGE_NAME')).toBe('gizecatNative');
    expect(kotlin.match(/addWebMessageListener\(/g)).toHaveLength(1);
    expect(bridge).toMatch(/addWebMessageListener\(\s*view,\s*BRIDGE_NAME,\s*setOf\(MainActivity\.WEB_ORIGIN\),/);
    expect(bridge).toMatch(/if \(!isMainFrame \|\| sourceOrigin\.toString\(\) != MainActivity\.WEB_ORIGIN/);
    expect(bridge).toContain('WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)');
  });

  it('accepts only the exact saveFile shape, JSON or plain text, capped at 256 KB', () => {
    expect(bridge).toContain('setOf("type", "name", "mime", "text")');
    expect(bridge).toContain('if (keys != MESSAGE_KEYS) return null');
    expect(bridge).toContain('if (json.opt("type") != "saveFile") return null');
    expect(bridge).toContain('ALLOWED_MIME: Set<String> = setOf("application/json", "text/plain")');
    expect(bridge).toContain('const val MAX_TEXT_BYTES = 256 * 1024');
    expect(bridge).toContain('if (request.bytes.size > MAX_TEXT_BYTES)');
    expect(bridge).toContain('if (message.type != WebMessageCompat.TYPE_STRING)');
    expect(bridge).toContain('put("type", "saveResult")');
    // The only message type the native side ever sends or accepts.
    const types = new Set([...kotlin.matchAll(/"(save[A-Z]\w*)"/g)].map((m) => m[1] ?? ''));
    expect([...types].sort()).toEqual(['saveFile', 'saveResult']);
  });

  it('cleans the file name before it reaches the document provider', () => {
    expect(bridge).toMatch(/sanitizeFileName\(name, mime\)/);
    expect(bridge).toContain('substringAfterLast(\'/\').substringAfterLast(\'\\\\\')');
    expect(bridge).toContain('Character.isISOControl(c)');
    expect(bridge).toContain('Character.FORMAT');
    expect(bridge).toContain('.trimStart(\'.\')');
  });

  it('uses the Storage Access Framework both ways and denies every other web permission', () => {
    expect(bridge).toContain('Intent.ACTION_OPEN_DOCUMENT');
    expect(bridge).toContain('Intent.ACTION_CREATE_DOCUMENT');
    expect(bridge).toContain('Intent.CATEGORY_OPENABLE');
    expect(bridge).toContain('putExtra(Intent.EXTRA_MIME_TYPES, ALLOWED_MIME.toTypedArray())');
    expect(bridge).toContain('resolver.openOutputStream(uri, mode)');
    expect(bridge).toMatch(/onPermissionRequest\(request: PermissionRequest\?\) \{\s*request\?\.deny\(\)/);
    expect(bridge).toMatch(/callback\?\.invoke\(origin, false, false\)/);
    expect(kotlin).not.toMatch(/\bgrant\(/);
  });
});

describe('Android Gradle build', () => {
  it('uses the frozen applicationId, never the desktop appId', () => {
    expect(IDENTITY.androidApplicationId).toBe('io.github.gizeverse.gizecat');
    expect(IDENTITY.androidApplicationId).not.toBe(IDENTITY.appId);
    expect(literal(gradle, 'namespace')).toBe(IDENTITY.androidApplicationId);
    expect(literal(gradle, 'applicationId')).toBe(IDENTITY.androidApplicationId);
    const kotlinPackage = /^package\s+([\w.]+)/m.exec(activity)?.[1];
    expect(kotlinPackage).toBe(IDENTITY.androidApplicationId);
  });

  it('targets API 36, supports Android 10+ and takes the version from package.json', () => {
    expect(gradle).toMatch(/compileSdk = 36\b/);
    expect(gradle).toMatch(/targetSdk = 36\b/);
    expect(gradle).toMatch(/minSdk = 29\b/);
    expect(gradle).toContain('repoRoot.resolve("package.json")');
    expect(gradle).toContain('appMajor * 10000 + appMinor * 100 + appPatch');
    expect(gradle).toContain('versionName = appVersion');
    const version = (JSON.parse(read('package.json')) as { version: string }).version;
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    expect(m, `package.json version ${version} must be MAJOR.MINOR.PATCH for versionCode`).not.toBeNull();
    const major = Number(m?.[1]);
    const minor = Number(m?.[2]);
    const patch = Number(m?.[3]);
    expect(minor).toBeLessThan(100);
    expect(patch).toBeLessThan(100);
    expect(major * 10000 + minor * 100 + patch).toBeLessThan(2_100_000_000);
  });

  it('signs release builds from the environment, then keystore.properties, and refuses a partial key', () => {
    for (const [key, env] of [
      ['storeFile', 'ANDROID_KEYSTORE_FILE'],
      ['storePassword', 'ANDROID_KEYSTORE_PASSWORD'],
      ['keyAlias', 'ANDROID_KEY_ALIAS'],
      ['keyPassword', 'ANDROID_KEY_PASSWORD'],
    ]) {
      expect(gradle).toContain(`"${key}" to "${env}"`);
    }
    expect(gradle).toContain('providers.environmentVariable(name)');
    // A secret that does not exist reaches a GitHub job as an empty string: blank counts as unset.
    expect(gradle).toContain('.filterValues { it.isNotBlank() }');
    // The environment wins over the file.
    expect(gradle.indexOf('signingEnv.isNotEmpty() ->')).toBeGreaterThan(-1);
    expect(gradle.indexOf('signingEnv.isNotEmpty() ->')).toBeLessThan(gradle.indexOf('keystoreFile.isFile ->'));
    // A partial environment or file stops the configuration, naming only what is missing.
    expect(gradle).toContain('Missing: ${missing.joinToString()}');
    expect(gradle).toContain('android/keystore.properties is missing values for: ${missing.joinToString()}');
    expect(gradle).toContain('the keystore file does not exist');
    // The build script never logs signing material and never creates a key.
    expect(gradle).not.toMatch(/\bprintln\b|\blogger\./);
    expect(gradle).not.toMatch(/keytool|genkey/i);
  });

  it('builds APK and AAB from one release type and keeps the build machine out of the outputs', () => {
    expect(gradle.match(/applicationId = "/g)).toHaveLength(1);
    expect(gradle).toMatch(/getByName\("release"\) \{[\s\S]*?vcsInfo \{ include = false \}[\s\S]*?\n {8}\}/);
  });

  it('signs trial builds with the debug key', () => {
    expect(gradle).toContain('rootProject.file("keystore.properties")');
    expect(gradle).toContain('signingConfig = signingConfigs.findByName("release")');
    expect(gradle).toMatch(/create\("trial"\) \{[\s\S]*initWith\(getByName\("release"\)\)[\s\S]*applicationIdSuffix = "\.trial"[\s\S]*signingConfig = signingConfigs\.getByName\("debug"\)/);
    expect(gradle).toContain('isMinifyEnabled = true');
    expect(gradle).toContain('includeInApk = false');
    expect(read('android', 'app', 'src', 'trial', 'res', 'values', 'strings.xml')).toContain(`<string name="app_name">${BRAND.product} (trial)</string>`);
    expect(read('android', 'app', 'src', 'main', 'res', 'values', 'strings.xml')).toContain(`<string name="app_name">${BRAND.product}</string>`);
  });

  it('depends on exactly androidx.webkit and androidx.core', () => {
    const deps = [...gradle.matchAll(/^\s*(implementation|api|runtimeOnly|compileOnly)\("([^"]+)"\)/gm)].map((m) => m[2] ?? '');
    expect(deps.map((d) => d.split(':').slice(0, 2).join(':')).sort()).toEqual(['androidx.core:core', 'androidx.webkit:webkit']);
  });

  it('pins the Gradle wrapper: the official 9.1.0 jar and a checksummed distribution', () => {
    const props = read('android', 'gradle', 'wrapper', 'gradle-wrapper.properties');
    expect(props).toContain('distributionUrl=https\\://services.gradle.org/distributions/gradle-9.1.0-all.zip');
    expect(props).toMatch(/^distributionSha256Sum=[0-9a-f]{64}$/m);
    expect(props).toContain('validateDistributionUrl=true');
    const jar = fs.readFileSync(file('android', 'gradle', 'wrapper', 'gradle-wrapper.jar'));
    expect(crypto.createHash('sha256').update(jar).digest('hex')).toBe('76805e32c009c0cf0dd5d206bddc9fb22ea42e84db904b764f3047de095493f3');
  });

  it('ships the existing artwork unchanged as the launcher icon', () => {
    const icon = fs.readFileSync(file('android', 'app', 'src', 'main', 'res', 'drawable-nodpi', 'gizecat_icon.png'));
    expect(icon.equals(fs.readFileSync(file('build', 'icon.png')))).toBe(true);
  });
});

describe('Android repository hygiene', () => {
  it('keeps signing secrets, the generated web bundle and build output out of git', () => {
    const ignore = read('.gitignore').split(/\r?\n/);
    for (const entry of ['android/keystore.properties', 'android/local.properties', 'android/app/src/main/assets/', 'android/app/build/', '*.jks', '*.keystore', '*.apk', '*.aab']) {
      expect(ignore).toContain(entry);
    }
  });

  it('names outputs by what they are, and offers one command for signed APK and AAB', () => {
    const script = read('scripts', 'android-gradle.mjs');
    expect(script).toContain('GizeCat-${version}-android-unsigned.apk');
    expect(script).toContain('GizeCat-${version}-android.apk');
    expect(script).toContain("GizeCat-${version}-android${aabSigned ? '' : '-unsigned'}.aab");
    expect(script).toContain('GizeCat-${version}-android-trial-debugsigned.apk');
    // An AAB's name comes from its own signature block, not from which configuration exists.
    expect(script).toContain('hasJarSignature(aab)');
    expect(script).not.toContain('keystore.properties');
    expect(script).not.toMatch(/ANDROID_KEY(STORE)?_(FILE|PASSWORD|ALIAS)/);
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
    expect(scripts['android:release']).toBe('node scripts/with-lock.mjs android -- node scripts/android-gradle.mjs :app:assembleRelease :app:bundleRelease');
  });

  it('documents the signing procedure and the store material with no filled-in value', () => {
    const signing = read('docs', 'platforms', 'android-signing.md');
    for (const name of ['ANDROID_KEYSTORE_FILE', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD', 'ANDROID_KEYSTORE_BASE64']) {
      expect(signing).toContain(name);
    }
    expect(signing).not.toMatch(/-(storepass|keypass)\b/);
    for (const doc of ['listing.md', 'data-safety.md', 'permissions.md', 'assets.md', 'release-readiness.md']) {
      expect(fs.existsSync(file('docs', 'store', 'google-play', doc)), doc).toBe(true);
    }
  });

  it('ships a keystore.properties example with empty values only', () => {
    const lines = read('android', 'keystore.properties.example')
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith('#'));
    expect(lines.map((l) => l.split('=')[0]).sort()).toEqual(['keyAlias', 'keyPassword', 'storeFile', 'storePassword']);
    for (const l of lines) expect(l).toMatch(/^\w+=$/);
  });

  it('keeps Windows batch files CRLF and jars binary', () => {
    const attrs = read('.gitattributes').split(/\r?\n/);
    expect(attrs).toContain('*.bat text eol=crlf');
    expect(attrs).toContain('*.jar binary');
  });

  it('copies the production web bundle (out/web) into the generated assets folder', () => {
    const script = read('scripts', 'build-web-app.mjs');
    expect(script).toContain("path.join(root, 'out', 'web')");
    expect(script).toContain("path.join(root, 'android', 'app', 'src', 'main', 'assets')");
    expect(script).toContain("'--web-only'");
    expect(script).toContain('__gizecatWebTest');
  });

  it('runs Gradle without daemons and sets JAVA_HOME/ANDROID_HOME for the child process only', () => {
    const script = read('scripts', 'android-gradle.mjs');
    expect(script).toContain("'--no-daemon'");
    expect(script).toContain('{ ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: androidHome }');
    expect(script).not.toMatch(/\bsetx\b|\[Environment\]::SetEnvironmentVariable/);
    expect(read('android', 'gradle.properties')).toContain('kotlin.compiler.execution.strategy=in-process');
  });

  it('keeps android/ out of ESLint (Kotlin and Gradle, not TypeScript)', () => {
    expect(read('eslint.config.mjs')).toContain("'android/**'");
  });
});
