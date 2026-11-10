package io.github.gizeverse.gizecat

import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import android.window.OnBackInvokedDispatcher
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream

/**
 * GizeCat on Android: one Activity hosting one WebView that serves the production web bundle
 * (copied into the APK's assets by scripts/build-web-app.mjs) from the reserved
 * WebViewAssetLoader origin. The page is the same web host as the browser version; this class only
 * gives it a safe, offline home:
 * - every request outside our own /assets/ path gets an empty 404 (and the app has no INTERNET
 *   permission, so the OS forbids network access anyway);
 * - no file:// or content:// loading, no geolocation, no new windows, no zoom, no DevTools in
 *   release or trial builds, no addJavascriptInterface;
 * - the page's native bridges are two narrow web message listeners: [FileBridge] (the system file
 *   picker for `<input type=file>` and a save-to-file message, both through the Storage Access
 *   Framework, no storage permission) and [FloatingBridge] (start, stop, pause and hide the floating
 *   cat, preview 2). The floating cat's own window has a third, `gizecatOverlay`, in [OverlayWindow];
 * - Back runs one fixed script, [CLOSE_TOP_DIALOG_JS], that closes the page's open `<dialog>` (the
 *   settings sheet), and the notification's "open settings" runs one more fixed script,
 *   [OPEN_SETTINGS_JS]; no page data is ever put into a script. On any other page of ours (the
 *   notices) Back returns to the cat and runs no script.
 */
class MainActivity : Activity() {
    companion object {
        /** WebViewAssetLoader.DEFAULT_DOMAIN, reserved by Android for this purpose. */
        const val WEB_HOST = "appassets.androidplatform.net"

        /** Frozen (src/shared/identity.ts androidWebOrigin): the cat's localStorage is keyed by it. */
        const val WEB_ORIGIN = "https://$WEB_HOST"

        private const val ASSET_PATH = "/assets/"
        const val START_URL = "$WEB_ORIGIN${ASSET_PATH}index.html"

        /**
         * Renderer crashes tolerated within [LOSS_WINDOW_MS] before a static message replaces the
         * page. System kills (memory reclaimed) never count, and reopening the app clears the count.
         */
        private const val MAX_LOSSES = 3
        private const val LOSS_WINDOW_MS = 60_000L

        /** The floating cat's notification opens the app on its settings: an Intent extra, never data from the page. */
        const val EXTRA_OPEN_SETTINGS = "io.github.gizeverse.gizecat.OPEN_SETTINGS"

        /** Opens the settings sheet by pressing its own button. A fixed constant: no data is ever interpolated into it. */
        const val OPEN_SETTINGS_JS = "(function(){var b=document.getElementById('btn-settings');if(b)b.click();})()"

        /**
         * Back, asked of the page first: closes the topmost open `<dialog>` (the app has one, the
         * settings sheet, which also holds the profile-import preview) and answers whether it did.
         * close() fires the dialog's `close` event, which settingsPanel.ts already handles the way it
         * handles Escape; without HTMLDialogElement the event is sent by hand. A fixed constant: no
         * page or native data is ever interpolated into it.
         */
        const val CLOSE_TOP_DIALOG_JS =
            "(function(){var o=document.querySelectorAll('dialog[open]');if(o.length===0)return false;" +
                "var d=o[o.length-1];if(typeof d.close==='function')d.close();" +
                "else{d.removeAttribute('open');d.dispatchEvent(new Event('close'));}return true;})()"
    }

    private lateinit var root: FrameLayout
    private lateinit var fileBridge: FileBridge
    private lateinit var floatingBridge: FloatingBridge
    private var webView: WebView? = null

    /** The notification asked for the settings sheet; it opens once the cat's page has loaded. */
    private var openSettingsPending = false
    private var pageReady = false

    /** Elapsed-realtime stamps of renderer crashes (not system kills) within [LOSS_WINDOW_MS]. */
    private val renderCrashes = ArrayDeque<Long>()

    /** A WebView must be (re)created on the next onResume: lost while away, or the app reopened. */
    private var reattachPending = false
    private var resumed = false

    /** The id of the Back query waiting for the page's answer, or 0 when none is. */
    private var backQuery = 0
    private var backQueries = 0

