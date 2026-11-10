package io.github.gizeverse.gizecat

import android.app.AppOpsManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.NotificationCompat

/**
 * The floating cat's foreground service (1.4.0 preview 2). It owns one [OverlayWindow] (never two),
 * the notification Android requires for a foreground service, and the lifecycle:
 *
 * - START (from the app screen, with the app in the foreground): enters the foreground first, then
 *   checks "Display over other apps" with Settings.canDrawOverlays(); without it the service stops at
 *   once and says why (FloatingState.Stop.PERMISSION_MISSING). It never opens Android's settings itself.
 * - PAUSE/RESUME, HIDE/SHOW, STOP, RELOAD_SETTINGS (from the notification and the app screen).
 * - The permission being revoked while it runs (an AppOps watch), a window that cannot be added, or a
 *   WebView that keeps crashing, stop it with the matching reason. Nothing restarts it: START_NOT_STICKY,
 *   no boot receiver. After a reboot, or when the system ends the process, the cat is simply not
 *   floating until the user starts it again.
 * - Screen off puts the cat to sleep (a suspended page, a stopped renderer); screen on wakes it.
 * - On stop the page writes the cat to storage first (bounded wait), then the window and WebView are freed.
 *
 * Main thread only, like every Service callback.
 */
class FloatingCatService : Service() {
    companion object {
        const val ACTION_START = "io.github.gizeverse.gizecat.floating.START"
        const val ACTION_STOP = "io.github.gizeverse.gizecat.floating.STOP"
        const val ACTION_PAUSE = "io.github.gizeverse.gizecat.floating.PAUSE"
        const val ACTION_RESUME = "io.github.gizeverse.gizecat.floating.RESUME"
        const val ACTION_HIDE = "io.github.gizeverse.gizecat.floating.HIDE"
        const val ACTION_SHOW = "io.github.gizeverse.gizecat.floating.SHOW"
        const val ACTION_RELOAD_SETTINGS = "io.github.gizeverse.gizecat.floating.RELOAD_SETTINGS"

        private const val CHANNEL_ID = "floating_cat"
        private const val NOTIFICATION_ID = 4101
        private const val SAVE_TIMEOUT_MS = 800L

        /** Renderer crashes tolerated within [LOSS_WINDOW_MS] before the service gives up. */
        private const val MAX_LOSSES = 3
        private const val LOSS_WINDOW_MS = 60_000L

        internal fun intent(context: Context, action: String): Intent = Intent(context, FloatingCatService::class.java).setAction(action)
    }

    private val handler = Handler(Looper.getMainLooper())
    private var window: OverlayWindow? = null
    private var stopping = false
    private var screenReceiver: BroadcastReceiver? = null
    private var appOps: AppOpsManager? = null
    private var appOpsListener: AppOpsManager.OnOpChangedListener? = null
    private val crashes = ArrayDeque<Long>()

    private val windowCallbacks = object : OverlayWindow.Callbacks {
        override fun onPageReady() {
            // The page may have loaded after a pause or hide was asked for: bring it to the state native holds.
            val w = window ?: return
            if (FloatingState.paused) w.sendCommand("pause")
            if (FloatingState.hidden) w.sendCommand("hide")
            if (!isInteractive()) w.sendCommand("suspend")
        }

        override fun onRendererLost(didCrash: Boolean) {
            if (stopping) return
            if (didCrash) {
                val now = SystemClock.elapsedRealtime()
                crashes.addLast(now)
                while (crashes.isNotEmpty() && now - crashes.first() > LOSS_WINDOW_MS) crashes.removeFirst()
                if (crashes.size >= MAX_LOSSES) {
                    stopFloating(FloatingState.Stop.RENDERER_FAILED)
                    return
                }
            }
            // A renderer the system reclaimed (memory) never counts; either way a fresh page replaces it.
            val w = window ?: return
            if (!w.recreateWebView()) stopFloating(FloatingState.Stop.RENDERER_FAILED)
        }

        override fun onFailure(permissionRevoked: Boolean) {
            if (stopping) return
            stopFloating(if (permissionRevoked) FloatingState.Stop.PERMISSION_REVOKED else FloatingState.Stop.SYSTEM)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startFloating()
            ACTION_STOP -> stopFloating(FloatingState.Stop.USER)
            ACTION_PAUSE -> setPaused(true)
            ACTION_RESUME -> setPaused(false)
            ACTION_HIDE -> setHidden(true)
            ACTION_SHOW -> setHidden(false)
            ACTION_RELOAD_SETTINGS -> window?.sendCommand("reloadSettings")
            // No action: a start the system replayed. Never floats on its own.
            else -> if (window == null) stopSelf()
        }
        // A command that found no window (a stale notification button) must not leave an idle,
        // non-foreground service behind.
        if (intent?.action != ACTION_START && window == null && !stopping) stopSelf()
        return START_NOT_STICKY
    }

    private fun startFloating() {
        // Before anything else: a service started with startForegroundService must enter the foreground quickly.
        enterForeground()
        if (window != null) return
        stopping = false
        if (!OverlayAccess.canDraw(this)) {
            // The app screen explains the permission and opens Android's page; this only stops, quietly.
            FloatingState.startFailed(FloatingState.Stop.PERMISSION_MISSING)
            leaveForeground()
            stopSelf()
            return
        }
        val w = OverlayWindow(this, windowCallbacks)
        window = w
        if (!w.start()) {
            window = null
            w.destroy()
            FloatingState.startFailed(FloatingState.Stop.SYSTEM)
            leaveForeground()
            stopSelf()
            return
        }
        FloatingState.started()
        registerWatchers()
        enterForeground()
    }

