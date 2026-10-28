package app.aiwatch.mobile

import org.json.JSONObject

/** Counts and fixed provider identifiers only; never titles, commands or answers. */
data class AttentionState(val inputCount: Int, val approvalCount: Int, val provider: String, val updatedAt: Long, val expiresAt: Long) {
    val total get() = inputCount + approvalCount
    fun live(now: Long) = total > 0 && updatedAt * 1000 <= now + 5000 && expiresAt * 1000 > now
    fun providerName() = mapOf("codex" to "Codex", "claude" to "Claude", "antigravity" to "Antigravity",
        "deepseek" to "DeepSeek", "zcode" to "Zcode", "kimi" to "Kimi", "qwen" to "Qwen", "workbuddy" to "WorkBuddy")[provider] ?: "AI Watch"
    companion object {
        fun parse(value: JSONObject): AttentionState {
            require(value.keys().asSequence().all { it in setOf("inputCount", "approvalCount", "provider", "updatedAt", "expiresAt") })
            fun integer(key: String, max: Long): Long {
                val raw = value.get(key)
                require(raw is Number && raw.toDouble().isFinite() && raw.toDouble() == raw.toLong().toDouble() && raw.toLong() in 0..max)
                return raw.toLong()
            }
            val input = integer("inputCount", 999).toInt(); val approval = integer("approvalCount", 999).toInt()
            require(input + approval <= 999)
            val updated = integer("updatedAt", 4_102_444_800); val expires = integer("expiresAt", 4_102_444_800)
            require(expires >= updated && expires - updated <= 600)
            val provider = value.getString("provider")
            // Unknown IDs never become arbitrary notification text.
            return AttentionState(input, approval, provider.takeIf { it in setOf("codex", "claude", "antigravity", "deepseek", "zcode", "kimi", "qwen", "workbuddy") } ?: "multiple", updated, expires)
        }
        fun from(state: CloudState, now: Long): AttentionState? {
            if (!state.fresh(now) || state.sample || state.stale) return null
            state.attention?.let { return it.takeIf { value -> value.live(now) } }
            // Older servers may omit attention. Derive the same private summary.
            val pending = state.requests.filter { request -> request.expires > now && state.commands.none { it.requestId == request.id } }
            if (pending.isEmpty()) return null
            return AttentionState(pending.count { it.kind == "input" }, pending.count { it.kind == "approval" },
                pending.map { it.provider }.distinct().singleOrNull() ?: "multiple", now / 1000,
                minOf(pending.minOf { it.expires } / 1000, now / 1000 + 600))
        }
    }
}
