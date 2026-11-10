// The Android app (android/, guide in android/README.md), checked statically: no Gradle, no device.
// These pins keep the 1.4.0 design's privacy and security choices from drifting: only the four
// permissions the floating cat needs (1.4.1, docs/platforms/android-overlay.md), no cloud
// backup, a WebView that loads nothing but the app's own bundle, narrow native bridges, no DevTools
// outside developer builds, and the frozen identifiers in src/shared/identity.ts.
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
// The floating cat (1.4.1).
const overlayWindow = stripCode(read(...KOTLIN_DIR, 'OverlayWindow.kt'));
const floatingService = stripCode(read(...KOTLIN_DIR, 'FloatingCatService.kt'));
const floatingBridge = stripCode(read(...KOTLIN_DIR, 'FloatingBridge.kt'));
const floatingState = stripCode(read(...KOTLIN_DIR, 'FloatingState.kt'));
const allKotlin = `${kotlin}\n${overlayWindow}\n${floatingService}\n${floatingBridge}\n${floatingState}`;
const gradle = stripCode(read('android', 'app', 'build.gradle.kts'));

/** The string literal assigned to `name` in Kotlin source (`const val NAME = "..."` or `name = "..."`). */
function literal(src: string, name: string): string {
  const value = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(src)?.[1];
  if (value === undefined) throw new Error(`no string literal for ${name}`);
  return value;
}