    private val assetLoader: WebViewAssetLoader by lazy {
        WebViewAssetLoader.Builder()
            .setDomain(WEB_HOST)
            .setHttpAllowed(false)
            .addPathHandler(ASSET_PATH, WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Edge-to-edge (enforced at targetSdk 35+): the system bars show the page background and the
        // WebView is padded to the safe area, so the cat's floor sits above the navigation bar.
        WindowCompat.enableEdgeToEdge(window)
        root = FrameLayout(this).apply { setBackgroundColor(getColor(R.color.gizecat_bg)) }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        WindowCompat.getInsetsController(window, root).apply {
            isAppearanceLightStatusBars = !night
            isAppearanceLightNavigationBars = !night
        }
        fileBridge = FileBridge(this)
        floatingBridge = FloatingBridge(this)
        // Only for a fresh launch from the notification: a recreation (night mode, language, font size)
        // or a restore would re-deliver the same Intent and open the sheet again.
        openSettingsPending = savedInstanceState == null && intent?.getBooleanExtra(EXTRA_OPEN_SETTINGS, false) == true
        intent?.removeExtra(EXTRA_OPEN_SETTINGS)
        attachWebView()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // Android 13+ (the manifest opts in to predictive back): Back arrives here, never in
            // onBackPressed. Registered for the Activity's lifetime, so the page is always asked
            // first; the price is that the system's back-to-home animation is not previewed.
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { onBack() }
        }
    }

    private fun isDebuggable(): Boolean = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    private fun attachWebView() {
        val wv = try {
            // DevTools only in debuggable (developer) builds; release and trial builds are not debuggable.
            WebView.setWebContentsDebuggingEnabled(isDebuggable())
            WebView(this)
        } catch (e: RuntimeException) {
            // No (or a disabled) Android System WebView provider.
            showMessage(R.string.webview_unavailable)
            return
        }
        wv.setBackgroundColor(getColor(R.color.gizecat_bg))
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            mediaPlaybackRequiresUserGesture = true
        }
        wv.webViewClient = HostClient()
        wv.webChromeClient = fileBridge.chromeClient
        // Before loadUrl, so the page's first load already has the bridge object.
        fileBridge.attach(wv)
        floatingBridge.attach(wv)
        pageReady = false
        // pauseTimers() in onStop is process-wide and outlives the WebView it was called on, so a
        // WebView created after a loss would otherwise start with its JavaScript timers paused.
        // attachWebView only runs from onCreate or while the Activity is resumed.
        wv.resumeTimers()
        // A static message (renderer_failed, webview_unavailable) may be showing.
        root.removeAllViews()
        root.addView(wv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView = wv
        wv.loadUrl(START_URL)
    }

    private fun detachWebView(view: WebView) {
        fileBridge.detach(view)
        floatingBridge.detach(view)
        (view.parent as? ViewGroup)?.removeView(view)
        view.destroy()
        if (webView === view) {
            webView = null
            // A destroyed WebView never answers a pending Back query.
            backQuery = 0
        }
    }

    /** Creates the WebView when one is pending and the Activity is in front; otherwise waits for onResume. */
    private fun reattachIfPending() {
        if (!reattachPending || !resumed || isDestroyed || webView != null) return
        reattachPending = false
        // The page reloads the cat from localStorage.
        attachWebView()
    }

    /** The user reopened the app: forget earlier crashes and retry a page that is not there. */
    private fun onReopened() {
        renderCrashes.clear()
        if (webView == null) reattachPending = true
    }

