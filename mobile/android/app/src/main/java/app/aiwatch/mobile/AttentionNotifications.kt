package app.aiwatch.mobile

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.security.MessageDigest
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import org.json.JSONObject

/** An explicitly enabled monitor for the user's active desktop tasks. */
object AttentionNotifications {
    const val ID = 0x415749
    private const val CHANNEL = "ai_watch_live_attention"
    private const val WORK = "ai_watch_refresh_attention"
    private const val PREFS = "live_attention"
    val listeners = CopyOnWriteArraySet<() -> Unit>()
    private val work = Executors.newSingleThreadExecutor()
    private fun preferences(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    fun scope(value: Credentials) = MessageDigest.getInstance("SHA-256").digest((value.server + "\n" + value.token).toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    fun enabled(context: Context) = preferences(context).getBoolean("enabled", false)
    fun enabledFor(context: Context, value: Credentials) = enabled(context) && preferences(context).getString("scope", null) == scope(value)

    @Synchronized fun setEnabled(context: Context, value: Boolean) {
        val credentials = SecureStore(context).read()
        require(!value || credentials != null)
        check(preferences(context).edit().putBoolean("enabled", value)
            .putString("scope", credentials?.let { scope(it) }).remove("updatedAt").commit())
        if (!value) {
            cancel(context)
            WorkManager.getInstance(context).cancelUniqueWork(WORK)
        }
        listeners.forEach { it() }
    }

    fun status(context: Context): String {
        if (!enabled(context)) return context.getString(R.string.ai_watch_live_disabled)
        val manager = context.getSystemService(NotificationManager::class.java)
        if (!allowed(context) || manager.getNotificationChannel(CHANNEL)?.importance == NotificationManager.IMPORTANCE_NONE)
            return context.getString(R.string.ai_watch_live_notifications_blocked)
        return context.getString(if (Build.VERSION.SDK_INT >= 36 && NotificationManagerCompat.from(context).canPostPromotedNotifications())
            R.string.ai_watch_live_system_eligible else R.string.ai_watch_live_fallback)
    }
    private fun allowed(context: Context) = context.getSystemService(NotificationManager::class.java).areNotificationsEnabled() &&
        (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
    private fun manager(context: Context) = context.getSystemService(NotificationManager::class.java)
    private fun cancel(context: Context) {
        manager(context).cancel(ID); manager(context).cancel(OemAttention.VIVO_TAG, ID); OemAttention.end(context)
        val wasPublished = preferences(context).getBoolean("locallyCreated", false)
        preferences(context).edit().remove("locallyCreated").remove("localMode").remove("lastPostedAt").apply()
        if (wasPublished) PushRegistration.refreshCapabilities(context)
    }
    fun localRegistration(context: Context): JSONObject? {
        val credentials = SecureStore(context).read() ?: return null
        val mode = preferences(context).getString("localMode", null)
        return if (enabledFor(context, credentials) && preferences(context).getBoolean("locallyCreated", false) && mode in listOf("mipush", "vpush"))
            JSONObject().put("notificationId", ID).put("locallyCreated", true) else null
    }

    /** Only authenticated /v1/state responses can enter this path. */
    fun update(context: Context, state: CloudState?, credentials: Credentials, online: Boolean = true) {
        if (Looper.myLooper() == Looper.getMainLooper()) work.execute { updateNow(context.applicationContext, state, credentials, online) }
        else updateNow(context, state, credentials, online)
    }
    @Synchronized private fun updateNow(context: Context, state: CloudState?, credentials: Credentials, online: Boolean) {
        if (SecureStore(context).read() != credentials || !enabledFor(context, credentials)) return
        if (!online || state == null) { cancel(context); return }
        val summary = AttentionState.from(state, System.currentTimeMillis())
        val updated = state.attention?.updatedAt ?: state.receivedAt / 1000
        val prefs = preferences(context)
        if (updated < prefs.getLong("updatedAt", 0)) return
        prefs.edit().putLong("updatedAt", updated).apply()
        if (summary == null || !allowed(context)) { cancel(context); return }
        manager(context).createNotificationChannel(NotificationChannel(CHANNEL,
            context.getString(R.string.ai_watch_live_channel), NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(context, ID, Intent(context, MainActivity::class.java)
            .setAction(MainActivity.OPEN_ATTENTION).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val unpin = PendingIntent.getBroadcast(context, ID, Intent(context, AttentionUnpinReceiver::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val title = context.getString(R.string.ai_watch_live_title, summary.providerName(), summary.total)
        val body = context.getString(R.string.ai_watch_live_body, summary.inputCount, summary.approvalCount)
        val mode = OemAttention.mode(context)
        val created = prefs.getBoolean("locallyCreated", false) && prefs.getString("localMode", null) == mode
        // vivo explicitly limits ongoing changes to one per ten seconds.
        if (mode != null && created && System.currentTimeMillis() - prefs.getLong("lastPostedAt", 0) < 10000) return
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle(title).setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(Notification.CATEGORY_STATUS).setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true).setOnlyAlertOnce(true).setShowWhen(false).setContentIntent(open)
            .setDeleteIntent(unpin).addAction(0, context.getString(R.string.ai_watch_live_unpin), unpin)
            .setTimeoutAfter((summary.expiresAt * 1000 - System.currentTimeMillis()).coerceAtLeast(1))
            // Official AndroidX API. Android/OEM eligibility still decides presentation.
            .setRequestPromotedOngoing(Build.VERSION.SDK_INT >= 36).setShortCriticalText(summary.total.toString()).build()
        OemAttention.decorate(context, notification, summary, open, title, body, mode, created)
        if (mode == "vpush") manager(context).notify(OemAttention.VIVO_TAG, ID, notification) else manager(context).notify(ID, notification)
        val local = mode in listOf("mipush", "vpush")
        val changed = prefs.getBoolean("locallyCreated", false) != local || prefs.getString("localMode", null) != mode
        prefs.edit().putBoolean("locallyCreated", local).putString("localMode", mode).putLong("lastPostedAt", System.currentTimeMillis()).apply()
        if (changed) PushRegistration.refreshCapabilities(context)
    }

    /** FCM payload is a wake-up hint, never an authoritative notification body. */
    fun refreshFromPush(context: Context) {
        val credentials = SecureStore(context).read() ?: return
        if (!enabledFor(context, credentials)) return
        val builder = OneTimeWorkRequestBuilder<AttentionRefreshWorker>()
            .setInputData(workDataOf("scope" to scope(credentials)))
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        if (Build.VERSION.SDK_INT >= 31) builder.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
        WorkManager.getInstance(context).enqueueUniqueWork(WORK, ExistingWorkPolicy.REPLACE, builder.build())
    }
    @Synchronized fun authorizationFailed(context: Context, credentials: Credentials) {
        if (SecureStore(context).read() == credentials) setEnabled(context, false)
    }
}

class AttentionRefreshWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val credentials = SecureStore(applicationContext).read() ?: return Result.success()
        if (!AttentionNotifications.enabledFor(applicationContext, credentials) || inputData.getString("scope") != AttentionNotifications.scope(credentials)) return Result.success()
        val client = CloudClient(credentials)
        return try {
            val state = client.state()
            if (!isStopped) AttentionNotifications.update(applicationContext, state, credentials)
            Result.success()
        } catch (error: Exception) {
            if ((error as? CloudException)?.status in listOf(401, 403)) AttentionNotifications.authorizationFailed(applicationContext, credentials)
            // A failed refresh must not create an activity. Existing ones have a system timeout.
            Result.success()
        } finally { client.close() }
    }
}

class AttentionUnpinReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        AttentionNotifications.setEnabled(context, false)
        PushRegistration.refreshCapabilities(context)
    }
}
