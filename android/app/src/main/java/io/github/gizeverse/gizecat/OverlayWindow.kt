package io.github.gizeverse.gizecat

import android.content.Context
import android.content.res.Resources
import android.graphics.Color
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.DisplayMetrics
import android.view.ContextThemeWrapper
import android.view.Choreographer
import android.view.Display
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONException
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.roundToInt

/** The app's own offline pages, served from the reserved WebViewAssetLoader origin (the same rules as [MainActivity]). */
internal object WebAssets {
    private const val ASSET_PATH = "/assets/"

    fun loader(context: Context): WebViewAssetLoader =
        WebViewAssetLoader.Builder()
            .setDomain(MainActivity.WEB_HOST)
            .setHttpAllowed(false)
            .addPathHandler(ASSET_PATH, WebViewAssetLoader.AssetsPathHandler(context))
            .build()

    fun isOwn(url: Uri?): Boolean =
        url != null && url.scheme == "https" && url.host == MainActivity.WEB_HOST && url.path?.startsWith(ASSET_PATH) == true

    fun notFound(): WebResourceResponse =
        WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
}

/** The physical screen in dp, with the system bars and the display cutout (the page's `ScreenMetrics`). */
internal data class ScreenMetrics(
    val widthDp: Float,
    val heightDp: Float,
    val density: Float,
    val topDp: Float,
    val rightDp: Float,
    val bottomDp: Float,
    val leftDp: Float,
) {
    fun toJson(): JSONObject =
        JSONObject()
            .put("width", widthDp.toDouble())
            .put("height", heightDp.toDouble())
            .put("density", density.toDouble())
            .put("insets", JSONObject().put("top", topDp.toDouble()).put("right", rightDp.toDouble()).put("bottom", bottomDp.toDouble()).put("left", leftDp.toDouble()))

    /** The query the overlay page reads before its first frame (floatingProtocol.ts parseMetricsQuery). */
    fun toQuery(): String =
        // Density with six decimals: native positions windows with the exact float, so the page must agree to the pixel.
        String.format(Locale.ROOT, "w=%.3f&h=%.3f&d=%.6f&it=%.3f&ir=%.3f&ib=%.3f&il=%.3f", widthDp, heightDp, density, topDp, rightDp, bottomDp, leftDp)
}

/**
 * The floating cat's window: one small, transparent TYPE_APPLICATION_OVERLAY window that holds a
 * WebView running the same web bundle as the app (`index.html?surface=overlay`). The window is only
 * as large as the cat and the room the renderer draws into (see src/web/overlaySurface.ts); the page
 * tells this class where it goes ("win" messages) and this class moves it with WindowManager, at
 * most once per frame. No reserved screen area, no full-screen window, nothing opaque.
 *
 * Touch: the window consumes every touch that lands in it (it is the cat and a small margin), reads
 * it in raw screen coordinates (a window that moves under the finger would shift window-relative
 * ones) and sends it to the page, which decides what the cat does. Touches outside the window never
 * reach it: they belong to the app underneath (FLAG_NOT_TOUCH_MODAL). Touches that land inside it
 * but not on the cat are consumed, not passed on: Android offers no input region for an app's
 * window (docs/platforms/android-overlay.md, "Touch pass-through"). While the cat is hidden, or not
 * drawn, the window is removed from the WindowManager entirely, so it cannot obstruct anything.
 *
 * Main thread only. [destroy] is final.
 */
internal class OverlayWindow(private val context: Context, private val callbacks: Callbacks) {
    interface Callbacks {
        /** The page said hello: native state (paused, hidden, screen off) should be sent now. */
        fun onPageReady()

        /** The WebView's renderer process died (didCrash) or was reclaimed. The window recreates the WebView only if told to. */
        fun onRendererLost(didCrash: Boolean)

        /** The window could not be added (permission gone, no WebView provider, display lost). */
        fun onFailure(permissionRevoked: Boolean)
    }

