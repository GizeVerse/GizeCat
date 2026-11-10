package io.github.gizeverse.gizecat

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

/**
 * Process-wide state of the floating cat (1.4.1), read by the foreground service, the app
 * screen's bridge and the Activity. Main thread only: every writer and every listener runs on it,
 * so there are no locks. It holds no cat and no setting, only what the controls need to show.
 */
internal object FloatingState {
    /** Why the floating cat is not running (the page's `StopReason`). */
    enum class Stop(val wire: String) {
        NONE("none"),
        USER("user"),
        PERMISSION_MISSING("permission-missing"),
        PERMISSION_REVOKED("permission-revoked"),
        RENDERER_FAILED("renderer-failed"),
        SYSTEM("system"),
    }

    /** The floating window exists (or is being created) and the service is in the foreground. */
    var running = false
        private set
    var paused = false
        private set
    var hidden = false
        private set
    var lastStop = Stop.NONE
        private set

    /**
     * MainActivity is between onStart and onStop. WebView timers are process-wide: the Activity's
     * pauseTimers() would freeze the floating cat's JavaScript the moment the user leaves the app,
     * so it is skipped while the cat floats (MainActivity.onStop), and the service pauses them itself
     * when it stops with the app out of sight.
     */
    var appStarted = false

    /**
     * Set by the service while it runs: where a touch inside GizeCat's OWN app window goes (screen dp),
     * offered to the cat as something to look at. Android shows an app no touch outside its own
     * windows, so this and the cat's own window are the only pointers the cat can ever get.
     */
    var hintSink: ((Float, Float) -> Unit)? = null

    fun hint(xDp: Float, yDp: Float) {
        hintSink?.invoke(xDp, yDp)
    }

    private val listeners = LinkedHashSet<() -> Unit>()
    private const val PREFS = "floating"
    private const val KEY_NOTIFICATIONS_ASKED = "notifications_asked"

    fun addListener(listener: () -> Unit) {
        listeners.add(listener)
    }

    fun removeListener(listener: () -> Unit) {
        listeners.remove(listener)
    }

    private fun changed() {
        for (l in listeners.toList()) {
            try {
                l()
            } catch (e: RuntimeException) {
                // One listener (a page that went away) must not stop the others.
            }
        }
    }

    fun started() {
        running = true
        paused = false
        hidden = false
        lastStop = Stop.NONE
        changed()
    }

    fun stopped(reason: Stop) {
        running = false
        paused = false
        hidden = false
        lastStop = reason
        changed()
    }

    /** A start that never got going (no permission, the system refused): not running, with the reason. */
    fun startFailed(reason: Stop) = stopped(reason)

    fun setPaused(value: Boolean) {
        if (paused == value) return
        paused = value
        changed()
    }

    fun setHidden(value: Boolean) {
        if (hidden == value) return
        hidden = value
        changed()
    }

    /** The page re-reads this (permission or notification state may have changed while the app was away). */
    fun refresh() = changed()

    fun notificationsAsked(context: Context): Boolean = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_NOTIFICATIONS_ASKED, false)

    fun markNotificationsAsked(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_NOTIFICATIONS_ASKED, true).apply()
    }

    /** The Android 13+ notification permission can still be asked for: never asked, not granted. */
    fun canAskNotifications(context: Context): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            !notificationsAsked(context) &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED

    /** The page's `FloatingState` message (floatingProtocol.ts parseFloatingState). */
    fun toJson(context: Context): String =
        JSONObject()
            .put("t", "state")
            .put("running", running)
            .put("paused", paused)
            .put("hidden", hidden)
            .put("overlayPermission", OverlayAccess.canDraw(context))
            .put("notifications", NotificationManagerCompat.from(context).areNotificationsEnabled())
            .put("canAskNotifications", canAskNotifications(context))
            .put("lastStop", lastStop.wire)
            .toString()
}

/** Android's "Display over other apps" permission (SYSTEM_ALERT_WINDOW), by the official APIs only. */
internal object OverlayAccess {
    fun canDraw(context: Context): Boolean = Settings.canDrawOverlays(context)

    /**
     * Opens Android's own page for this app's permission (ACTION_MANAGE_OVERLAY_PERMISSION with the
     * package URI). The app never grants itself anything; the user flips the switch there.
     * Returns false when no activity handles it (some builds lack the page).
     */
    fun openSettings(activity: Activity): Boolean {
        val specific = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${activity.packageName}"))
        return try {
            activity.startActivity(specific)
            true
        } catch (e: android.content.ActivityNotFoundException) {
            try {
                // The general list of apps that may draw over others.
                activity.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION))
                true
            } catch (e2: android.content.ActivityNotFoundException) {
                false
            }
        }
    }
}
