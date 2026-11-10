package io.github.gizeverse.gizecat

import android.Manifest
import android.app.Activity
import android.net.Uri
import android.os.Build
import android.webkit.WebView
import androidx.core.content.ContextCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONException
import org.json.JSONObject

/**
 * The app screen's side of the floating cat (1.4.0 preview 2; the page's `window.gizecatFloating`).
 * The app's own WebView posts one JSON operation at a time; this class turns it into a service
 * command, and pushes the floating cat's state back (the answer to `query`, then every change, and
 * whenever the app returns to the foreground: the overlay permission may have changed in Android's
 * settings meanwhile).
 *
 * Narrow by design, like [FileBridge]: the object exists only in main frames of the app's own
 * origin; the operation names are a fixed set (anything else, any extra key, any other type or size
 * is refused); no operation carries data from the page. It never opens Android's permission page by
 * itself: only the user's tap on "Open Android settings" does ("openOverlaySettings").
 */
internal class FloatingBridge(private val activity: Activity) {
    companion object {
        private const val BRIDGE_NAME = "gizecatFloating"
        private const val MAX_MESSAGE_CHARS = 2048
        private val OPS = setOf("query", "start", "stop", "pause", "resume", "hide", "show", "openOverlaySettings", "settingsChanged")
        const val REQUEST_NOTIFICATIONS = 0x6A10
    }

    private var currentView: WebView? = null
    private var reply: JavaScriptReplyProxy? = null
    private val stateListener: () -> Unit = { pushState() }

    /** Adds `gizecatFloating` to [view], for the app's own origin only. Call before loadUrl. */
    fun attach(view: WebView) {
        currentView = view
        reply = null
        FloatingState.addListener(stateListener)
        // A WebView too old for the listener has no bridge; the page then shows no floating controls.
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        WebViewCompat.addWebMessageListener(
            view,
            BRIDGE_NAME,
            setOf(MainActivity.WEB_ORIGIN),
            WebViewCompat.WebMessageListener { source, message, sourceOrigin, isMainFrame, replyProxy ->
                onMessage(source, message, sourceOrigin, isMainFrame, replyProxy)
            },
        )
    }

    fun detach(view: WebView) {
        if (currentView === view) {
            currentView = null
            reply = null
            FloatingState.removeListener(stateListener)
        }
    }

    /** The app came back to the front (or a permission dialog closed): the page re-reads the state. */
    fun onResume() = pushState()

    fun pushState() {
        val proxy = reply ?: return
        if (activity.isDestroyed) return
        try {
            proxy.postMessage(FloatingState.toJson(activity))
        } catch (e: RuntimeException) {
            // The page is being replaced; it asks again with `query`.
        }
    }

    private fun onMessage(view: WebView, message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, replyProxy: JavaScriptReplyProxy) {
        // addWebMessageListener already restricts the origin; checked again so a future rule change cannot widen it.
        if (!isMainFrame || sourceOrigin.toString() != MainActivity.WEB_ORIGIN || view !== currentView) return
        if (message.type != WebMessageCompat.TYPE_STRING) return
        val data = message.data ?: return
        if (data.length > MAX_MESSAGE_CHARS) return
        val json = try {
            JSONObject(data)
        } catch (e: JSONException) {
            return
        }
        if (json.keys().asSequence().toSet() != setOf("t", "op") || json.opt("t") != "op") return
        val op = json.opt("op") as? String ?: return
        if (op !in OPS) return
        // The newest page replaces an older reply proxy (a reload).
        reply = replyProxy
        when (op) {
            "query" -> pushState()
            "start" -> start()
            "stop" -> command(FloatingCatService.ACTION_STOP)
            "pause" -> command(FloatingCatService.ACTION_PAUSE)
            "resume" -> command(FloatingCatService.ACTION_RESUME)
            "hide" -> command(FloatingCatService.ACTION_HIDE)
            "show" -> command(FloatingCatService.ACTION_SHOW)
            "settingsChanged" -> command(FloatingCatService.ACTION_RELOAD_SETTINGS)
            "openOverlaySettings" -> {
                OverlayAccess.openSettings(activity)
                pushState()
            }
        }
    }

    private fun start() {
        if (FloatingState.running) {
            pushState()
            return
        }
        if (!OverlayAccess.canDraw(activity)) {
            // The page explains the permission before it ever asks; this only reports that it is still missing.
            FloatingState.startFailed(FloatingState.Stop.PERMISSION_MISSING)
            return
        }
        askNotificationsOnce()
        try {
            ContextCompat.startForegroundService(activity, FloatingCatService.intent(activity, FloatingCatService.ACTION_START))
        } catch (e: RuntimeException) {
            // ForegroundServiceStartNotAllowedException and friends: the system refused.
            FloatingState.startFailed(FloatingState.Stop.SYSTEM)
        }
    }

    /**
     * Android 13+: the notification permission is what makes the controls in the notification visible.
     * Asked once, and never again after an answer; the floating cat works without it (the app screen has the buttons).
     */
    private fun askNotificationsOnce() {
        if (!FloatingState.canAskNotifications(activity)) return
        FloatingState.markNotificationsAsked(activity)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
        }
    }

    /** A command for a running service; nothing is started for it (a stale button must not bring the cat up). */
    private fun command(action: String) {
        if (!FloatingState.running) return
        try {
            activity.startService(FloatingCatService.intent(activity, action))
        } catch (e: RuntimeException) {
            // The app is not in a state that may start a service; the notification still works.
        }
    }
}