    companion object {
        private const val BRIDGE_NAME = "gizecatOverlay"
        private const val MAX_MESSAGE_CHARS = 2048
        /** The cat's window at the largest cat size (2.5) is 430 x 490 dp; anything much larger is refused, so a page can never ask for a screen-sized window. */
        private const val MAX_WINDOW_DP = 600.0

        /** At most this opaque while the window lets touches through: Android 12+ passes them on only at 0.8 or less (the maximum obscuring opacity for touches). */
        private const val PASS_THROUGH_ALPHA = 0.8f
        private const val SURFACE_URL = "${MainActivity.WEB_ORIGIN}/assets/index.html?surface=overlay"
    }

    private val appContext: Context = context.applicationContext
    private val windowManager: WindowManager = appContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private val displayManager: DisplayManager = appContext.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
    private val handler = Handler(Looper.getMainLooper())
    private val assetLoader: WebViewAssetLoader by lazy { WebAssets.loader(appContext) }

    private val root = OverlayRoot(ContextThemeWrapper(appContext, R.style.Theme_GizeCat))
    private var webView: WebView? = null
    private var reply: JavaScriptReplyProxy? = null
    private var attached = false
    private var destroyed = false

    /** The window the page last asked for (screen dp), applied on the next frame. */
    private var wanted: Wanted? = null
    private var frameScheduled = false
    private var density = 1f
    private var lastMetrics: ScreenMetrics? = null
    private var saveDone: (() -> Unit)? = null

    private class Wanted(val x: Double, val y: Double, val w: Double, val h: Double, val visible: Boolean, val touch: Boolean)

