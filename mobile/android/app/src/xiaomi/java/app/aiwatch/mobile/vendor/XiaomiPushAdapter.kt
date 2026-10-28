package app.aiwatch.mobile.vendor

import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Process
import app.aiwatch.mobile.AttentionNotifications
import app.aiwatch.mobile.MainActivity
import app.aiwatch.mobile.PushRegistration
import app.aiwatch.mobile.VendorPush
import app.aiwatch.mobile.VendorPushAdapter
import app.aiwatch.mobile.tr
import com.xiaomi.mipush.sdk.MiPushClient
import com.xiaomi.mipush.sdk.MiPushCommandMessage
import com.xiaomi.mipush.sdk.MiPushMessage
import com.xiaomi.mipush.sdk.PushMessageReceiver
import com.xiaomi.mipush.sdk.ErrorCode

/** Optional source: requires the official MiPush AAR obtained from Xiaomi's console. */
class XiaomiPushAdapter : VendorPushAdapter {
    override val transport = "mipush"
    override fun configured(context: Context) = VendorPush.configuredValue(context, "aiwatch.xiaomi.appId").isNotBlank() && VendorPush.configuredValue(context, "aiwatch.xiaomi.appKey").isNotBlank()
    override fun enable(context: Context, status: (String) -> Unit) {
        if (!PushRegistration.consented(context) || !configured(context) || !mainProcess(context)) return
        try {
            MiPushClient.registerPush(context, VendorPush.configuredValue(context, "aiwatch.xiaomi.appId"), VendorPush.configuredValue(context, "aiwatch.xiaomi.appKey"))
            val token = MiPushClient.getRegId(context)
            if (!token.isNullOrBlank()) PushRegistration.register(context, token, status, "mipush")
        } catch (_: Exception) { status(tr("推送登记失败，返回前台后重试")) }
    }
    override fun refreshToken(context: Context) { if (PushRegistration.consented(context)) MiPushClient.getRegId(context)?.takeIf { it.isNotBlank() }?.let { PushRegistration.register(context, it, transport = "mipush") } }
    override fun disable(context: Context) { if (mainProcess(context)) runCatching { MiPushClient.unregisterPush(context) } }
    private fun mainProcess(context: Context) = if (Build.VERSION.SDK_INT >= 28) Application.getProcessName() == context.packageName else
        context.getSystemService(ActivityManager::class.java).runningAppProcesses?.any { it.pid == Process.myPid() && it.processName == context.packageName } == true
}

class XiaomiPushReceiver : PushMessageReceiver() {
    private fun registration(context: Context, message: MiPushCommandMessage) {
        if (message.command == MiPushClient.COMMAND_REGISTER && message.resultCode == ErrorCode.SUCCESS.toLong())
            message.commandArguments?.firstOrNull()?.let { PushRegistration.register(context, it, transport = "mipush") }
    }
    override fun onReceiveRegisterResult(context: Context, message: MiPushCommandMessage) { registration(context, message) }
    override fun onCommandResult(context: Context, message: MiPushCommandMessage) { registration(context, message) }
    override fun onReceivePassThroughMessage(context: Context, message: MiPushMessage) { AttentionNotifications.refreshFromPush(context) }
    override fun onNotificationMessageClicked(context: Context, message: MiPushMessage) {
        context.startActivity(Intent(context, MainActivity::class.java).setAction(MainActivity.OPEN_ATTENTION)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
    }
}
