package app.aiwatch.mobile.vendor

import android.content.Context
import android.content.Intent
import app.aiwatch.mobile.AttentionNotifications
import app.aiwatch.mobile.MainActivity
import app.aiwatch.mobile.PushRegistration
import app.aiwatch.mobile.VendorPush
import app.aiwatch.mobile.VendorPushAdapter
import app.aiwatch.mobile.tr
import com.vivo.push.PushClient
import com.vivo.push.PushConfig
import com.vivo.push.listener.IPushQueryActionListener
import com.vivo.push.model.UnvarnishedMessage
import com.vivo.push.model.UPSNotificationMessage
import com.vivo.push.sdk.OpenClientPushMessageReceiver

/** Official VPush 4.1.7.0 API. Initialization requires explicit app push consent. */
class VivoPushAdapter : VendorPushAdapter {
    override val transport = "vpush"
    override fun configured(context: Context) = VendorPush.configuredValue(context, "app_id").isNotBlank() && VendorPush.configuredValue(context, "api_key").isNotBlank()
    override fun enable(context: Context, status: (String) -> Unit) {
        if (!PushRegistration.consented(context) || !configured(context)) return
        try {
            val client = PushClient.getInstance(context)
            client.initialize(PushConfig.Builder().agreePrivacyStatement(true).build())
            if (!client.isSupport) { status(tr("推送登记失败，返回前台后重试")); return }
            client.turnOnPush { result -> if (result == 0) token(context, status) else status(tr("推送登记失败，返回前台后重试")) }
        } catch (_: Exception) { status(tr("推送登记失败，返回前台后重试")) }
    }
    private fun token(context: Context, status: (String) -> Unit = {}) {
        PushClient.getInstance(context).getRegId(object : IPushQueryActionListener {
            override fun onSuccess(regId: String) { PushRegistration.register(context, regId, status, "vpush") }
            override fun onFail(error: Int?) { status(tr("推送登记失败，返回前台后重试")) }
        })
    }
    override fun refreshToken(context: Context) { if (PushRegistration.consented(context)) runCatching { token(context) } }
    override fun disable(context: Context) { runCatching { PushClient.getInstance(context).turnOffPush { } } }
}

class VivoPushReceiver : OpenClientPushMessageReceiver() {
    override fun onReceiveRegId(context: Context, regId: String) { PushRegistration.register(context, regId, transport = "vpush") }
    override fun onTransmissionMessage(context: Context, message: UnvarnishedMessage) {
        // No remote count, title, command or answer is trusted here.
        AttentionNotifications.refreshFromPush(context)
    }
    override fun onNotificationMessageClicked(context: Context, message: UPSNotificationMessage) {
        context.startActivity(Intent(context, MainActivity::class.java).setAction(MainActivity.OPEN_ATTENTION)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
    }
}