    private fun setPaused(paused: Boolean) {
        if (window == null) return
        FloatingState.setPaused(paused)
        window?.sendCommand(if (paused) "pause" else "resume")
        enterForeground()
    }

    private fun setHidden(hidden: Boolean) {
        if (window == null) return
        FloatingState.setHidden(hidden)
        window?.sendCommand(if (hidden) "hide" else "show")
        enterForeground()
    }

    /** Saves the cat, frees the window, leaves the foreground and ends. Safe to call twice. */
    private fun stopFloating(reason: FloatingState.Stop) {
        if (stopping) return
        stopping = true
        val w = window
        if (w == null) {
            finish(reason)
            return
        }
        // The page writes the cat before the WebView goes (bounded: a stuck page must not hold the service).
        w.requestSave(SAVE_TIMEOUT_MS) {
            w.destroy()
            window = null
            finish(reason)
        }
    }

    private fun finish(reason: FloatingState.Stop) {
        unregisterWatchers()
        FloatingState.stopped(reason)
        leaveForeground()
        stopSelf()
    }

    override fun onDestroy() {
        // The system or stopSelf ended the service: nothing may outlive it.
        unregisterWatchers()
        handler.removeCallbacksAndMessages(null)
        window?.let {
            it.destroy()
            window = null
        }
        if (FloatingState.running) FloatingState.stopped(if (stopping) FloatingState.Stop.USER else FloatingState.Stop.SYSTEM)
        super.onDestroy()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        window?.onConfigurationChanged()
    }

    // ---- watchers: screen on/off, the overlay permission

    private fun registerWatchers() {
        if (screenReceiver == null) {
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context?, intent: Intent?) {
                    when (intent?.action) {
                        Intent.ACTION_SCREEN_OFF -> window?.sendCommand("suspend")
                        // A paused cat stays paused when the screen comes back.
                        Intent.ACTION_SCREEN_ON -> window?.sendCommand("wake")
                    }
                }
            }
            val filter = IntentFilter().apply {
                addAction(Intent.ACTION_SCREEN_OFF)
                addAction(Intent.ACTION_SCREEN_ON)
            }
            // System broadcasts: the receiver is not exported. (ContextCompat.registerReceiver is not used:
            // the manifest removes the permission it relies on, and the app never needs it.)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                registerReceiver(receiver, filter)
            }
            screenReceiver = receiver
        }
        if (appOpsListener == null) {
            val ops = getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
            val listener = AppOpsManager.OnOpChangedListener { _, _ ->
                // May arrive on any thread: look again on the main thread.
                handler.post {
                    if (!stopping && window != null && !OverlayAccess.canDraw(this)) stopFloating(FloatingState.Stop.PERMISSION_REVOKED)
                }
            }
            ops.startWatchingMode(AppOpsManager.OPSTR_SYSTEM_ALERT_WINDOW, packageName, listener)
            appOps = ops
            appOpsListener = listener
        }
    }

    private fun unregisterWatchers() {
        screenReceiver?.let {
            try {
                unregisterReceiver(it)
            } catch (e: IllegalArgumentException) {
                // Not registered.
            }
        }
        screenReceiver = null
        appOpsListener?.let { appOps?.stopWatchingMode(it) }
        appOpsListener = null
        appOps = null
    }

    private fun isInteractive(): Boolean = (getSystemService(Context.POWER_SERVICE) as android.os.PowerManager).isInteractive

    // ---- the notification (required for a foreground service; minimal and controllable)

    private fun createChannel() {
        val channel = NotificationChannel(CHANNEL_ID, getString(R.string.floating_channel_name), NotificationManager.IMPORTANCE_LOW).apply {
            description = getString(R.string.floating_channel_description)
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_SECRET
        }
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
    }

    private fun action(code: Int, label: Int, action: String): NotificationCompat.Action =
        NotificationCompat.Action.Builder(
            0,
            getString(label),
            PendingIntent.getService(this, code, intent(this, action), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT),
        ).build()

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra(MainActivity.EXTRA_OPEN_SETTINGS, true),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val text = when {
            FloatingState.hidden -> R.string.floating_notification_hidden
            FloatingState.paused -> R.string.floating_notification_paused
            else -> R.string.floating_notification_running
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_cat)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(text))
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(action(1, if (FloatingState.paused) R.string.floating_action_resume else R.string.floating_action_pause, if (FloatingState.paused) ACTION_RESUME else ACTION_PAUSE))
            .addAction(action(2, if (FloatingState.hidden) R.string.floating_action_show else R.string.floating_action_hide, if (FloatingState.hidden) ACTION_SHOW else ACTION_HIDE))
            .addAction(action(3, R.string.floating_action_stop, ACTION_STOP))
            .build()
    }

    /** Enters the foreground, or refreshes the notification (calling it again replaces it). */
    private fun enterForeground() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun leaveForeground() {
        stopForeground(STOP_FOREGROUND_REMOVE)
    }
}
