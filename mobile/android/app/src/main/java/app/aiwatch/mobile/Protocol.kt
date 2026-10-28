package app.aiwatch.mobile

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.util.UUID

data class Credentials(val server: String, val token: String) {
    companion object {
        fun validate(server: String, token: String): Credentials {
            val uri = URI(server.trim())
            require(uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrEmpty() && uri.userInfo == null && uri.query == null && uri.fragment == null && uri.path in listOf("", "/"))
            require(token.length in 32..512 && token.all { it.code in 33..126 })
            return Credentials("https:" + server.trim().substringAfter(':').trimEnd('/'), token)
        }
    }
}
data class Quota(val model: String, val period: String, val remaining: Double?, val stale: Boolean)
data class Provider(val id: String, val connection: String, val activity: String, val active: Int, val waiting: String?, val quotas: List<Quota>)
data class Option(val label: String, val description: String)
data class Question(val id: String, val header: String, val question: String, val options: List<Option>, val other: Boolean, val secret: Boolean)
data class PendingRequest(val id: String, val provider: String, val kind: String, val title: String, val detail: String, val expires: Long, val questions: List<Question>)
data class CommandStatus(val id: String, val requestId: String, val status: String, val error: String)
data class InboxAlert(val id: String, val type: String, val provider: String, val requestId: String?, val createdAt: Long, val active: Boolean)
data class CloudState(val online: Boolean, val receivedAt: Long, val sample: Boolean, val stale: Boolean, val limited: Boolean, val providers: List<Provider>, val requests: List<PendingRequest>, val commands: List<CommandStatus>, val alerts: List<InboxAlert> = emptyList(), val wire: JSONObject? = null, val attention: AttentionState? = null) {
    fun fresh(now: Long) = online && receivedAt > 0 && now - receivedAt in -5_000..24_999
    companion object {
        fun parse(text: String): CloudState {
            require(text.toByteArray().size <= 512 * 1024)
            val root = JSONObject(text); val snapshot = root.optJSONObject("snapshot")
            return CloudState(root.getBoolean("online"), root.optLong("receivedAt", 0), snapshot?.optBoolean("sample") == true, snapshot?.optBoolean("stale") == true, snapshot?.optBoolean("limited") == true,
                snapshot?.optJSONArray("p").objects().map { p -> Provider(p.getString("i"), p.getString("c"), p.getString("a"), p.getInt("n"), p.optionalString("w"),
                    p.optJSONArray("q").objects().map { q -> Quota(q.getString("m"), q.getString("p"), if (q.isNull("r")) null else q.getDouble("r"), q.optBoolean("s")) }) },
                snapshot?.optJSONArray("requests").objects().map { r -> PendingRequest(r.getString("id"), r.getString("provider"), r.getString("kind"), r.getString("title"), r.getString("detail"), r.getLong("expiresAt"),
                    r.optJSONArray("questions").objects().map { q -> Question(q.getString("id"), q.optString("header", tr("回答")), q.getString("question"),
                        q.optJSONArray("options").objects().map { o -> Option(o.getString("label"), o.optString("description", "")) }, q.optBoolean("isOther", true), q.optBoolean("isSecret", false)) }) },
                root.optJSONArray("commands").objects().map { c -> CommandStatus(c.getString("id"), c.optString("requestId", ""), c.getString("status"), c.optString("error", "")) },
                root.optJSONArray("alerts").objects().takeLast(50).map { a -> InboxAlert(a.getString("id"), a.getString("type"), a.getString("provider"), a.optionalString("requestId"), a.getLong("createdAt"), a.getBoolean("active")) }, root,
                root.optJSONObject("attention")?.let { AttentionState.parse(it) })
        }
    }
}
fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).map { getJSONObject(it) }
fun JSONObject.optionalString(key: String): String? = if (has(key) && !isNull(key)) getString(key) else null
fun makeCommand(request: PendingRequest, kind: String, answers: Map<String, String>, text: String, id: String = UUID.randomUUID().toString()): JSONObject {
    require(kind in listOf("answer", "approve", "deny"))
    require((request.kind == "input") == (kind == "answer"))
    val result = JSONObject().put("id", id).put("requestId", request.id).put("kind", kind)
    if (kind == "answer") {
        if (request.questions.isEmpty()) { require(text.isNotBlank() && text.length <= 4000); result.put("answer", text) }
        else {
            val map = JSONObject()
            request.questions.forEach { question ->
                val answer = answers[question.id] ?: ""
                require(!question.secret && answer.isNotBlank() && answer.length <= 4000)
                require(question.other || question.options.isEmpty() || question.options.any { it.label == answer })
                map.put(question.id, JSONObject().put("answers", JSONArray().put(answer)))
            }
            result.put("answers", map)
        }
    }
    return result
}
fun statusLabel(status: String) = mapOf("queued" to tr("已排队"), "delivered" to tr("已送达桌面，等待确认"), "succeeded" to tr("桌面已确认完成"), "failed" to tr("操作失败"), "expired" to tr("已过期"))[status] ?: status
fun operationLabel(kind: String) = mapOf("approve" to tr("批准"), "deny" to tr("拒绝"), "answer" to tr("发送回答"))[kind] ?: kind

private val uuidPattern = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
data class BridgeMessage(val id: String, val type: String, val value: JSONObject)
fun parseBridgeMessage(text: String): BridgeMessage {
    require(text.toByteArray(Charsets.UTF_8).size <= 128 * 1024)
    val value = JSONObject(text)
    val id = value.getString("id"); require(uuidPattern.matches(id))
    val type = value.getString("type")
    val allowed = when (type) {
        "ready", "refresh", "logout", "notifications" -> setOf("id", "type")
        "liveUpdates" -> setOf("id", "type", "enabled")
        "configure" -> setOf("id", "type", "server", "token")
        "submit" -> setOf("id", "type", "command")
        else -> throw IllegalArgumentException("unsupported-bridge-command")
    }
    require(value.keys().asSequence().all { it in allowed })
    if (type == "configure") Credentials.validate(value.getString("server"), value.getString("token"))
    if (type == "liveUpdates") require(value.opt("enabled") is Boolean)
    if (type == "submit") require(value.opt("command") is JSONObject)
    return BridgeMessage(id, type, value)
}
fun validateBridgeCommand(request: PendingRequest, value: JSONObject): JSONObject {
    require(value.keys().asSequence().all { it in setOf("id", "requestId", "kind", "answer", "answers") })
    val id = value.getString("id"); require(uuidPattern.matches(id))
    require(value.getString("requestId") == request.id)
    val kind = value.getString("kind")
    val answers = mutableMapOf<String, String>()
    var answer = ""
    if (kind == "answer") {
        if (request.questions.isEmpty()) {
            require(!value.has("answers") && value.opt("answer") is String)
            answer = value.getString("answer")
        } else {
            require(!value.has("answer"))
            val source = value.getJSONObject("answers")
            require(source.keys().asSequence().toSet() == request.questions.map { it.id }.toSet())
            request.questions.forEach { question ->
                val item = source.getJSONObject(question.id)
                require(item.keys().asSequence().toSet() == setOf("answers"))
                val list = item.getJSONArray("answers")
                require(list.length() == 1 && list.get(0) is String)
                answers[question.id] = list.getString(0)
            }
        }
    } else require(!value.has("answer") && !value.has("answers"))
    return makeCommand(request, kind, answers, answer, id)
}
