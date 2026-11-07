package io.github.gizeverse.gizecat

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException

/**
 * The app's only native bridge, kept narrow for the profile export and import feature
 * (android/README.md, "Native file bridge"). Both directions go through the Storage Access
 * Framework, so the user picks every file in the system UI and the app needs no storage permission.
 *
 * 1. Import: `<input type=file>` in the page opens ACTION_OPEN_DOCUMENT for JSON or plain-text
 *    files; the WebView reads the picked document itself.
 * 2. Export: the page posts one JSON string to the injected `gizecatNative` object:
 *    `{type: "saveFile", name, mime, text}` (mime "application/json" or "text/plain", text at most
 *    [MAX_TEXT_BYTES] in UTF-8). The user picks the location in ACTION_CREATE_DOCUMENT, the text is
 *    written through the ContentResolver, and the page gets `{type: "saveResult", ok, reason?}`.
 *    The object exists only in main frames of the app's own origin ([MainActivity.WEB_ORIGIN]);
 *    every other message type, shape or size is refused.
 *
 * Everything else a WebChromeClient could grant stays denied: camera, microphone and other web
 * permission requests, geolocation, and new windows (the WebView default).
 */
internal class FileBridge(private val activity: Activity) {
    companion object {
        /** The page-side global (`window.gizecatNative`) added by WebViewCompat.addWebMessageListener. */
        const val BRIDGE_NAME = "gizecatNative"

        /** Largest text a saveFile message may carry, in UTF-8 bytes. */
        const val MAX_TEXT_BYTES = 256 * 1024

        /** Largest raw message accepted before parsing: the text plus JSON escaping and the other fields. */
        private const val MAX_MESSAGE_CHARS = 2 * MAX_TEXT_BYTES + 4096

        private const val MAX_NAME_CHARS = 100
        private const val DEFAULT_NAME = "gizecat-profile"
        private const val REQUEST_OPEN = 0x6A01
        private const val REQUEST_SAVE = 0x6A02

        /** File types the picker offers and saveFile accepts. */
        val ALLOWED_MIME: Set<String> = setOf("application/json", "text/plain")
        private val MESSAGE_KEYS = setOf("type", "name", "mime", "text")
        private const val FORBIDDEN_NAME_CHARS = "<>:\"/\\|?*"

        /**
         * A display name safe for any document provider: no path parts, control or invisible
         * formatting characters (bidi overrides), reserved characters or leading dots; at most
         * [MAX_NAME_CHARS] characters; always ending in the extension of [mime].
         */
        fun sanitizeFileName(raw: String, mime: String): String {
            val ext = if (mime == "application/json") ".json" else ".txt"
            var base = raw.substringAfterLast('/').substringAfterLast('\\')
                .filter { c -> !Character.isISOControl(c) && Character.getType(c) != Character.FORMAT.toInt() && c !in FORBIDDEN_NAME_CHARS }
                .trim()
                .trimStart('.')
                .trim()
            if (base.length > MAX_NAME_CHARS) base = base.take(MAX_NAME_CHARS).trimEnd()
            if (base.isEmpty()) base = DEFAULT_NAME
            if (!base.endsWith(ext, ignoreCase = true)) base += ext
            return base
        }
    }

    private class SaveRequest(val name: String, val mime: String, val bytes: ByteArray)

    private class PendingSave(val view: WebView, val reply: JavaScriptReplyProxy, val bytes: ByteArray)

    private var currentView: WebView? = null
    private var pendingChooser: ValueCallback<Array<Uri>>? = null
    private var pendingSave: PendingSave? = null

