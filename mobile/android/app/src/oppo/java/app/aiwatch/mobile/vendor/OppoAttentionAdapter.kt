package app.aiwatch.mobile.vendor

import android.content.Context
import android.os.Bundle
import app.aiwatch.mobile.AttentionNotifications
import app.aiwatch.mobile.AttentionState
import app.aiwatch.mobile.SecureStore
import app.aiwatch.mobile.VendorAttentionAdapter
import app.aiwatch.mobile.VendorPush
import com.oplus.pantanal.seedling.SeedlingCardWidgetProvider
import com.oplus.pantanal.seedling.bean.SeedlingCard
import com.oplus.pantanal.seedling.intelligent.IntelligentData
import com.oplus.pantanal.seedling.update.SeedlingCardOptions
import com.oplus.pantanal.seedling.util.SeedlingTool
import org.json.JSONObject

/** The event/field names are supplied by the approved service and its UPK. */
class OppoAttentionAdapter : VendorAttentionAdapter {
    private fun value(context: Context, key: String) = VendorPush.configuredValue(context, "aiwatch.oppo.$key")
    override fun configured(context: Context): Boolean = runCatching {
        value(context, "serviceId").isNotBlank() && value(context, "eventCode").toInt() > 0 &&
            listOf("updateEvent", "endEvent", "inputCountKey", "approvalCountKey", "providerKey", "expiresAtKey").all { value(context, it).isNotBlank() } &&
            SeedlingTool.isSupportFluidCloud(context)
    }.getOrDefault(false)
    override fun update(context: Context, state: AttentionState) {
        if (!configured(context)) return
        val credentials = SecureStore(context).read() ?: return
        if (!AttentionNotifications.enabledFor(context, credentials) || !state.live(System.currentTimeMillis())) return
        val data = payload(context, state)
        context.getSharedPreferences("oppo_attention", Context.MODE_PRIVATE).edit()
            .putString("scope", AttentionNotifications.scope(credentials)).putString("state", data.toString())
            .putLong("expiresAt", state.expiresAt).apply()
        SeedlingTool.updateIntelligentData(context, IntelligentData(System.currentTimeMillis(), value(context, "eventCode").toInt(),
            value(context, "updateEvent"), data, null, SeedlingCardOptions(), "aiwatch-attention"))
    }
    override fun end(context: Context) {
        val prefs = context.getSharedPreferences("oppo_attention", Context.MODE_PRIVATE)
        if (!prefs.contains("state")) return
        prefs.edit().clear().apply()
        if (!configured(context)) return
        val now = System.currentTimeMillis() / 1000
        SeedlingTool.updateIntelligentData(context, IntelligentData(System.currentTimeMillis(), value(context, "eventCode").toInt(),
            value(context, "endEvent"), payload(context, AttentionState(0, 0, "none", now, now)), null, SeedlingCardOptions(), "aiwatch-attention"))
    }
    private fun payload(context: Context, state: AttentionState) = JSONObject()
        .put(value(context, "inputCountKey"), state.inputCount).put(value(context, "approvalCountKey"), state.approvalCount)
        .put(value(context, "providerKey"), state.providerName()).put(value(context, "expiresAtKey"), state.expiresAt)
}

/** Provider is used only when the approved OPPO SDK/UPK integration is packaged. */
class OppoAttentionProvider : SeedlingCardWidgetProvider() {
    private fun update(context: Context, card: SeedlingCard) {
        if (card.serviceId != VendorPush.configuredValue(context, "aiwatch.oppo.serviceId")) return
        val credentials = SecureStore(context).read() ?: return
        if (!AttentionNotifications.enabledFor(context, credentials)) return
        val prefs = context.getSharedPreferences("oppo_attention", Context.MODE_PRIVATE)
        if (prefs.getString("scope", null) != AttentionNotifications.scope(credentials) || prefs.getLong("expiresAt", 0) <= System.currentTimeMillis() / 1000) return
        val data = runCatching { JSONObject(prefs.getString("state", "") ?: "") }.getOrNull() ?: return
        updateData(card, data, SeedlingCardOptions())
    }
    override fun onCardCreate(context: Context, card: SeedlingCard) = update(context, card)
    override fun onShow(context: Context, card: SeedlingCard) = update(context, card)
    override fun onHide(context: Context, card: SeedlingCard) = Unit
    override fun onDestroy(context: Context, card: SeedlingCard) = Unit
    override fun onSubscribed(context: Context, card: SeedlingCard) = update(context, card)
    override fun onUnSubscribed(context: Context, card: SeedlingCard) = Unit
    override fun onUpdateData(context: Context, card: SeedlingCard, data: Bundle) = update(context, card)
    override fun onCardObserve(context: Context, action: String, cards: List<SeedlingCard>) = cards.forEach { update(context, it) }
}