    private val layoutParams = WindowManager.LayoutParams(
        1,
        1,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        // Not focusable (never takes the keyboard from the app underneath), not touch-modal (touches
        // outside the window go to the app below), laid out in physical screen coordinates so that
        // x and y are the page's world coordinates (raw touch positions), allowed to hang over an edge.
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
        PixelFormat.TRANSLUCENT,
    ).apply {
        // LEFT, not START: x is the page's world coordinate from the screen's left edge in every locale
        // (START would measure from the right edge in a right-to-left language).
        gravity = Gravity.TOP or Gravity.LEFT
        title = "GizeCat floating cat"
        layoutInDisplayCutoutMode =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            } else {
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
    }

    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) = Unit

        override fun onDisplayRemoved(displayId: Int) = Unit

        override fun onDisplayChanged(displayId: Int) {
            if (displayId == Display.DEFAULT_DISPLAY) pushMetrics()
        }
    }

    init {
        root.setBackgroundColor(Color.TRANSPARENT)
        // Obscured-touch protection: another app's overlay on top of the cat means these touches are not delivered.
        root.filterTouchesWhenObscured = true
        // A picture of a cat with nothing to read: the controls are in the notification and the app.
        root.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        root.sink = { kind, id, x, y -> sendPointer(kind, id, x, y) }
    }

    /** Creates the WebView and starts loading the page. The window itself appears when the page first asks for it. */
    fun start(): Boolean {
        displayManager.registerDisplayListener(displayListener, handler)
        return createWebView()
    }

    private fun createWebView(): Boolean {
        val metrics = readMetrics()
        lastMetrics = metrics
        density = metrics.density
        val wv = try {
            // (DevTools is a process-wide switch owned by MainActivity: release and trial builds are never debuggable.)
            WebView(ContextThemeWrapper(appContext, R.style.Theme_GizeCat))
        } catch (e: RuntimeException) {
            // No (or a disabled) Android System WebView provider.
            return false
        }
        wv.setBackgroundColor(Color.TRANSPARENT)
        wv.isVerticalScrollBarEnabled = false
        wv.isHorizontalScrollBarEnabled = false
        wv.overScrollMode = View.OVER_SCROLL_NEVER
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
            // Cat sounds (off by default) have no user gesture in this window: touches are native.
            mediaPlaybackRequiresUserGesture = false
        }
        wv.webViewClient = OverlayClient()
        // No file chooser, no permission or geolocation prompts: the plain WebChromeClient denies all.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(
                wv,
                BRIDGE_NAME,
                setOf(MainActivity.WEB_ORIGIN),
                WebViewCompat.WebMessageListener { view, message, sourceOrigin, isMainFrame, replyProxy ->
                    onPageMessage(view, message, sourceOrigin, isMainFrame, replyProxy)
                },
            )
        } else {
            wv.destroy()
            return false
        }
        wv.resumeTimers()
        root.addView(wv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView = wv
        reply = null
        wv.loadUrl("$SURFACE_URL&${metrics.toQuery()}")
        return true
    }

    /** After a lost renderer: a fresh WebView and page. The cat is reloaded from storage (it saves every 30 s and on hide). */
    fun recreateWebView(): Boolean {
        if (destroyed) return false
        removeFromWindow()
        webView?.let { dropWebView(it) }
        return createWebView()
    }

    private fun dropWebView(wv: WebView) {
        root.removeView(wv)
        wv.destroy()
        if (webView === wv) webView = null
        reply = null
    }

    // ---- messages from the page

    private fun onPageMessage(view: WebView, message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, replyProxy: JavaScriptReplyProxy) {
        // addWebMessageListener already restricts the origin; checked again so a future rule change cannot widen it.
        if (destroyed || !isMainFrame || sourceOrigin.toString() != MainActivity.WEB_ORIGIN || view !== webView) return
        if (message.type != WebMessageCompat.TYPE_STRING) return
        val data = message.data ?: return
        if (data.length > MAX_MESSAGE_CHARS) return
        val json = try {
            JSONObject(data)
        } catch (e: JSONException) {
            return
        }
        when (json.opt("t")) {
            "hello" -> {
                reply = replyProxy
                callbacks.onPageReady()
            }
            "win" -> onWindowMessage(json)
            "saved" -> finishSave()
        }
    }

    private fun onWindowMessage(json: JSONObject) {
        val keys = json.keys().asSequence().toSet()
        if (keys != setOf("t", "x", "y", "w", "h", "vis", "touch")) return
        val x = (json.opt("x") as? Number)?.toDouble() ?: return
        val y = (json.opt("y") as? Number)?.toDouble() ?: return
        val w = (json.opt("w") as? Number)?.toDouble() ?: return
        val h = (json.opt("h") as? Number)?.toDouble() ?: return
        val vis = json.opt("vis") as? Boolean ?: return
        val touch = json.opt("touch") as? Boolean ?: return
        if (!x.isFinite() || !y.isFinite() || !w.isFinite() || !h.isFinite()) return
        if (w < 1.0 || h < 1.0 || w > MAX_WINDOW_DP || h > MAX_WINDOW_DP) return
        if (Math.abs(x) > 100_000.0 || Math.abs(y) > 100_000.0) return
        wanted = Wanted(x, y, w, h, vis, touch)
        scheduleFrame()
    }

    // ---- placing the window, at most once per frame

    private fun scheduleFrame() {
        if (frameScheduled || destroyed) return
        frameScheduled = true
        Choreographer.getInstance().postFrameCallback {
            frameScheduled = false
            applyWanted()
        }
    }

    private fun applyWanted() {
        val w = wanted ?: return
        if (destroyed) return
        if (!w.visible) {
            removeFromWindow()
            return
        }
        val d = density
        layoutParams.x = (w.x * d).roundToInt()
        layoutParams.y = (w.y * d).roundToInt()
        layoutParams.width = ceil(w.w * d - 1e-6).toInt().coerceAtLeast(1)
        layoutParams.height = ceil(w.h * d - 1e-6).toInt().coerceAtLeast(1)
        // The cat takes no touches (paused, interactions off): let them through to the app underneath.
        // Android 12+ passes touches through another app's window only at <= 0.8 opacity, so the
        // window is drawn at that opacity while it is click-through (a slightly dimmer cat).
        if (w.touch) {
            layoutParams.flags = layoutParams.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
            layoutParams.alpha = 1f
        } else {
            layoutParams.flags = layoutParams.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
            layoutParams.alpha = PASS_THROUGH_ALPHA
        }
        try {
            if (attached) {
                windowManager.updateViewLayout(root, layoutParams)
            } else {
                windowManager.addView(root, layoutParams)
                attached = true
            }
        } catch (e: WindowManager.BadTokenException) {
            attached = false
            callbacks.onFailure(true)
        } catch (e: SecurityException) {
            attached = false
            callbacks.onFailure(true)
        } catch (e: IllegalStateException) {
            // Already added by an earlier call that failed half-way: treat as attached and move on.
            attached = true
        } catch (e: IllegalArgumentException) {
            // updateViewLayout on a view the system already removed (permission revoked, display gone).
            attached = false
            callbacks.onFailure(!OverlayAccess.canDraw(appContext))
        } catch (e: RuntimeException) {
            // WindowManager.InvalidDisplayException and any other refusal to add the window.
            attached = false
            callbacks.onFailure(!OverlayAccess.canDraw(appContext))
        }
    }

    private fun removeFromWindow() {
        if (!attached) return
        attached = false
        try {
            windowManager.removeViewImmediate(root)
        } catch (e: IllegalArgumentException) {
            // Already gone.
        }
    }

    // ---- touch, to the page

    private fun sendPointer(kind: String, id: Int, rawX: Float, rawY: Float) {
        val proxy = reply ?: return
        val d = density
        val text = String.format(Locale.ROOT, "{\"t\":\"ptr\",\"k\":\"%s\",\"id\":%d,\"x\":%.2f,\"y\":%.2f}", kind, id, rawX / d, rawY / d)
        try {
            proxy.postMessage(text)
        } catch (e: RuntimeException) {
            // The page is being replaced.
        }
    }

    // ---- commands and metrics, to the page

    /** One of the page's OverlayCommand names (floatingProtocol.ts). A fixed set: never page or user data. */
    fun sendCommand(command: String) {
        val proxy = reply ?: return
        if (command !in COMMANDS) return
        try {
            proxy.postMessage("{\"t\":\"cmd\",\"c\":\"$command\"}")
        } catch (e: RuntimeException) {
            // The page is being replaced.
        }
    }

    private val COMMANDS = setOf("pause", "resume", "hide", "show", "suspend", "wake", "save", "reloadSettings")

    private fun pushMetrics() {
        if (destroyed) return
        val metrics = readMetrics()
        if (metrics == lastMetrics) return
        lastMetrics = metrics
        density = metrics.density
        val proxy = reply ?: return
        try {
            proxy.postMessage(JSONObject().put("t", "metrics").put("metrics", metrics.toJson()).toString())
        } catch (e: RuntimeException) {
            // The page is being replaced; it reads fresh metrics from its URL.
        }
    }

    /** The configuration changed (rotation, split screen, a folding display): push fresh metrics. */
    fun onConfigurationChanged() = pushMetrics()

    /**
     * Asks the page to write the cat to storage now and calls [done] when it said so, or after
     * [timeoutMs] (a page that is gone or stuck must not hold the service). [done] runs exactly once.
     */
    fun requestSave(timeoutMs: Long, done: () -> Unit) {
        if (destroyed || reply == null || saveDone != null) {
            done()
            return
        }
        saveDone = done
        sendCommand("save")
        handler.postDelayed({ finishSave() }, timeoutMs)
    }

    private fun finishSave() {
        val done = saveDone ?: return
        saveDone = null
        done()
    }

    /** Removes the window, frees the WebView and every callback. The cat must have been saved first ([requestSave]). */
    fun destroy() {
        if (destroyed) return
        destroyed = true
        handler.removeCallbacksAndMessages(null)
        saveDone = null
        try {
            displayManager.unregisterDisplayListener(displayListener)
        } catch (e: RuntimeException) {
            // Not registered.
        }
        removeFromWindow()
        webView?.let { wv ->
            // pauseTimers is process-wide: with the app out of sight nothing else needs the timers.
            if (!FloatingState.appStarted) wv.pauseTimers()
            dropWebView(wv)
        }
    }

    // ---- screen metrics

    private fun readMetrics(): ScreenMetrics {
        val density = appContext.resources.displayMetrics.density.coerceAtLeast(0.5f)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val metrics = windowManager.currentWindowMetrics
            val bounds = metrics.bounds
            val insets = metrics.windowInsets.getInsetsIgnoringVisibility(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            return ScreenMetrics(
                bounds.width() / density,
                bounds.height() / density,
                density,
                insets.top / density,
                insets.right / density,
                insets.bottom / density,
                insets.left / density,
            )
        }
        // Android 10 (API 29): the real display size, and the bars from their resource dimensions.
        val dm = DisplayMetrics()
        val display = displayManager.getDisplay(Display.DEFAULT_DISPLAY)
        @Suppress("DEPRECATION")
        display?.getRealMetrics(dm)
        val widthPx = if (dm.widthPixels > 0) dm.widthPixels else appContext.resources.displayMetrics.widthPixels
        val heightPx = if (dm.heightPixels > 0) dm.heightPixels else appContext.resources.displayMetrics.heightPixels
        val top = systemDimen("status_bar_height")
        val bottom = systemDimen("navigation_bar_height")
        return ScreenMetrics(widthPx / density, heightPx / density, density, top / density, 0f, bottom / density, 0f)
    }

    private fun systemDimen(name: String): Int {
        val id = Resources.getSystem().getIdentifier(name, "dimen", "android")
        return if (id > 0) Resources.getSystem().getDimensionPixelSize(id) else 0
    }

    // ---- the WebView's client

    private inner class OverlayClient : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse {
            val url = request?.url
            if (url != null && WebAssets.isOwn(url)) assetLoader.shouldInterceptRequest(url)?.let { return it }
            return WebAssets.notFound()
        }

        /** Navigation never leaves our own pages, and no link ever opens another app. */
        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = !WebAssets.isOwn(request?.url)

        override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
            if (view != null && view === webView) {
                removeFromWindow()
                dropWebView(view)
            }
            callbacks.onRendererLost(detail?.didCrash() == true)
            return true
        }
    }

    /** The window's content: takes every touch in the window and hands it to [sink] in raw screen coordinates. */
    private class OverlayRoot(context: Context) : FrameLayout(context) {
        var sink: (kind: String, id: Int, rawX: Float, rawY: Float) -> Unit = { _, _, _, _ -> }
        private var active = -1

        override fun onInterceptTouchEvent(ev: MotionEvent): Boolean = true

        override fun onTouchEvent(ev: MotionEvent): Boolean {
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    active = ev.getPointerId(0)
                    sink("down", active, ev.getRawX(0), ev.getRawY(0))
                }
                MotionEvent.ACTION_MOVE -> {
                    val i = ev.findPointerIndex(active)
                    if (i >= 0) sink("move", active, ev.getRawX(i), ev.getRawY(i))
                }
                MotionEvent.ACTION_POINTER_UP -> {
                    // The finger the cat follows lifted while another stays: that is the release.
                    if (ev.getPointerId(ev.actionIndex) == active) {
                        sink("up", active, ev.getRawX(ev.actionIndex), ev.getRawY(ev.actionIndex))
                        active = -1
                    }
                }
                MotionEvent.ACTION_UP -> {
                    if (active >= 0) {
                        val i = ev.findPointerIndex(active).takeIf { it >= 0 } ?: 0
                        sink("up", active, ev.getRawX(i), ev.getRawY(i))
                    }
                    active = -1
                }
                MotionEvent.ACTION_CANCEL -> {
                    if (active >= 0) {
                        val i = ev.findPointerIndex(active).takeIf { it >= 0 } ?: 0
                        sink("cancel", active, ev.getRawX(i), ev.getRawY(i))
                    }
                    active = -1
                }
            }
            return true
        }
    }
}
