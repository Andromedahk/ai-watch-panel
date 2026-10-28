package app.aiwatch.mobile

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import android.widget.FrameLayout
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.security.MessageDigest
import java.util.concurrent.Executors

/** Native host only: all panel views, skins and motion come from the desktop bundle. */
class MainActivity : Activity() {
    private lateinit var store: SecureStore
    private lateinit var web: WebView
    private var credentials: Credentials? = null
    private var controller: CloudController? = null
    private var active = false
    private var webReady = false
    private var busy = false
    private var message = ""
    private var pushStatus = tr("通知尚未启用")
    private var notificationReply: String? = null
    private var submissionReply: String? = null
    private val work = Executors.newSingleThreadExecutor()
    private val submissions = mutableMapOf<String, Pair<String, Long>>()
    private var attentionOpenSequence = 0
    private val attentionListener: () -> Unit = { runOnUiThread { publish() } }

    companion object {
        const val ORIGIN = "https://appassets.androidplatform.net"
        const val PAGE = "$ORIGIN/assets/mobile/index.html"
        const val OPEN_ATTENTION = "app.aiwatch.mobile.OPEN_ATTENTION"
    }
    private fun opensAttention(intent: Intent) = intent.action == OPEN_ATTENTION || intent.data?.toString() == "aiwatch://attention"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (packageName.endsWith(".qa")) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        store = SecureStore(this); credentials = store.read()
        if (opensAttention(intent)) attentionOpenSequence++
        AttentionNotifications.listeners.add(attentionListener)
        credentials?.let { if (AttentionNotifications.enabled(this) && !AttentionNotifications.enabledFor(this, it)) AttentionNotifications.setEnabled(this, false) }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            setContentView(TextView(this).apply { text = tr("请更新 Android System WebView 后重新打开。") }); return
        }
        web = WebView(this)
        WebView.setWebContentsDebuggingEnabled(packageName.endsWith(".qa"))
        web.settings.apply {
            javaScriptEnabled = true; domStorageEnabled = true
            allowFileAccess = false; allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false; setSupportMultipleWindows(false)
            mediaPlaybackRequiresUserGesture = true
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
        }
        val assets = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (request.method != "GET" || !bundled(request.url)) return denied()
                return assets.shouldInterceptRequest(request.url) ?: denied()
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                !bundled(request.url) || request.url.path != "/assets/mobile/index.html"
            override fun onPageFinished(view: WebView, url: String) { if (bundled(Uri.parse(url))) publish() }
        }
        WebViewCompat.addWebMessageListener(web, "nativeBridge", setOf(ORIGIN)) { _, incoming, source, mainFrame, _ ->
            if (!mainFrame || source.scheme != "https" || source.host != "appassets.androidplatform.net" || source.port !in listOf(-1, 443) || incoming.type != WebMessageCompat.TYPE_STRING) return@addWebMessageListener
            receive(incoming.data ?: return@addWebMessageListener)
        }
        val frame = FrameLayout(this).apply { addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)) }
        frame.setOnApplyWindowInsetsListener { view, insets ->
            @Suppress("DEPRECATION")
            view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            insets
        }
        setContentView(frame)
        web.loadUrl(PAGE)
    }

    private fun bundled(url: Uri) = url.scheme == "https" && url.host == "appassets.androidplatform.net" &&
        url.port in listOf(-1, 443) && url.path?.startsWith("/assets/mobile/") == true && url.userInfo == null
    private fun denied() = WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    override fun onStart() { super.onStart(); active = true; if (::web.isInitialized) { web.onResume(); connect() } }
    override fun onStop() {
        submissionReply?.let { busy = false; submissionReply = null; publish(it, false, "outcome-unknown") }
        active = false; controller?.stop(); controller = null
        if (::web.isInitialized) web.onPause()
        super.onStop()
    }
    override fun onDestroy() {
        AttentionNotifications.listeners.remove(attentionListener)
        work.shutdownNow()
        if (::web.isInitialized) { WebViewCompat.removeWebMessageListener(web, "nativeBridge"); web.destroy() }
        super.onDestroy()
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent); setIntent(intent)
        if (opensAttention(intent)) attentionOpenSequence++
        controller?.refresh(); publish()
    }

    private fun connect() {
        if (!active || controller != null) return
        val value = credentials ?: return
        controller = CloudController(CloudClient(value)) { publish() }.also { it.start() }
        PushRegistration.enable(this) { pushStatus = it; publish() }
    }

    private fun publish(replyId: String? = null, ok: Boolean = true, error: String? = null) {
        if (!::web.isInitialized || !webReady || isDestroyed) return
        val state = controller?.state
        val terminal = state?.commands.orEmpty().filter { it.status in listOf("succeeded", "failed", "expired") }.map { it.requestId }.toSet()
        submissions.entries.removeAll { (requestId, entry) ->
            entry.second <= System.currentTimeMillis() || requestId in terminal || state != null && state.requests.none { it.id == requestId }
        }
        val value = credentials
        if (value != null && controller?.state != null) AttentionNotifications.update(this, state, value, controller?.online == true)
        val payload = JSONObject().put("configured", value != null).put("platform", "android")
            .put("state", controller?.state?.wire ?: JSONObject.NULL).put("online", controller?.online == true)
            .put("connected", controller?.connected == true).put("busy", busy)
            .put("message", controller?.message.orEmpty().ifBlank { message })
            .put("pushStatus", PushRegistration.notificationStatus(this, pushStatus))
            .put("liveUpdatesEnabled", AttentionNotifications.enabled(this))
            .put("liveUpdatesStatus", AttentionNotifications.status(this)).put("attentionOpenSequence", attentionOpenSequence)
            .put("accountKey", value?.let { MessageDigest.getInstance("SHA-256").digest((it.server + "\n" + it.token).toByteArray(Charsets.UTF_8)).joinToString("") { byte -> "%02x".format(byte) } } ?: JSONObject.NULL)
        if (replyId != null) payload.put("reply", JSONObject().put("id", replyId).put("ok", ok).apply { if (error != null) put("error", error) })
        web.evaluateJavascript("window.aiWatchMobile && window.aiWatchMobile.receive($payload)", null)
    }

    private fun receive(raw: String) {
        val action = runCatching { parseBridgeMessage(raw) }.getOrElse {
            val invalid = if (raw.toByteArray(Charsets.UTF_8).size <= 128 * 1024) runCatching { JSONObject(raw) }.getOrNull() else null
            message = if (invalid?.optString("type") == "configure") tr("请输入 HTTPS 根地址和有效配对凭据") else tr("服务器返回了无法识别的数据。")
            val id = invalid?.optString("id")?.takeIf { Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$").matches(it) }
            publish(id, false, message); return
        }
        if (action.type == "ready") { webReady = true; publish(action.id); return }
        if (busy && action.type !in listOf("refresh")) { publish(action.id, false, "operation-busy"); return }
        when (action.type) {
            "configure" -> configure(action)
            "refresh" -> { message = ""; controller?.refresh(); publish(action.id) }
            "submit" -> submit(action)
            "logout" -> logout(action.id)
            "notifications" -> notifications(action.id)
            "liveUpdates" -> {
                if (credentials == null) { publish(action.id, false, "not-configured"); return }
                val enabled = action.value.getBoolean("enabled")
                AttentionNotifications.setEnabled(this, enabled)
                if (enabled) notifications(action.id)
                else { PushRegistration.refreshCapabilities(this); publish(action.id) }
            }
        }
    }

    private fun configure(action: BridgeMessage) {
        val bootstrap = Credentials.validate(action.value.getString("server"), action.value.getString("token"))
        // Replacing an existing paired account requires an explicit logout first.
        if (credentials != null) { publish(action.id, false, "already-configured"); return }
        busy = true; message = ""; publish()
        work.execute {
            val pairing = CloudClient(bootstrap); var probe: CloudClient? = null
            try {
                val paired = pairing.pair(store.installation())
                probe = CloudClient(paired); probe.state()
                runOnUiThread {
                    if (!isDestroyed) {
                        try {
                            store.save(paired); credentials = paired; busy = false; message = ""
                            connect(); publish(action.id)
                        } catch (failure: Exception) { busy = false; message = errorMessage(failure); publish(action.id, false, message) }
                    }
                }
            } catch (failure: Exception) {
                runOnUiThread { if (!isDestroyed) { busy = false; message = errorMessage(failure); publish(action.id, false, message) } }
            } finally { probe?.close(); pairing.close() }
        }
    }

    private fun submit(action: BridgeMessage) {
        val model = controller
        val input = action.value.getJSONObject("command")
        val request = model?.state?.requests?.firstOrNull { it.id == input.optString("requestId") }
        if (model == null || request == null || !model.canAct(request)) { publish(action.id, false, "request-unavailable"); return }
        val command = runCatching { validateBridgeCommand(request, input) }.getOrElse { publish(action.id, false, "invalid-command"); return }
        // The retry lock needs equality, never a retained copy of answer text.
        val digest = MessageDigest.getInstance("SHA-256").digest(command.toString().toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        val previous = submissions[request.id]
        if (previous != null && previous.first != digest) { publish(action.id, false, "original-command-locked"); return }
        submissions[request.id] = digest to minOf(request.expires, System.currentTimeMillis() + 120_000)
        busy = true; submissionReply = action.id; message = ""; publish()
        model.submit(request, command) { ok, result ->
            if (submissionReply != action.id || isDestroyed) return@submit
            submissionReply = null; busy = false; message = result
            publish(action.id, ok, if (ok) null else result)
        }
    }

    private fun logout(id: String) {
        busy = true; message = ""; publish()
        PushRegistration.logout(this) { success ->
            if (!isDestroyed) {
                busy = false
                if (success) {
                    controller?.stop(); controller = null; credentials = null; submissions.clear()
                    message = ""; pushStatus = tr("通知尚未启用")
                } else message = tr("注销失败，请检查网络后重试")
                publish(id, success, if (success) null else message)
            }
        }
    }

    private fun notifications(id: String) {
        if (!PushRegistration.consented(this) && VendorPush.selected(this) != null) {
            AlertDialog.Builder(this).setTitle(getString(R.string.ai_watch_push_consent_title))
                .setMessage(getString(R.string.ai_watch_push_consent_body))
                .setPositiveButton(getString(R.string.ai_watch_push_consent_accept)) { _, _ -> PushRegistration.consent(this); requestNotificationPermission(id) }
                .setNegativeButton(android.R.string.cancel) { _, _ -> publish(id, false, "notification-consent-cancelled") }
                .setOnCancelListener { publish(id, false, "notification-consent-cancelled") }.show()
            return
        }
        PushRegistration.consent(this)
        requestNotificationPermission(id)
    }
    private fun requestNotificationPermission(id: String) {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationReply = id
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        } else enableNotifications(id)
    }
    private fun enableNotifications(id: String) {
        PushRegistration.enable(this) { pushStatus = it; publish(id) }
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 1) {
            val id = notificationReply; notificationReply = null
            if (id != null) enableNotifications(id) else publish()
        }
    }
}
