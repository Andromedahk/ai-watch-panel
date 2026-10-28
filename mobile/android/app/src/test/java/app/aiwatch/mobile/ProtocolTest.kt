package app.aiwatch.mobile

import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject

class ProtocolTest {
    @Test fun explicitFullContentObjectSurvivesNativeWireWithoutChangingAnswerMetadata() {
        val input = """{"online":true,"receivedAt":100000,"snapshot":{"sample":false,"p":[],"requests":[{"id":"request","provider":"codex","kind":"input","title":"codex.input","detail":"input","expiresAt":200000,"questions":[{"id":"q","header":"question.1","question":"review.questionOnDesktop","options":[{"label":"option.1","description":""}]}],"fullContent":{"command":"git status","cwd":"/workspace/demo","reason":"Review changes","questions":[{"id":"q","header":"Continue","question":"Continue this task?","options":[{"label":"Continue","description":"Proceed once"}]}]}}]}}"""
        val state = CloudState.parse(input)
        val full = state.wire!!.getJSONObject("snapshot").getJSONArray("requests").getJSONObject(0).getJSONObject("fullContent")
        assertEquals("git status", full.getString("command"))
        assertEquals("Proceed once", full.getJSONArray("questions").getJSONObject(0).getJSONArray("options").getJSONObject(0).getString("description"))
        assertEquals("option.1", state.requests[0].questions[0].options[0].label)
        assertEquals("review.questionOnDesktop", state.requests[0].questions[0].question)
    }
    @Test fun inboxSupportsAbsentAlertsAndResolvedEntriesWithoutRequests() {
        assertTrue(CloudState.parse("""{"online":false,"snapshot":null}""").alerts.isEmpty())
        val state = CloudState.parse("""{"online":true,"receivedAt":100000,"alerts":[{"id":"active","type":"input","provider":"codex","requestId":"pending","createdAt":90000,"active":true},{"id":"resolved","type":"low-quota","provider":"codex","createdAt":80000,"active":false}]}""")
        assertEquals(2, state.alerts.size)
        assertTrue(state.alerts[0].active)
        assertEquals("pending", state.alerts[0].requestId)
        assertFalse(state.alerts[1].active)
        assertNull(state.alerts[1].requestId)
        assertEquals("low-quota", state.alerts[1].type)
    }
    @Test fun unknownQuotaAndDeliveryAreNotSuccess() {
        val state = CloudState.parse("""{"online":true,"receivedAt":100000,"snapshot":{"p":[{"i":"codex","c":"ready","a":"waiting","n":1,"q":[{"m":"Codex","p":"5h","r":null,"s":true}]}],"requests":[],"sample":true},"commands":[{"id":"op","requestId":"r","status":"delivered"}]}""")
        assertNull(state.providers[0].quotas[0].remaining)
        assertTrue(state.providers[0].quotas[0].stale)
        assertTrue(state.sample)
        assertEquals("delivered", state.commands[0].status)
        assertTrue(state.fresh(110000)); assertFalse(state.fresh(126000)); assertFalse(state.fresh(90000))
    }
    @Test fun endpointsCannotRedirectCredentialsViaUserinfoOrQuery() {
        val credential = "x".repeat(32)
        assertEquals("https://example.invalid", Credentials.validate("https://example.invalid/", credential).server)
        assertEquals("https://example.invalid", Credentials.validate("HTTPS://example.invalid/", credential).server)
        for (server in listOf("http://example.invalid", "https://example.invalid/path", "https://name@example.invalid", "https://example.invalid?x=y", "https://example.invalid/#fragment")) {
            assertThrows(Exception::class.java) { Credentials.validate(server, credential) }
        }
        assertThrows(Exception::class.java) { Credentials.validate("https://example.invalid", credential + "\r\n") }
        assertThrows(Exception::class.java) { Credentials.validate("HTTPS：／／example.invalid", credential) }
    }
    @Test fun answerSchemaAndRequestKindAreValidated() {
        val question = Question("q", "Question", "Continue?", listOf(Option("Yes", "Proceed")), false, false)
        val request = PendingRequest("r", "codex", "input", "Question", "Context", 200000, listOf(question))
        val command = makeCommand(request, "answer", mapOf("q" to "Yes"), "", "operation")
        assertEquals("Yes", command.getJSONObject("answers").getJSONObject("q").getJSONArray("answers").getString(0))
        assertThrows(Exception::class.java) { makeCommand(request, "approve", emptyMap(), "") }
        assertThrows(Exception::class.java) { makeCommand(request, "answer", mapOf("q" to "Unexpected"), "") }
        assertThrows(Exception::class.java) { makeCommand(request.copy(questions = listOf(question.copy(secret = true))), "answer", mapOf("q" to "Yes"), "") }
    }
    @Test fun requestKeysNeverShowRawSourceText() {
        assertNotEquals("codex.input", requestTitle("codex.input"))
        assertNotEquals("option.1", requestLabel("option.1"))
        assertFalse(requestDetail("/private/sensitive-task").contains("sensitive-task"))
        assertEquals(tr("批准"), operationLabel("approve"))
        assertEquals(tr("拒绝"), operationLabel("deny"))
    }
    @Test fun nativeBridgeRejectsUnknownCapabilitiesAndMalformedCommands() {
        val id = "00000000-0000-4000-8000-000000000001"
        assertEquals("ready", parseBridgeMessage("""{"id":"$id","type":"ready"}""").type)
        for (payload in listOf("""{"id":"$id","type":"openUrl","url":"https://example.invalid"}""", """{"id":"$id","type":"ready","token":"secret"}""", """{"id":"bad","type":"ready"}"""))
            assertThrows(Exception::class.java) { parseBridgeMessage(payload) }
        val request = PendingRequest("r", "codex", "input", "codex.input", "input", 200000,
            listOf(Question("q", "question.1", "review.questionOnDesktop", listOf(Option("option.1", "")), false, false)))
        val command = JSONObject("""{"id":"$id","requestId":"r","kind":"answer","answers":{"q":{"answers":["option.1"]}}}""")
        assertEquals("option.1", validateBridgeCommand(request, command).getJSONObject("answers").getJSONObject("q").getJSONArray("answers").getString(0))
        assertThrows(Exception::class.java) { validateBridgeCommand(request, JSONObject(command.toString()).put("url", "https://example.invalid")) }
        assertThrows(Exception::class.java) { validateBridgeCommand(request, JSONObject(command.toString()).put("requestId", "other")) }
        val invalid = JSONObject(command.toString()); invalid.getJSONObject("answers").getJSONObject("q").getJSONArray("answers").put("option.2")
        assertThrows(Exception::class.java) { validateBridgeCommand(request, invalid) }
    }
}
