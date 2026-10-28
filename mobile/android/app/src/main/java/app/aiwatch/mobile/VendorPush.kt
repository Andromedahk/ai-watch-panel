package app.aiwatch.mobile

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build

/** Optional implementations are compiled only with the corresponding official SDK. */
interface VendorPushAdapter {
    val transport: String
    fun configured(context: Context): Boolean
    fun enable(context: Context, status: (String) -> Unit)
    fun refreshToken(context: Context)
    fun disable(context: Context)
}

object VendorPush {
    private val adapters: List<VendorPushAdapter> by lazy {
        listOf("app.aiwatch.mobile.vendor.VivoPushAdapter", "app.aiwatch.mobile.vendor.XiaomiPushAdapter").mapNotNull {
            runCatching { Class.forName(it).getDeclaredConstructor().newInstance() as VendorPushAdapter }.getOrNull()
        }
    }
    fun selected(context: Context) = adapters.firstOrNull { adapter ->
        val manufacturer = Build.MANUFACTURER.lowercase()
        (adapter.transport == "vpush" && manufacturer == "vivo" || adapter.transport == "mipush" && manufacturer == "xiaomi") && adapter.configured(context)
    }
    fun configuredValue(context: Context, key: String): String = runCatching {
        val value = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA).metaData?.get(key)
        when (value) { is String -> value; is Int -> context.getString(value); else -> "" }
    }.getOrDefault("")
}
