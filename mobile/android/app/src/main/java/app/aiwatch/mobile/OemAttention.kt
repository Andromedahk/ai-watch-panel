package app.aiwatch.mobile

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import org.json.JSONObject

interface VendorAttentionAdapter {
    fun configured(context: Context): Boolean
    fun update(context: Context, state: AttentionState)
    fun end(context: Context)
}

/** Public vendor interfaces, gated by the application's approved scene and OS permission. */
object OemAttention {
    const val VIVO_TAG = "VIVO_SUPERX_TAG"
    private var checkedAt = 0L
    private var lastMode: String? = null
    private val oppo: VendorAttentionAdapter? by lazy {
        runCatching { Class.forName("app.aiwatch.mobile.vendor.OppoAttentionAdapter").getDeclaredConstructor().newInstance() as VendorAttentionAdapter }.getOrNull()
    }
    fun mode(context: Context): String? {
        val now = System.currentTimeMillis()
        if (now - checkedAt < 30000) return lastMode
        checkedAt = now
        lastMode = when (Build.MANUFACTURER.lowercase()) {
            "xiaomi" -> if (xiaomiAllowed(context)) "mipush" else null
            "vivo" -> if (vivoAllowed(context)) "vpush" else null
            "oppo", "oneplus", "realme" -> if (oppo?.configured(context) == true) "oppo-local" else null
            else -> null
        }
        return lastMode
    }
    private fun xiaomiAllowed(context: Context): Boolean {
        if (VendorPush.configuredValue(context, "aiwatch.xiaomi.business").isBlank() || VendorPush.configuredValue(context, "com.xiaomi.xms.APP_ID").isBlank()) return false
        return runCatching {
            val protocol = Settings.System.getInt(context.contentResolver, "notification_focus_protocol", 0)
            val props = Class.forName("android.os.SystemProperties")
            val island = props.getMethod("getBoolean", String::class.java, Boolean::class.javaPrimitiveType).invoke(null, "persist.sys.feature.island", false) as Boolean
            protocol >= 3 && island && context.contentResolver.call(Uri.parse("content://miui.statusbar.notification.public"), "canShowFocus", null,
                Bundle().apply { putString("package", context.packageName) })?.getBoolean("canShowFocus", false) == true
        }.getOrDefault(false)
    }
    private fun vivoAllowed(context: Context): Boolean {
        val scene = VendorPush.configuredValue(context, "aiwatch.vivo.scene")
        if (scene.isBlank()) return false
        return runCatching {
            val manager = context.getSystemService(NotificationManager::class.java)
            val args = arrayOf(context.packageName, scene)
            manager.javaClass.getMethod("getSceneStatus", String::class.java, String::class.java).invoke(manager, *args) == true &&
                manager.javaClass.getMethod("isSupportCustomFun", String::class.java, String::class.java).invoke(manager, *args) == true
        }.getOrDefault(false)
    }
    fun decorate(context: Context, notification: Notification, state: AttentionState, open: PendingIntent, title: String, body: String, mode: String?, created: Boolean) {
        when (mode) {
            "mipush" -> {
                val iconKey = "miui.focus.pic_attention"
                val pic = JSONObject().put("type", 1).put("pic", iconKey)
                val island = JSONObject().put("islandProperty", 1).put("islandTimeout", (state.expiresAt - System.currentTimeMillis() / 1000).coerceIn(1, 90))
                    .put("bigIslandArea", JSONObject().put("imageTextInfoLeft", JSONObject().put("type", 1).put("picInfo", pic)
                        .put("textInfo", JSONObject().put("title", state.total.toString()).put("content", body))))
                    .put("smallIslandArea", JSONObject().put("picInfo", pic))
                val params = JSONObject().put("business", VendorPush.configuredValue(context, "aiwatch.xiaomi.business"))
                    .put("protocol", 1).put("updatable", true).put("islandFirstFloat", false).put("enableFloat", false)
                    .put("timeout", 2).put("ticker", body).put("aodTitle", body).put("param_island", island)
                    .put("baseInfo", JSONObject().put("type", 2).put("title", title).put("content", body))
                notification.extras.putString("miui.focus.param", JSONObject().put("param_v2", params).toString())
                notification.extras.putBundle("miui.focus.pics", Bundle().apply { putParcelable(iconKey, Icon.createWithResource(context, R.drawable.ai_watch_live_icon)) })
            }
            "vpush" -> {
                val prefix = "notification.superx."
                val icon = Icon.createWithResource(context, R.drawable.ai_watch_live_icon)
                notification.extras.apply {
                    putInt(prefix + "operation", if (created) 1 else 0); putBoolean(prefix + "showNotify", true); putInt(prefix + "template", 4)
                    putString(prefix + "scene", VendorPush.configuredValue(context, "aiwatch.vivo.scene")); putParcelable(prefix + "clickResp", open)
                    putBundle(prefix + "baseInfos", Bundle().apply {
                        putCharSequence(prefix + "baseInfos.title", title); putCharSequence(prefix + "baseInfos.content", body)
                        putInt(prefix + "baseInfos.subInfo", 4); putParcelableArrayList(prefix + "baseInfos.subImageList", arrayListOf(icon))
                    })
                    putBundle(prefix + "infos", Bundle())
                    putBundle(prefix + "shortInfos", Bundle().apply {
                        putParcelable(prefix + "shortInfos.image", icon); putParcelable(prefix + "shortInfos.imageClickResp", open)
                        putString(prefix + "shortInfos.describeShort", title); putString(prefix + "shortInfos.coreInfoShort", body)
                    })
                    putBundle(prefix + "capsule", Bundle().apply {
                        putInt(prefix + "capsule.state", 1); putParcelable(prefix + "capsule.icon", icon)
                        putString(prefix + "capsule.content", state.total.toString()); putInt(prefix + "capsule.showTime", 90)
                    })
                    putBundle(prefix + "island", Bundle().apply {
                        putInt("island.superx.leftTemplate", 1); putInt("island.superx.rightTemplate", 4)
                        putBundle("island.superx.leftInfo", Bundle().apply { putParcelable("island.superx.leftInfo.icon", icon); putString("island.superx.leftInfo.content", title) })
                        putBundle("island.superx.rightInfo", Bundle().apply { putString("island.superx.rightInfo.content", state.total.toString()) })
                        putInt("island.superx.islandClick", 1); putParcelable("island.superx.clickResp", open)
                        putInt("island.superx.showTime", (state.expiresAt - System.currentTimeMillis() / 1000).coerceIn(1, 90).toInt())
                    })
                }
            }
            "oppo-local" -> oppo?.update(context, state)
        }
    }
    fun end(context: Context) { runCatching { oppo?.end(context) } }
}
