package app.aiwatch.mobile

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject
import java.util.concurrent.Executors

object PushRegistration {
    fun channelId(context: Context) = context.getString(R.string.ai_watch_channel_id)
    private val work = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private data class Registration(val credentials: Credentials, val token: String, val live: Boolean, val transport: String, val activity: String?)
    private var registered: Registration? = null
    fun consented(context: Context) = context.getSharedPreferences("push_consent", Context.MODE_PRIVATE).getBoolean("enabled", false)
    fun consent(context: Context) { check(context.getSharedPreferences("push_consent", Context.MODE_PRIVATE).edit().putBoolean("enabled", true).commit()) }
    fun notificationStatus(context: Context, registrationStatus: String): String {
        val manager = context.getSystemService(NotificationManager::class.java)
        return if (!manager.areNotificationsEnabled() || Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            tr("系统通知已关闭；可在系统设置中开启") + " · " + registrationStatus else registrationStatus
    }
    fun channel(context: Context) {
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(channelId(context), tr("待回答、授权和低额度提醒"), NotificationManager.IMPORTANCE_HIGH))
    }
    fun enable(context: Context, status: (String) -> Unit) {
        val application = context.applicationContext; channel(application)
        if (!consented(application)) { status(tr("通知尚未启用")); return }
        VendorPush.selected(application)?.let { it.enable(application, status); return }
        if (FirebaseApp.getApps(application).isEmpty() && FirebaseApp.initializeApp(application) == null) {
            status(tr("FCM 尚未配置；状态查看与手机操作可用")); return
        }
        FirebaseMessaging.getInstance().isAutoInitEnabled = true
        FirebaseMessaging.getInstance().token.addOnSuccessListener { register(application, it, status) }
            .addOnFailureListener { status(tr("推送令牌获取失败，请检查 Google Play 服务")) }
    }
    fun register(context: Context, token: String, status: (String) -> Unit = {}, transport: String = "fcm") {
        work.execute {
            if (!consented(context) || token.length !in 16..4096 || transport !in listOf("fcm", "mipush", "vpush")) return@execute
            if ((VendorPush.selected(context)?.transport ?: "fcm") != transport) return@execute
            val store = SecureStore(context); val credentials = store.read() ?: return@execute
            val live = AttentionNotifications.enabledFor(context, credentials)
            val activity = AttentionNotifications.localRegistration(context)
            val registration = Registration(credentials, token, live, transport, activity?.toString())
            if (registered == registration) { main.post { status(tr("推送已注册")) }; return@execute }
            val client = CloudClient(credentials)
            try {
                val body = JSONObject().put("id", store.installation()).put("platform", "android").put("token", token).put("transport", transport).put("liveUpdates", live)
                if (activity != null) body.put("liveActivity", activity)
                client.json("/v1/devices", "POST", body)
                registered = registration; main.post { status(tr("推送已注册")) }
            } catch (_: Exception) { main.post { status(tr("推送登记失败，返回前台后重试")) } }
            finally { client.close() }
        }
    }
    fun refreshCapabilities(context: Context) {
        if (SecureStore(context).read() == null || !consented(context)) return
        VendorPush.selected(context)?.let { it.refreshToken(context.applicationContext); return }
        if (FirebaseApp.getApps(context).isEmpty()) return
        FirebaseMessaging.getInstance().token.addOnSuccessListener { register(context.applicationContext, it) }
    }
    fun logout(context: Context, done: (Boolean) -> Unit) {
        // Serial ordering prevents an in-flight registration from re-registering after logout.
        work.execute {
            val store = SecureStore(context); val value = store.read()
            val client = value?.let { CloudClient(it) }
            try {
                client?.revokePair()
                store.clear(); registered = null
                AttentionNotifications.setEnabled(context, false)
                main.post { VendorPush.selected(context)?.disable(context.applicationContext) }
                if (FirebaseApp.getApps(context).isNotEmpty()) FirebaseMessaging.getInstance().isAutoInitEnabled = false
                main.post { done(true) }
            } catch (_: Exception) { main.post { done(false) } }
            finally { client?.close() }
        }
    }
}

class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) { PushRegistration.register(applicationContext, token) }
    override fun onMessageReceived(message: RemoteMessage) {
        if (SecureStore(this).read() == null) return
        if ((message.data["category"] ?: message.data["type"]) == "attention") {
            AttentionNotifications.refreshFromPush(applicationContext)
            return
        }
        PushRegistration.channel(this)
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val category = message.data["category"] ?: message.data["type"]
        val title = getString(when (category) { "input" -> R.string.ai_watch_input_title; "approval" -> R.string.ai_watch_approval_title; "low-quota" -> R.string.ai_watch_low_quota_title; else -> R.string.ai_watch_status_title })
        val intent = Intent(this, MainActivity::class.java).setAction(MainActivity.OPEN_ATTENTION).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pending = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = Notification.Builder(this, PushRegistration.channelId(this))
            .setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle(title)
            .setContentText(getString(R.string.ai_watch_notice_body))
            .setContentIntent(pending).setAutoCancel(true).setVisibility(Notification.VISIBILITY_PRIVATE).build()
        getSystemService(NotificationManager::class.java).notify((message.data["eventId"] ?: message.messageId ?: title).hashCode(), notification)
    }
}