    val chromeClient: WebChromeClient = object : WebChromeClient() {
        override fun onShowFileChooser(
            webView: WebView?,
            filePathCallback: ValueCallback<Array<Uri>>?,
            fileChooserParams: WebChromeClient.FileChooserParams?,
        ): Boolean {
            if (filePathCallback == null) return false
            // Only one picker at a time: a stale request is answered with "nothing picked".
            pendingChooser?.onReceiveValue(null)
            pendingChooser = null
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
                putExtra(Intent.EXTRA_MIME_TYPES, ALLOWED_MIME.toTypedArray())
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false)
            }
            try {
                @Suppress("DEPRECATION")
                activity.startActivityForResult(intent, REQUEST_OPEN)
                pendingChooser = filePathCallback
            } catch (e: ActivityNotFoundException) {
                filePathCallback.onReceiveValue(null)
            }
            return true
        }

        override fun onPermissionRequest(request: PermissionRequest?) {
            request?.deny()
        }

        override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback?) {
            callback?.invoke(origin, false, false)
        }
    }

    /** Adds the `gizecatNative` object to [view], for the app's own origin only. Call before loadUrl. */
    fun attach(view: WebView) {
        currentView = view
        // An Android System WebView too old for the listener simply has no bridge; the page then
        // reports that saving to a file is unavailable.
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

    /** [view] is being destroyed: forget its picker callback; a save in progress still writes, without a reply. */
    fun detach(view: WebView) {
        if (currentView === view) {
            currentView = null
            pendingChooser = null
        }
    }

    private fun onMessage(view: WebView, message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, reply: JavaScriptReplyProxy) {
        // addWebMessageListener already restricts the origin; checked again so a future rule change cannot widen it.
        if (!isMainFrame || sourceOrigin.toString() != MainActivity.WEB_ORIGIN || view !== currentView) return
        if (message.type != WebMessageCompat.TYPE_STRING) return replyResult(reply, false, "invalid")
        val data = message.data ?: return replyResult(reply, false, "invalid")
        if (data.length > MAX_MESSAGE_CHARS) return replyResult(reply, false, "too-large")
        val request = parseSaveRequest(data) ?: return replyResult(reply, false, "invalid")
        if (request.bytes.size > MAX_TEXT_BYTES) return replyResult(reply, false, "too-large")
        if (pendingSave != null) return replyResult(reply, false, "busy")
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = request.mime
            putExtra(Intent.EXTRA_TITLE, request.name)
        }
        try {
            @Suppress("DEPRECATION")
            activity.startActivityForResult(intent, REQUEST_SAVE)
            pendingSave = PendingSave(view, reply, request.bytes)
        } catch (e: ActivityNotFoundException) {
            replyResult(reply, false, "unavailable")
        }
    }

    /** The exact saveFile shape, or null: unknown keys, other types, non-string fields or another MIME type are refused. */
    private fun parseSaveRequest(data: String): SaveRequest? {
        val json = try {
            JSONObject(data)
        } catch (e: JSONException) {
            return null
        }
        val keys = json.keys().asSequence().toSet()
        if (keys != MESSAGE_KEYS) return null
        if (json.opt("type") != "saveFile") return null
        val name = json.opt("name") as? String ?: return null
        val mime = json.opt("mime") as? String ?: return null
        val text = json.opt("text") as? String ?: return null
        if (mime !in ALLOWED_MIME) return null
        return SaveRequest(sanitizeFileName(name, mime), mime, text.toByteArray(Charsets.UTF_8))
    }

    /** Called from MainActivity.onActivityResult; true when the result was one of ours. */
    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        when (requestCode) {
            REQUEST_OPEN -> {
                val callback = pendingChooser
                pendingChooser = null
                callback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
                return true
            }
            REQUEST_SAVE -> {
                val save = pendingSave ?: return true
                pendingSave = null
                val uri = data?.data
                if (resultCode != Activity.RESULT_OK || uri == null) {
                    replyIfCurrent(save, false, "cancelled")
                    return true
                }
                // Providers may be slow (cloud documents): write off the UI thread, reply on it.
                Thread {
                    val ok = write(uri, save.bytes)
                    activity.runOnUiThread { replyIfCurrent(save, ok, if (ok) null else "write-failed") }
                }.start()
                return true
            }
        }
        return false
    }

    private fun write(uri: Uri, bytes: ByteArray): Boolean {
        val resolver = activity.contentResolver
        // "wt" truncates; some providers only support "w" (a new document is empty either way).
        for (mode in arrayOf("wt", "w")) {
            try {
                resolver.openOutputStream(uri, mode)?.use { out ->
                    out.write(bytes)
                    return true
                }
            } catch (e: IOException) {
                // try the next mode
            } catch (e: IllegalArgumentException) {
                // the provider rejects this mode
            } catch (e: SecurityException) {
                return false
            }
        }
        return false
    }

    /** Replies only if the page that asked is still the live one (not replaced after a renderer loss). */
    private fun replyIfCurrent(save: PendingSave, ok: Boolean, reason: String?) {
        if (save.view !== currentView || activity.isDestroyed) return
        replyResult(save.reply, ok, reason)
    }

    private fun replyResult(reply: JavaScriptReplyProxy, ok: Boolean, reason: String?) {
        val result = JSONObject().put("type", "saveResult").put("ok", ok)
        if (reason != null) result.put("reason", reason)
        reply.postMessage(result.toString())
    }
}
