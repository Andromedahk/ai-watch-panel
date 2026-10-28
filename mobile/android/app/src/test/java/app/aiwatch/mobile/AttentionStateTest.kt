package app.aiwatch.mobile

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AttentionStateTest {
    private fun summary() = JSONObject("""{"inputCount":2,"approvalCount":1,"provider":"codex","updatedAt":1000,"expiresAt":1100}""")
    @Test fun summaryOnlyContainsCountsAndFixedProviderNames() {
        val value = AttentionState.parse(summary())
        assertEquals(3, value.total); assertEquals("Codex", value.providerName())
        assertTrue(value.live(1_010_000)); assertFalse(value.live(1_100_000)); assertFalse(value.live(900_000))
        assertEquals("AI Watch", AttentionState.parse(summary().put("provider", "/private/task-title")).providerName())
        assertThrows(Exception::class.java) { AttentionState.parse(summary().put("question", "private question")) }
    }
    @Test fun invalidCountsTimestampsAndUnboundedLeasesFailClosed() {
        for ((key, bad) in listOf("inputCount" to -1, "approvalCount" to 1.5, "inputCount" to "2", "inputCount" to 999,
            "expiresAt" to 999, "expiresAt" to 1601, "updatedAt" to 1_000_000_000_000L)) {
            assertThrows(Exception::class.java) { AttentionState.parse(summary().put(key, bad)) }
        }
        assertFalse(AttentionState.parse(summary().put("inputCount", 0).put("approvalCount", 0)).live(1_010_000))
    }
    @Test fun cloudStateClearsMonitorForOfflineSampleStaleAndEmptySummaries() {
        val state = CloudState.parse("""{"online":true,"receivedAt":1000000,"attention":${summary()}}""")
        assertEquals(3, AttentionState.from(state, 1_010_000)?.total)
        assertNull(AttentionState.from(state.copy(online = false), 1_010_000))
        assertNull(AttentionState.from(state.copy(sample = true), 1_010_000))
        assertNull(AttentionState.from(state.copy(stale = true), 1_010_000))
        assertNull(AttentionState.from(state, 1_025_000))
        assertNull(AttentionState.from(state.copy(attention = state.attention!!.copy(inputCount = 0, approvalCount = 0)), 1_010_000))
    }
    @Test fun olderServersExcludeExpiredOrAlreadySubmittedRequests() {
        val request = PendingRequest("pending", "codex", "input", "private-title", "private-detail", 1_100_000, emptyList())
        val state = CloudState(true, 1_000_000, false, false, false, emptyList(), listOf(request), emptyList())
        assertEquals(1, AttentionState.from(state, 1_010_000)?.inputCount)
        assertNull(AttentionState.from(state.copy(commands = listOf(CommandStatus("command", "pending", "queued", ""))), 1_010_000))
        assertNull(AttentionState.from(state.copy(requests = listOf(request.copy(expires = 1_009_000))), 1_010_000))
    }
    @Test fun monitoringRequiresExplicitBooleanBridgeCapability() {
        val id = "00000000-0000-4000-8000-000000000001"
        assertTrue(parseBridgeMessage("""{"id":"$id","type":"liveUpdates","enabled":true}""").value.getBoolean("enabled"))
        for (payload in listOf("""{"id":"$id","type":"liveUpdates"}""", """{"id":"$id","type":"liveUpdates","enabled":"true"}""", """{"id":"$id","type":"liveUpdates","enabled":true,"scene":"TAXI"}"""))
            assertThrows(Exception::class.java) { parseBridgeMessage(payload) }
    }
}