    private fun showMessage(textRes: Int) {
        root.removeAllViews()
        val pad = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 24f, resources.displayMetrics).toInt()
        val text = TextView(this).apply {
            setText(textRes)
            gravity = Gravity.CENTER
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            setTextColor(getColor(R.color.gizecat_fg))
            setPadding(pad, pad, pad, pad)
        }
        root.addView(text, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    private fun isOwn(url: Uri?): Boolean =
        url != null && url.scheme == "https" && url.host == WEB_HOST && url.path?.startsWith(ASSET_PATH) == true

    private fun notFound(): WebResourceResponse =
        WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    private inner class HostClient : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse {
            val url = request?.url
            if (url != null && isOwn(url)) assetLoader.shouldInterceptRequest(url)?.let { return it }
            return notFound()
        }

        /** Navigation never leaves our own pages, and no link ever opens another app. */
        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = !isOwn(request?.url)

        override fun onPageFinished(view: WebView?, url: String?) {
            if (view !== webView) return
            val path = url?.let { Uri.parse(it).path }
            if (path != "${ASSET_PATH}index.html") return
            pageReady = true
            openSettingsIfReady()
        }

        /**
         * Only a crash (detail.didCrash(), API 26+) counts toward [MAX_LOSSES]. A renderer the system
         * killed to reclaim memory, usually while the app is in the background, is not the page's
         * fault and is simply replaced. Either way a new WebView is created at once only while the
         * Activity is resumed, otherwise on the next onResume, so a backgrounded app does not start
         * a renderer the system would kill again.
         */
        override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
            if (view != null) detachWebView(view)
            if (detail?.didCrash() == true) {
                val now = SystemClock.elapsedRealtime()
                renderCrashes.addLast(now)
                while (renderCrashes.isNotEmpty() && now - renderCrashes.first() > LOSS_WINDOW_MS) renderCrashes.removeFirst()
                if (renderCrashes.size >= MAX_LOSSES) {
                    // Until the user reopens the app (onReopened).
                    reattachPending = false
                    showMessage(R.string.renderer_failed)
                    return true
                }
            }
            reattachPending = true
            if (resumed) root.post { reattachIfPending() }
            return true
        }
    }

    override fun onStart() {
        super.onStart()
        FloatingState.appStarted = true
        onReopened()
        webView?.resumeTimers()
    }

    /** singleTask: the launcher icon brings this instance back; onResume always follows. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        onReopened()
        setIntent(intent)
        if (intent.getBooleanExtra(EXTRA_OPEN_SETTINGS, false)) {
            intent.removeExtra(EXTRA_OPEN_SETTINGS)
            openSettingsPending = true
            openSettingsIfReady()
        }
    }

    /** Presses the page's own Settings button once, when the notification asked for it and the page is up. */
    private fun openSettingsIfReady() {
        val wv = webView ?: return
        if (!openSettingsPending || !pageReady) return
        openSettingsPending = false
        wv.evaluateJavascript(OPEN_SETTINGS_JS, null)
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        reattachIfPending()
        webView?.onResume()
        // The overlay permission or the notification setting may have changed while the app was away.
        floatingBridge.onResume()
    }

    /** The Android 13+ notification dialog closed: the page re-reads whether notifications can be shown. */
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == FloatingBridge.REQUEST_NOTIFICATIONS) {
            floatingBridge.pushState()
            FloatingState.refresh()
        }
    }

    /** The page sees visibilityState "hidden", saves the cat synchronously and naps. */
    override fun onPause() {
        resumed = false
        webView?.onPause()
        super.onPause()
    }

    override fun onStop() {
        FloatingState.appStarted = false
        // pauseTimers() is process-wide: while the cat floats over other apps it would freeze the
        // floating window's JavaScript too. The service pauses them itself when it stops (OverlayWindow.destroy).
        if (!FloatingState.running) webView?.pauseTimers()
        super.onStop()
    }

    override fun onDestroy() {
        webView?.let { detachWebView(it) }
        super.onDestroy()
    }

    @Deprecated("Android 13+ delivers back through the OnBackInvokedCallback registered in onCreate.")
    override fun onBackPressed() {
        // Android 10-12. The WebView never passes the back key to the page, so it is asked here.
        onBack()
    }

    /**
     * On a page other than the cat's (the notices, which unloaded the cat page by navigating) Back
     * returns to the cat, through the history or, when there is none, the start page. On the cat's
     * page it closes the open dialog (the settings sheet) when there is one. Otherwise the cat stays
     * alive in the background instead of the Activity finishing, as Android 12+ does for launcher
     * roots by default. A second Back before the page has answered (a busy page) leaves at once.
     *
     * The history is never consulted on the cat's page: after a notices page's own "Back to
     * GizeCat" link it still holds that page, so Back would reopen the notices instead of leaving.
     */
    private fun onBack() {
        val wv = webView
        if (wv == null || backQuery != 0) {
            backQuery = 0
            moveTaskToBack(true)
            return
        }
        // Null before the first page commits, which counts as the cat's page.
        val path = wv.url?.let { Uri.parse(it).path }
        if (path != null && path != "${ASSET_PATH}index.html") {
            if (wv.canGoBack()) wv.goBack() else wv.loadUrl(START_URL)
            return
        }
        val id = ++backQueries
        backQuery = id
        wv.evaluateJavascript(CLOSE_TOP_DIALOG_JS) { result ->
            if (backQuery != id) return@evaluateJavascript
            backQuery = 0
            if (result != "true") moveTaskToBack(true)
        }
    }

    /** The framework result API (the app has no androidx.activity dependency); only [FileBridge] starts activities. */
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (!fileBridge.onActivityResult(requestCode, resultCode, data)) {
            @Suppress("DEPRECATION")
            super.onActivityResult(requestCode, resultCode, data)
        }
    }
}
