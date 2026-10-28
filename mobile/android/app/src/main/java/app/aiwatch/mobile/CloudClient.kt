package app.aiwatch.mobile

import android.os.Handler
import android.os.Looper
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class CloudException(val status: Int) : IOException()
class CloudClient(val credentials: Credentials) {
    companion object {
        // Conscrypt may send TLS close_notify while evicting a pooled socket.
        // Lifecycle callbacks must never perform that work on the UI thread.
        private val cleanup = Executors.newSingleThreadExecutor()
    }
    val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(35, TimeUnit.SECONDS).build()
    fun request(path: String): Request.Builder = Request.Builder().url(credentials.server + path)
        .header("Authorization", "Bearer " + credentials.token).header("Accept", "application/json")
    fun json(path: String, method: String = "GET", body: JSONObject? = null): String {
        val builder = request(path)
        if (method != "GET") builder.method(method, body?.toString()?.toRequestBody("application/json".toMediaType()))
        val call = http.newCall(builder.build())
        call.timeout().timeout(20, TimeUnit.SECONDS)
        return call.execute().use { response ->
            if (!response.isSuccessful) throw CloudException(response.code)
            val source = response.body?.source() ?: return@use "{}"
            source.request(512L * 1024 + 1)
            if (source.buffer.size > 512 * 1024) throw IOException()
            source.readUtf8().ifBlank { "{}" }
        }
    }
    fun state() = CloudState.parse(json("/v1/state"))
    fun pair(installation: String): Credentials {
        val result = JSONObject(json("/v1/pair", "POST", JSONObject().put("id", installation).put("name", "Android").put("platform", "android")))
        check(result.getString("deviceId") == installation)
        return Credentials.validate(credentials.server, result.getString("token"))
    }
    fun revokePair() {
        try { json("/v1/pair", "DELETE") }
        catch (error: CloudException) { if (error.status !in listOf(401, 403)) throw error }
    }
    fun close() { cleanup.execute { http.dispatcher.cancelAll(); http.connectionPool.evictAll() } }
}

class CloudController(private val client: CloudClient, private val changed: () -> Unit) {
    @Volatile var state: CloudState? = null; private set
    @Volatile var connected = false; private set
    @Volatile var message = ""; private set
    @Volatile private var receivedLocally = 0L
    @Volatile private var running = false
    @Volatile private var connecting = false
    @Volatile private var refreshing = false
    private var source: EventSource? = null
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private var generation = 0
    private val tick = object : Runnable {
        override fun run() {
            if (!running) return
            if (!connected) { refresh(); openEvents() }
            changed(); main.postDelayed(this, 5000)
        }
    }
    val online get() = state?.fresh(System.currentTimeMillis()) == true && System.currentTimeMillis() - receivedLocally < 25_000
    fun canAct(request: PendingRequest) = online && state?.sample != true && state?.stale != true && request.expires > System.currentTimeMillis() && state?.requests?.any { it.id == request.id } == true
    fun start() {
        if (running) return
        running = true; generation++; refresh(); openEvents(); main.postDelayed(tick, 5000)
    }
    fun stop() {
        running = false; generation++; source = null; connected = false; connecting = false
        receivedLocally = 0; main.removeCallbacks(tick); client.close(); worker.shutdownNow()
    }
    private fun notifyChanged() { main.post { if (running) changed() } }
    private fun accept(value: CloudState, stamp: Int) {
        if (!running || stamp != generation) return
        state = value; receivedLocally = System.currentTimeMillis(); message = ""; notifyChanged()
    }
    fun refresh() {
        if (!running || refreshing) return
        refreshing = true; val stamp = generation
        worker.execute {
            try { accept(client.state(), stamp) }
            catch (error: Exception) { if (running && stamp == generation) {
                if ((error as? CloudException)?.status in listOf(401, 403)) receivedLocally = 0
                message = errorMessage(error); notifyChanged()
            } }
            finally { refreshing = false }
        }
    }
    private fun openEvents() {
        if (!running || connecting || connected) return
        connecting = true; val stamp = generation
        source = EventSources.createFactory(client.http).newEventSource(client.request("/v1/events").header("Accept", "text/event-stream").build(), object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                if (!running || stamp != generation) { eventSource.cancel(); return }
                connected = true; connecting = false; notifyChanged()
            }
            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                if (type != "state" || !running || stamp != generation) return
                try { accept(CloudState.parse(data), stamp) }
                catch (_: Exception) { eventSource.cancel(); connected = false; connecting = false; message = tr("同步数据无法识别"); notifyChanged() }
            }
            override fun onClosed(eventSource: EventSource) { if (stamp == generation) { connected = false; connecting = false; notifyChanged() } }
            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                if (!running || stamp != generation) return
                connected = false; connecting = false
                if (response?.code in listOf(401, 403)) receivedLocally = 0
                message = if (response?.code in listOf(401, 403)) tr("手机令牌无效或已撤销") else tr("实时连接中断，正在重连")
                response?.close(); notifyChanged()
            }
        })
    }
    fun submit(request: PendingRequest, command: JSONObject, completion: (Boolean, String) -> Unit) {
        if (!canAct(request)) { completion(false, tr("桌面离线或请求已失效，请刷新")); return }
        val stamp = generation
        worker.execute {
            try {
                val response = JSONObject(client.json("/v1/commands", "POST", command))
                if (running && stamp == generation) main.post { completion(true, tr("操作状态：") + statusLabel(response.getString("status"))) }
                refresh()
            } catch (error: Exception) { if (running && stamp == generation) main.post { completion(false, errorMessage(error)) } }
        }
    }
}
fun errorMessage(error: Exception) = when ((error as? CloudException)?.status) {
    401, 403 -> tr("手机令牌无效或已撤销")
    409, 410 -> tr("请求已处理或状态已变化，请刷新确认")
    429 -> tr("请求过于频繁，请稍后再试")
    null -> tr("无法连接服务器，请检查网络或返回数据")
    else -> tr("服务器拒绝操作，请刷新并确认请求仍有效")
}