describe('Android manifest', () => {
  it('requests exactly the four permissions of the floating cat, and nothing else', () => {
    // Everything else in the manifest's uses-permission list is a tools:node="remove" of a library one.
    const uses = (manifest.match(/<uses-permission\b[^>]*>/g) ?? []).filter((u) => !u.includes('tools:node="remove"'));
    const names = uses.map((u) => /android:name="([^"]+)"/.exec(u)?.[1] ?? '').sort();
    expect(names).toEqual([
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.SYSTEM_ALERT_WINDOW',
    ]);
    for (const p of [
      'INTERNET',
      'READ_EXTERNAL_STORAGE',
      'WRITE_EXTERNAL_STORAGE',
      'MANAGE_EXTERNAL_STORAGE',
      'ACCESS_NETWORK_STATE',
      'RECEIVE_BOOT_COMPLETED',
      'WAKE_LOCK',
      'BIND_ACCESSIBILITY_SERVICE',
      'CAMERA',
      'RECORD_AUDIO',
      'READ_PHONE_STATE',
      'PACKAGE_USAGE_STATS',
      'QUERY_ALL_PACKAGES',
      'REQUEST_INSTALL_PACKAGES',
    ]) {
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

  it('does background work only in the user-started floating service: no alarm, job, wake lock, boot start or battery-optimisation request', () => {
    expect(manifest).not.toContain('IGNORE_BATTERY_OPTIMIZATIONS');
    expect(manifest).not.toContain('WAKE_LOCK');
    expect(manifest).not.toContain('BOOT_COMPLETED');
    for (const banned of [
      'AlarmManager',
      'JobScheduler',
      'WorkManager',
      'bindService',
      'WakeLock',
      'ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
      'AccessibilityService',
      'MediaProjection',
      'BOOT_COMPLETED',
      'UsageStatsManager',
      'ACTION_INSTALL_PACKAGE',
    ]) {
      expect(allKotlin).not.toContain(banned);
    }
    // The service never restarts itself: after a reboot or a kill the cat is off until the user starts it.
    expect(floatingService).toContain('return START_NOT_STICKY');
    expect(floatingService).not.toContain('START_STICKY');
    // The Activity itself still starts no service; only the bridge does, on the user's tap.
    expect(kotlin).not.toMatch(/startService|startForegroundService/);
  });

  it('opts out of WebView metrics and declares one non-exported service and no other exported component', () => {
    expect(manifest).toMatch(/android:name="android\.webkit\.WebView\.MetricsOptOut"\s+android:value="true"/);
    expect(manifest).not.toMatch(/<(provider|receiver)\b/);
    expect(manifest.match(/<service\b/g)).toHaveLength(1);
    expect(manifest).toMatch(/<service\s+android:name="\.FloatingCatService"\s+android:exported="false"\s+android:foregroundServiceType="specialUse">/);
    expect(manifest).toContain('android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE');
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

  it('runs exactly two scripts, both fixed constants: one closes the open dialog for Back, one opens the settings sheet', () => {
    // The only evaluateJavascript calls, with constants: never a string built from page or native data.
    expect(allKotlin.match(/evaluateJavascript\(/g)).toHaveLength(2);
    expect(activity).toContain('wv.evaluateJavascript(CLOSE_TOP_DIALOG_JS) { result ->');
    expect(activity).toContain('wv.evaluateJavascript(OPEN_SETTINGS_JS, null)');
    expect(bridge).not.toContain('evaluateJavascript');
    const openDecl = /const val OPEN_SETTINGS_JS = "([^"\n]*)"/.exec(activity)?.[1] ?? '';
    expect(openDecl).not.toContain('$');
    expect(openDecl).toContain("document.getElementById('btn-settings')");
    expect(openDecl).toContain('b.click()');
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

  it('returns to the cat on Back from any other page, and never reads the history on the cat page', () => {
    const onBack = /private fun onBack\(\) \{([\s\S]*?)\n {4}\}/.exec(activity)?.[1] ?? '';
    // WebView.getUrl() is null before the first commit, so it is not parsed unguarded.
    expect(onBack).toContain('val path = wv.url?.let { Uri.parse(it).path }');
    expect(onBack).toMatch(/if \(path != null && path != "\$\{ASSET_PATH\}index\.html"\) \{\s*if \(wv\.canGoBack\(\)\) wv\.goBack\(\) else wv\.loadUrl\(START_URL\)\s*return\s*\}/);
    // Only inside that branch: after the page's own "Back to GizeCat" link the cat page has history.
    expect(onBack.match(/canGoBack\(\)/g)).toHaveLength(1);
    const branch = onBack.indexOf('wv.canGoBack()');
    expect(branch).toBeGreaterThan(onBack.indexOf('if (wv == null || backQuery != 0) {'));
    expect(branch).toBeLessThan(onBack.indexOf('wv.evaluateJavascript('));
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
    expect(activity).toMatch(/override fun onStart\(\) \{\s*super\.onStart\(\)\s*FloatingState\.appStarted = true\s*onReopened\(\)/);
    expect(activity).toMatch(/override fun onNewIntent\(intent: Intent\) \{\s*super\.onNewIntent\(intent\)\s*onReopened\(\)/);
    // A new WebView replaces a static message and never inherits onStop's process-wide pauseTimers().
    expect(activity).toMatch(/wv\.resumeTimers\(\)[\s\S]*?root\.removeAllViews\(\)\s*root\.addView\(wv,/);
  });
});

describe('Android floating cat (1.4.1)', () => {
  it('draws small transparent application-overlay windows (a visual one and a tight touch one): not focusable, not touch-modal, never full screen', () => {
    expect(overlayWindow).toContain('WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY');
    expect(overlayWindow).toContain('WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE');
    expect(overlayWindow).toContain('WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL');
    expect(overlayWindow).toContain('PixelFormat.TRANSLUCENT');
    expect(overlayWindow).toContain('Color.TRANSPARENT');
    // No full-screen or screen-reserving window, and no deprecated overlay type.
    for (const banned of ['FLAG_FULLSCREEN', 'TYPE_SYSTEM_ALERT', 'TYPE_PHONE', 'TYPE_TOAST', 'TYPE_SYSTEM_OVERLAY', 'MATCH_PARENT, WindowManager']) {
      expect(overlayWindow).not.toContain(banned);
    }
    // LEFT, not START: x is measured from the screen's left edge in every locale.
    expect(overlayWindow).toContain('gravity = Gravity.TOP or Gravity.LEFT');
    // 1.4.2: two windows. The VISUAL one (the WebView) is never touchable and, on Android 12+, sits at the
    // opacity that lets touches pass through it; the TOUCH one is an invisible, tight rectangle that
    // exists only while the cat takes touches.
    expect(overlayWindow).toContain('PASS_THROUGH_ALPHA = 0.8f');
    expect(overlayWindow).toMatch(/visualParams = newParams\(\s*WindowManager\.LayoutParams\.FLAG_HARDWARE_ACCELERATED or WindowManager\.LayoutParams\.FLAG_NOT_TOUCHABLE/);
    expect(overlayWindow).toContain('alpha = PASS_THROUGH_ALPHA');
    expect(overlayWindow).toContain('touchParams = newParams(0,');
    expect(overlayWindow).toContain('removeViewImmediate(touchRoot)');
    // The window's size comes from the page and is bounded: the visual window up to a wide, short stage
    // (Living Companion props and laser dot; it never takes a touch), the touch window to its own tight cap.
    expect(overlayWindow).toContain('MAX_STAGE_W_DP = 4096.0');
    expect(overlayWindow).toContain('MAX_STAGE_H_DP = 900.0');
    expect(overlayWindow).toContain('MAX_TOUCH_DP = 600.0');
    expect(overlayWindow).toMatch(/if \(w < 1\.0 \|\| h < 1\.0 \|\| w > MAX_STAGE_W_DP \|\| h > MAX_STAGE_H_DP\) return/);
    expect(overlayWindow).toMatch(/tw > MAX_TOUCH_DP \|\| th > MAX_TOUCH_DP \|\| tw > w \|\| th > h/);
    // The stage never changes the key set of the 'win' message, and the visual window stays untouchable.
    expect(overlayWindow).toContain('setOf("t", "x", "y", "w", "h", "vis", "touch", "tx", "ty", "tw", "th")');
    // Hidden or not drawn: the window leaves the WindowManager, so it cannot obstruct anything.
    expect(overlayWindow).toContain('windowManager.removeViewImmediate(visualRoot)');
    expect(overlayWindow).toContain('touchRoot.filterTouchesWhenObscured = true');
  });

  it('takes raw touches natively and reads no screen content', () => {
    expect(overlayWindow).toContain('override fun onInterceptTouchEvent(ev: MotionEvent): Boolean = true');
    expect(overlayWindow).toContain('ev.getRawX(');
    // 1.4.2: the gesture's own event times travel with every pointer (throw velocity), and a mouse or trackpad pointer over the touch window is forwarded as hover.
    expect(overlayWindow).toContain('ev.eventTime');
    expect(overlayWindow).toContain('override fun onHoverEvent(ev: MotionEvent)');
    for (const banned of ['MediaProjection', 'ImageReader', 'AccessibilityService', 'PixelCopy', 'drawToBitmap', 'getDrawingCache', 'UsageStatsManager', 'ActivityManager']) {
      expect(allKotlin).not.toContain(banned);
    }
  });

  it('the overlay WebView is as locked down as the app one, with its own narrow bridge', () => {
    for (const s of [
      'javaScriptEnabled = true',
      'allowFileAccess = false',
      'allowContentAccess = false',
      'setGeolocationEnabled(false)',
      'javaScriptCanOpenWindowsAutomatically = false',
      'setSupportMultipleWindows(false)',
      'mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW',
    ]) {
      expect(overlayWindow).toContain(s);
    }
    // DevTools is a process-wide switch owned by MainActivity; the overlay never turns it on or overrides it.
    expect(overlayWindow).not.toMatch(/setWebContentsDebuggingEnabled\(/);
    expect(overlayWindow).toMatch(/shouldOverrideUrlLoading[^\n]*= !WebAssets\.isOwn\(request\?\.url\)/);
    expect(overlayWindow).toContain('return WebAssets.notFound()');
    expect(overlayWindow).toMatch(/addWebMessageListener\(\s*wv,\s*BRIDGE_NAME,\s*setOf\(MainActivity\.WEB_ORIGIN\),/);
    expect(literal(overlayWindow, 'BRIDGE_NAME')).toBe('gizecatOverlay');
    expect(overlayWindow).toMatch(/if \(destroyed \|\| !isMainFrame \|\| sourceOrigin\.toString\(\) != MainActivity\.WEB_ORIGIN/);
    expect(overlayWindow).not.toContain('addJavascriptInterface');
    expect(overlayWindow).not.toContain('evaluateJavascript');
    // Page -> native: only hello, win and saved; native -> page: only ptr, cmd and metrics.
    for (const t of ['"hello"', '"win"', '"saved"']) expect(overlayWindow).toContain(`${t} ->`);
    expect(overlayWindow).toContain('setOf("t", "x", "y", "w", "h", "vis", "touch")');
  });

  it('the app-screen bridge accepts a fixed set of operations from the app origin only', () => {
    expect(literal(floatingBridge, 'BRIDGE_NAME')).toBe('gizecatFloating');
    expect(floatingBridge).toContain('setOf("query", "start", "stop", "pause", "resume", "hide", "show", "openOverlaySettings", "settingsChanged")');
    expect(floatingBridge).toMatch(/addWebMessageListener\(\s*view,\s*BRIDGE_NAME,\s*setOf\(MainActivity\.WEB_ORIGIN\),/);
    expect(floatingBridge).toMatch(/if \(!isMainFrame \|\| sourceOrigin\.toString\(\) != MainActivity\.WEB_ORIGIN/);
    expect(floatingBridge).toContain('setOf("t", "op")');
    expect(floatingBridge).not.toContain('evaluateJavascript');
    // A stale button never brings the cat up: commands act only on a running service.
    expect(floatingBridge).toMatch(/private fun command\(action: String\) \{\s*if \(!FloatingState\.running\) return/);
  });

  it('uses the official permission APIs, never opens the permission page by itself, and starts nothing without the permission', () => {
    expect(floatingState).toContain('Settings.canDrawOverlays(context)');
    expect(floatingState).toContain('Settings.ACTION_MANAGE_OVERLAY_PERMISSION');
    expect(floatingState).toContain('Uri.parse("package:${activity.packageName}")');
    // The settings page opens only from the bridge's "openOverlaySettings" operation.
    expect(allKotlin.match(/OverlayAccess\.openSettings\(/g)).toHaveLength(1);
    expect(floatingBridge).toMatch(/"openOverlaySettings" -> \{\s*OverlayAccess\.openSettings\(activity\)/);
    // The service and the bridge both check, and nothing writes the permission setting.
    expect(floatingService).toContain('if (!OverlayAccess.canDraw(this))');
    expect(floatingBridge).toContain('if (!OverlayAccess.canDraw(activity))');
    expect(allKotlin).not.toContain('WRITE_SETTINGS');
    expect(allKotlin).not.toContain('pm grant');
    // The notification permission is asked at most once, and never blocks the cat.
    expect(floatingBridge).toContain('if (!FloatingState.canAskNotifications(activity)) return');
    expect(floatingState).toContain('!notificationsAsked(context)');
  });

  it('runs one foreground service with a declared type, one window at a time, and stops cleanly', () => {
    expect(floatingService).toContain('ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE');
    expect(floatingService).toContain('if (window != null) return');
    expect(floatingService).toContain('startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)');
    // The foreground is entered before anything can fail or wait.
    expect(floatingService).toMatch(/private fun startFloating\(\) \{[^}]*?enterForeground\(\)/);
    // Revoked permission, a lost window and a crashing renderer each stop it with their own reason.
    expect(floatingService).toContain('FloatingState.Stop.PERMISSION_REVOKED');
    expect(floatingService).toContain('FloatingState.Stop.RENDERER_FAILED');
    expect(floatingService).toContain('AppOpsManager.OPSTR_SYSTEM_ALERT_WINDOW');
    // Everything it registered is released, and the cat is saved before the WebView goes.
    expect(floatingService).toContain('unregisterReceiver(it)');
    expect(floatingService).toContain('stopWatchingMode(it)');
    expect(floatingService).toContain('w.requestSave(SAVE_TIMEOUT_MS)');
    expect(floatingService).toContain('stopForeground(STOP_FOREGROUND_REMOVE)');
    // The notification is minimal, silent and private, with the three controls.
    expect(floatingService).toContain('.setVisibility(NotificationCompat.VISIBILITY_SECRET)');
    expect(floatingService).toContain('.setSilent(true)');
    expect(floatingService.match(/\.addAction\(/g)).toHaveLength(3);
  });

  it('does not pause WebView timers while the cat floats, and frees them when it stops with the app away', () => {
    expect(activity).toMatch(/override fun onStop\(\) \{\s*FloatingState\.appStarted = false[\s\S]*?if \(!FloatingState\.running\) webView\?\.pauseTimers\(\)/);
    expect(overlayWindow).toContain('if (!FloatingState.appStarted) wv.pauseTimers()');
  });

  it('keeps the frozen origin and origin checks of the overlay page URL', () => {
    expect(overlayWindow).toContain('"${MainActivity.WEB_ORIGIN}/assets/index.html?surface=overlay"');
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
    // 1.4.1: the Android app has its own version (android/version.properties); package.json stays the
    // desktop and web version, and the code can never fall below what package.json's formula gives.
    expect(gradle).toContain('versionName = androidVersionName');
    expect(gradle).toContain('versionCode = androidVersionCode');
    expect(gradle).toContain('require(it >= appVersionCode)');
    const props = read('android', 'version.properties')
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith('#'));
    expect(props).toEqual(['versionName=1.4.2', 'versionCode=10403']);
    // Above the earlier trial APKs (10400 for 1.4.0, 10401 for 1.4.0-overlay.1), so it installs over them.
    expect(Number(props[1]?.split('=')[1])).toBeGreaterThan(10401);
    const buildWebApp = read('scripts', 'build-web-app.mjs');
    expect(buildWebApp).toContain('GIZECAT_WEB_APP_VERSION: androidVersion');
    expect(read('scripts', 'build.mjs')).toContain('process.env.GIZECAT_WEB_APP_VERSION');
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

  it('collects what the tasks asked for, by Gradle\'s own record, never by file time', () => {
    const script = read('scripts', 'android-gradle.mjs');
    // An UP-TO-DATE run writes nothing, so timestamps would collect nothing and still exit 0.
    expect(script).not.toMatch(/mtime|startedAt/);
    for (const task of ['assembleRelease', 'bundleRelease', 'assembleTrial']) expect(script).toContain(`asked('${task}')`);
    // Options and the value of -x are not tasks, and a dry run builds nothing to collect.
    expect(script).toContain("['-x', '--exclude-task'].includes(gradleArgs[i - 1])");
    expect(script).toContain("gradleArgs.includes('--dry-run')");
    // The release APK's current name, since the other signing state's file can linger beside it.
    expect(script).toContain("path.join(dir, 'output-metadata.json')");
    expect(script).toContain('.elements?.[0]?.outputFile');
    // A requested output that is missing is an error, raised before release/ is touched.
    expect(script).toMatch(/if \(!fs\.existsSync\(file\)\) fail\(/);
    expect(script).toMatch(/const outputs = requestedOutputs\(\);\s*report\(outputs\);\s*if \(!noCollect\) collect\(outputs\);/);
  });

  it('never leaves a signed and an unsigned copy of one kind in the release folder', () => {
    const script = read('scripts', 'android-gradle.mjs');
    // By source output, not extension: the trial is an APK too and must leave the release APK alone.
    expect(script).toContain('replaces: Object.values(apkNames)');
    expect(script).toContain('replaces: [`GizeCat-${version}-android.aab`, `GizeCat-${version}-android-unsigned.aab`]');
    expect(script).toMatch(/name: `GizeCat-\$\{version\}-android-trial-debugsigned\.apk`,\s*replaces: \[\],/);
    // Removed before the copy, and both before the checksums are written.
    const removed = script.indexOf('fs.rmSync(path.join(dest, old)');
    expect(removed).toBeGreaterThan(-1);
    expect(removed).toBeLessThan(script.indexOf('fs.copyFileSync(file, path.join(dest, name))'));
    expect(script.indexOf('fs.copyFileSync(file, path.join(dest, name))')).toBeLessThan(script.indexOf("path.join(dest, 'SHA256SUMS-android.txt')"));
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
