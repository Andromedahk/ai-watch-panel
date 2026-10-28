import Foundation

var checkCount = 0

func check(_ condition: @autoclosure () -> Bool, _ name: String) {
    guard condition() else { fatalError(name) }; checkCount += 1
}
func mustThrow(_ name: String, _ operation: () throws -> Void) {
    do { try operation(); fatalError("Expected rejection: " + name) } catch { checkCount += 1 }
}
let fixture = """
{"online":true,"receivedAt":100000,"deviceId":"sample-desktop","snapshot":{"p":[{"i":"codex","c":"ready","a":"waiting","n":1,"w":"input","q":[{"m":"Codex","p":"5h","r":null,"s":true}]}],"requests":[{"id":"request-1","provider":"codex","kind":"input","title":"Question","detail":"Choose","questions":[{"id":"q1","header":"Direction","question":"Continue?","options":[{"label":"Yes","description":"Proceed"}],"isOther":true}],"expiresAt":130000}],"sample":true},"commands":[{"id":"command-1","requestId":"request-1","status":"delivered"}]}
"""
let state = try JSONDecoder().decode(CloudState.self, from: Data(fixture.utf8))
check(state.snapshot?.p.first?.q.first?.r == nil, "Unknown quota stays unknown")
check(state.snapshot?.sample == true, "Sample marker retained")
check(state.commands[0].status == "delivered", "Delivery does not imply completion")
check(state.fresh(at: Date(timeIntervalSince1970: 110)), "Fresh")
check(!state.fresh(at: Date(timeIntervalSince1970: 126)), "Stale")
check(!state.fresh(at: Date(timeIntervalSince1970: 90)), "Future server time is not fresh")
var parser = SSEParser(); var events: [String] = []
for byte in Data((": ping\r\n\r\nevent: state\r\ndata: " + fixture + "\r\n\r\n").utf8) { if let value = try parser.feed(byte) { events.append(value) } }
check(events == [fixture], "SSE boundaries and comments")
var multiple = SSEParser(); var output: String?
for byte in "event: state\ndata: {\ndata: }\n\n".utf8 { if let value = try multiple.feed(byte) { output = value } }
check(output == "{\n}", "Multiline SSE data")
mustThrow("bounded event") { var bounded = SSEParser(); for _ in 0...512 * 1024 { _ = try bounded.feed(65) } }
let testCredential = String(repeating: "x", count: 32)
let validCredentials = try Credentials.validate(server: "https://example.invalid/", token: testCredential)
check(validCredentials.server == "https://example.invalid", "Canonical HTTPS")
let uppercase = try Credentials.validate(server: "HTTPS://example.invalid/", token: testCredential)
check(uppercase.server == "https://example.invalid", "HTTPS scheme is case-insensitive and canonical")
for server in ["http://example.invalid", "https://example.invalid/path", "https://example.invalid?secret=x", "https://name@example.invalid", "https://example.invalid/#fragment"] {
    mustThrow("unsafe endpoint") { _ = try Credentials.validate(server: server, token: testCredential) }
}
mustThrow("credential header injection") { _ = try Credentials.validate(server: "https://example.invalid", token: testCredential + "\r\n") }
let command = Command(id: "operation", requestId: "request", kind: "answer", answers: ["q1": Answer(answers: ["Yes"])])
let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(command)) as! [String: Any]
check(((body["answers"] as? [String: Any])?["q1"] as? [String: [String]])?["answers"] == ["Yes"], "Answer contract")
check(operationLabel("approve") == L("批准") && operationLabel("deny") == L("拒绝"), "Approval intent labels match retained kind")
check(requestTitle("codex.input") != "codex.input" && requestLabel("option.1") != "option.1", "Wire keys are localized")
check(!requestDetail("/private/sensitive-task").contains("sensitive-task"), "Unknown detail never reaches UI")
let wireState = try CloudState.parse(Data(fixture.utf8))
check(wireState.wire == Data(fixture.utf8), "Original wire shape, null quotas, and timestamps are retained")
var fullWire = try JSONSerialization.jsonObject(with: Data(fixture.utf8)) as! [String: Any]
var fullSnapshot = fullWire["snapshot"] as! [String: Any]
var fullRequests = fullSnapshot["requests"] as! [[String: Any]]
let originalContent: [String: Any] = ["questions": [["id": "q1", "header": "Original heading", "question": "Original question?", "options": [["label": "Original choice", "description": "Original explanation"]]]]]
fullRequests[0]["fullContent"] = originalContent; fullSnapshot["requests"] = fullRequests; fullWire["snapshot"] = fullSnapshot
let fullState = try CloudState.parse(JSONSerialization.data(withJSONObject: fullWire))
let forwarded = try JSONSerialization.jsonObject(with: fullState.wire!) as! [String: Any]
let forwardedContent = ((forwarded["snapshot"] as! [String: Any])["requests"] as! [[String: Any]])[0]["fullContent"] as! [String: Any]
check(NSDictionary(dictionary: forwardedContent).isEqual(to: originalContent), "Opt-in full content survives the native wire bridge without changing answer metadata")
let bridgeID = UUID().uuidString
let bridge = try MobileBridgeMessage.parse(["id": bridgeID, "type": "ready"])
check(bridge.type == "ready", "Bounded known bridge call accepted")
mustThrow("unknown native capability") { _ = try MobileBridgeMessage.parse(["id": bridgeID, "type": "openURL", "url": "https://example.invalid"]) }
mustThrow("unexpected bridge field") { _ = try MobileBridgeMessage.parse(["id": bridgeID, "type": "refresh", "token": testCredential]) }
mustThrow("invalid operation identifier") { _ = try MobileBridgeMessage.parse(["id": "not-uuid", "type": "ready"]) }
let request = state.snapshot!.requests[0]
let validCommand = Command(id: UUID().uuidString, requestId: request.id, kind: "answer", answers: ["q1": Answer(answers: ["Yes"])])
try validCommand.validate(for: request)
check(true, "Valid native answer accepted")
mustThrow("input cannot approve") { try Command(id: UUID().uuidString, requestId: request.id, kind: "approve").validate(for: request) }
mustThrow("unknown question") { try Command(id: UUID().uuidString, requestId: request.id, kind: "answer", answers: ["wrong": Answer(answers: ["Yes"])]).validate(for: request) }
mustThrow("empty answer") { try Command(id: UUID().uuidString, requestId: request.id, kind: "answer", answers: ["q1": Answer(answers: [" "])]).validate(for: request) }
let strict = PendingRequest(id: "strict", provider: "codex", kind: "input", title: "codex.input", detail: "input", choices: nil, questions: [Question(id: "q1", header: nil, question: "", options: [Option(label: "option.1", description: nil)], isOther: false, isSecret: false)], expiresAt: 1)
mustThrow("unlisted option") { try Command(id: UUID().uuidString, requestId: strict.id, kind: "answer", answers: ["q1": Answer(answers: ["other"])]).validate(for: strict) }
let secret = PendingRequest(id: "secret", provider: "codex", kind: "input", title: "codex.input", detail: "input", choices: nil, questions: [Question(id: "q1", header: nil, question: "", options: nil, isOther: true, isSecret: true)], expiresAt: 1)
mustThrow("secret answer") { try Command(id: UUID().uuidString, requestId: secret.id, kind: "answer", answers: ["q1": Answer(answers: ["sensitive"])]).validate(for: secret) }
let attention = AttentionState(inputCount: 2, approvalCount: 1, provider: "codex", updatedAt: 1000, expiresAt: 1090)
check(attention.isActive(at: 1001), "Pending attention is active")
check(!attention.isActive(at: 1090), "Attention expires at its lease")
check(!attention.isActive(at: 990), "Future attention is rejected")
check(attention.total == 3, "Input and approval totals")
let refreshed = AttentionState(inputCount: 2, approvalCount: 1, provider: "codex", updatedAt: 1060, expiresAt: 1150)
check(attention.semanticKey == refreshed.semanticKey, "Lease refresh is not a new attention cycle")
check(!attention.cleared(at: 1001).isActive(at: 1001), "Zero attention cannot create an activity")
check(!AttentionState(inputCount: -1, approvalCount: 1, provider: "codex", updatedAt: 1000, expiresAt: 1090).validFields, "Negative counts rejected")
check(!AttentionState(inputCount: 1000, approvalCount: 1, provider: "codex", updatedAt: 1000, expiresAt: 1090).validFields, "Unbounded counts rejected")
check(!AttentionState(inputCount: 1, approvalCount: 0, provider: "private task content", updatedAt: 1000, expiresAt: 1090).validFields, "Lock Screen provider is allowlisted")
check(AttentionState(inputCount: 1, approvalCount: 0, provider: "deepseek", updatedAt: 1000, expiresAt: 1090).validFields, "DeepSeek uses the cloud provider identifier")
check(!AttentionState(inputCount: 1, approvalCount: 0, provider: "codex", updatedAt: 1000, expiresAt: 2000).validFields, "Lease is bounded")
check(AttentionState(inputCount: Int.max, approvalCount: Int.max, provider: "codex", updatedAt: 1000, expiresAt: 1090).total == 1998, "Untrusted widget counts cannot overflow")
let attentionWire = try JSONSerialization.jsonObject(with: JSONEncoder().encode(attention)) as! [String: Any]
check(Set(attentionWire.keys) == ["inputCount", "approvalCount", "provider", "updatedAt", "expiresAt"], "Lock Screen wire has only safe statistics and timestamps")
check(AttentionActivityPolicy.mayStart(enabled: true, foreground: true, systemAllowed: true, attention: attention, now: 1001, suppressed: false), "Foreground opt-in can create")
check(!AttentionActivityPolicy.mayStart(enabled: false, foreground: true, systemAllowed: true, attention: attention, now: 1001, suppressed: false), "Default-off creates no activity")
check(!AttentionActivityPolicy.mayStart(enabled: true, foreground: false, systemAllowed: true, attention: attention, now: 1001, suppressed: false), "No local background start")
check(!AttentionActivityPolicy.mayStart(enabled: true, foreground: true, systemAllowed: false, attention: attention, now: 1001, suppressed: false), "System authorization respected")
check(!AttentionActivityPolicy.mayStart(enabled: true, foreground: true, systemAllowed: true, attention: refreshed, now: 1061, suppressed: true), "User dismissal survives heartbeat changes")
check(!AttentionActivityPolicy.mayStart(enabled: true, foreground: true, systemAllowed: true, attention: AttentionState(inputCount: 5, approvalCount: 2, provider: "multiple", updatedAt: 1060, expiresAt: 1150), now: 1061, suppressed: true), "User dismissal survives count and provider changes within a pending cycle")
_ = try MobileBridgeMessage.parse(["id": UUID().uuidString, "type": "liveUpdates", "enabled": true])
check(true, "Explicit Live Activity toggle accepted")
mustThrow("invalid live update toggle") { _ = try MobileBridgeMessage.parse(["id": UUID().uuidString, "type": "liveUpdates", "enabled": "true"]) }
mustThrow("numeric live update toggle") { _ = try MobileBridgeMessage.parse(["id": UUID().uuidString, "type": "liveUpdates", "enabled": 1]) }
print("iOS protocol and native bridge checks passed: \(checkCount)")
