package io.github.gizeverse.gizecat

import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.net.Uri
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
 * - the only native bridge is [FileBridge]: the system file picker for `<input type=file>` and a
 *   save-to-file message, both through the Storage Access Framework (no storage permission).
 */
class MainActivity : Activity() {
    companion object {
        /** WebViewAssetLoader.DEFAULT_DOMAIN, reserved by Android for this purpose. */
        const val WEB_HOST = "appassets.androidplatform.net"

        /** Frozen (src/shared/identity.ts androidWebOrigin): the cat's localStorage is keyed by it. */
        const val WEB_ORIGIN = "https://$WEB_HOST"

        private const val ASSET_PATH = "/assets/"
        const val START_URL = "$WEB_ORIGIN${ASSET_PATH}index.html"

        /** Renderer losses tolerated within [LOSS_WINDOW_MS] before a static message replaces the page. */
        private const val MAX_LOSSES = 3
        private const val LOSS_WINDOW_MS = 60_000L
    }

    private lateinit var root: FrameLayout
    private lateinit var fileBridge: FileBridge
    private var webView: WebView? = null
    private val renderLosses = ArrayDeque<Long>()

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
        attachWebView()
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
        root.addView(wv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView = wv
        wv.loadUrl(START_URL)
    }

    private fun detachWebView(view: WebView) {
        fileBridge.detach(view)
        (view.parent as? ViewGroup)?.removeView(view)
        view.destroy()
        if (webView === view) webView = null
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

        override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
            if (view != null) detachWebView(view)
            val now = SystemClock.elapsedRealtime()
            renderLosses.addLast(now)
            while (renderLosses.isNotEmpty() && now - renderLosses.first() > LOSS_WINDOW_MS) renderLosses.removeFirst()
            if (renderLosses.size >= MAX_LOSSES) {
                showMessage(R.string.renderer_failed)
            } else {
                // The page reloads the cat from localStorage.
                root.post { if (!isDestroyed && webView == null) attachWebView() }
            }
            return true
        }
    }

    override fun onStart() {
        super.onStart()
        webView?.resumeTimers()
    }

    override fun onResume() {
        super.onResume()
        webView?.onResume()
    }

    /** The page sees visibilityState "hidden", saves the cat synchronously and naps. */
    override fun onPause() {
        webView?.onPause()
        super.onPause()
    }

    override fun onStop() {
        webView?.pauseTimers()
        super.onStop()
    }

    override fun onDestroy() {
        webView?.let { detachWebView(it) }
        super.onDestroy()
    }

    @Deprecated("Android 13+ delivers back through OnBackInvokedCallback; the system then moves this root task to the background itself.")
    override fun onBackPressed() {
        // Android 10-12: keep the cat alive in the background instead of finishing the Activity,
        // as Android 12+ does for launcher roots by default.
        moveTaskToBack(true)
    }

    /** The framework result API (the app has no androidx.activity dependency); only [FileBridge] starts activities. */
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (!fileBridge.onActivityResult(requestCode, resultCode, data)) {
            @Suppress("DEPRECATION")
            super.onActivityResult(requestCode, resultCode, data)
        }
    }
}
