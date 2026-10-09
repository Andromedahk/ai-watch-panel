import Foundation

private enum TestFailure: Error, CustomStringConvertible {
    case failed(String)

    var description: String {
        switch self {
        case .failed(let message): message
        }
    }
}

@main
struct WidgetModelTests {
    private static var checks = 0

    static func main() throws {
        if CommandLine.arguments.count == 2 {
            let url = URL(fileURLWithPath: CommandLine.arguments[1])
            let snapshot = try AIWatchSnapshot.decode(Data(contentsOf: url))
            print("WidgetModelTests: fixture valid (\(snapshot.language), \(snapshot.rows.count) rows)")
            return
        }
        guard CommandLine.arguments.count == 1 else {
            throw TestFailure.failed("Usage: ai-watch-widget-model-tests [SNAPSHOT_JSON]")
        }
        try testValidSnapshot()
        try testStrictFields()
        try testSchemaAndProviderValidation()
        try testRemainingAndBounds()
        try testStalenessUsesSampledAt()
        try testExactNullEncoding()
        print("WidgetModelTests: \(checks) checks passed")
    }

    private static func testValidSnapshot() throws {
        let snapshot = try AIWatchSnapshot.decode(validData())
        try expect(snapshot.schemaVersion == 1, "schema version should decode")
        try expect(snapshot.rows.count == 1, "one provider row should decode")
        try expect(snapshot.rows[0].id == .codex, "provider ID should decode")
        try expect(snapshot.rows[0].remaining == 64, "remaining should decode")
    }

    private static func testStrictFields() throws {
        try expectError(.unexpectedFields("snapshot"), "unknown top-level field") {
            _ = try AIWatchSnapshot.decode(validData(extraSnapshot: ",\"extra\":true"))
        }
        try expectError(.unexpectedFields("row"), "unknown row field") {
            _ = try AIWatchSnapshot.decode(validData(extraRow: ",\"extra\":true"))
        }
        let missingSampledAt = validJSON().replacingOccurrences(of: "\"sampledAt\":\"2026-10-09T08:00:00Z\",", with: "")
        try expectError(.missingFields("snapshot"), "missing nullable field") {
            _ = try AIWatchSnapshot.decode(Data(missingSampledAt.utf8))
        }
        let unsafeText = validJSON().replacingOccurrences(of: "\"activity\":\"running\"", with: "\"activity\":\"running\\n\"")
        try expectError(.invalidText("row.activity"), "control characters") {
            _ = try AIWatchSnapshot.decode(Data(unsafeText.utf8))
        }
        let invalidActivity = validJSON().replacingOccurrences(of: "\"activity\":\"running\"", with: "\"activity\":\"busy\"")
        try expectError(.invalidActivity("busy"), "activity enum") {
            _ = try AIWatchSnapshot.decode(Data(invalidActivity.utf8))
        }
    }

    private static func testSchemaAndProviderValidation() throws {
        let schema = validJSON().replacingOccurrences(of: "\"schemaVersion\":1", with: "\"schemaVersion\":2")
        try expectError(.unsupportedSchema(2), "unsupported schema") {
            _ = try AIWatchSnapshot.decode(Data(schema.utf8))
        }
        let unknown = validJSON().replacingOccurrences(of: "\"id\":\"codex\"", with: "\"id\":\"unknown\"")
        try expectError(.unknownProvider("unknown"), "unknown provider") {
            _ = try AIWatchSnapshot.decode(Data(unknown.utf8))
        }
        let row = rowJSON()
        let duplicate = validJSON(rows: "\(row),\(row)")
        try expectError(.duplicateProvider("codex"), "duplicate provider") {
            _ = try AIWatchSnapshot.decode(Data(duplicate.utf8))
        }
    }

    private static func testRemainingAndBounds() throws {
        let over = validJSON().replacingOccurrences(of: "\"remaining\":64", with: "\"remaining\":101")
        try expectError(.invalidRemaining, "remaining above 100") {
            _ = try AIWatchSnapshot.decode(Data(over.utf8))
        }
        try expectError(.snapshotTooLarge, "byte limit") {
            _ = try AIWatchSnapshot.decode(validData(), maxBytes: 16)
        }
        let longName = String(repeating: "x", count: 65)
        let oversized = validJSON().replacingOccurrences(of: "Codex", with: longName)
        try expectError(.invalidText("row.name"), "name length") {
            _ = try AIWatchSnapshot.decode(Data(oversized.utf8))
        }
    }

    private static func testStalenessUsesSampledAt() throws {
        let snapshot = try AIWatchSnapshot.decode(validData())
        let fresh = isoDate("2026-10-09T08:14:59Z")
        let stale = isoDate("2026-10-09T08:15:00Z")
        try expect(!snapshot.isStale(at: fresh), "sample should be fresh before 15 minutes")
        try expect(snapshot.isStale(at: stale), "sample should be stale at 15 minutes")

        let misleadingGenerated = validJSON().replacingOccurrences(
            of: "\"generatedAt\":\"2026-10-09T08:00:10Z\"",
            with: "\"generatedAt\":\"2026-10-09T08:14:59Z\""
        )
        let generatedSnapshot = try AIWatchSnapshot.decode(Data(misleadingGenerated.utf8))
        try expect(generatedSnapshot.isStale(at: stale), "generatedAt must not extend freshness")

        let noSample = validJSON().replacingOccurrences(
            of: "\"sampledAt\":\"2026-10-09T08:00:00Z\"",
            with: "\"sampledAt\":null"
        )
        let noSampleSnapshot = try AIWatchSnapshot.decode(Data(noSample.utf8))
        try expect(noSampleSnapshot.isStale(at: fresh), "missing sampledAt should be stale")
    }

    private static func testExactNullEncoding() throws {
        let noValues = validJSON()
            .replacingOccurrences(of: "\"remaining\":64", with: "\"remaining\":null")
            .replacingOccurrences(of: "\"observedAt\":\"2026-10-09T08:00:00Z\"", with: "\"observedAt\":null")
        let snapshot = try AIWatchSnapshot.decode(Data(noValues.utf8))
        let encoded = try JSONEncoder().encode(snapshot)
        let object = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        let rows = object?["rows"] as? [[String: Any]]
        try expect(object?.keys.contains("sampledAt") == true, "sampledAt key should be encoded")
        try expect(rows?.first?.keys.contains("remaining") == true, "remaining key should be encoded")
        try expect(rows?.first?.keys.contains("observedAt") == true, "observedAt key should be encoded")
    }

    private static func validData(extraSnapshot: String = "", extraRow: String = "") -> Data {
        Data(validJSON(extraSnapshot: extraSnapshot, extraRow: extraRow).utf8)
    }

    private static func validJSON(
        rows: String? = nil,
        extraSnapshot: String = "",
        extraRow: String = ""
    ) -> String {
        let body = rows ?? rowJSON(extra: extraRow)
        return """
        {"schemaVersion":1,"generatedAt":"2026-10-09T08:00:10Z","sampledAt":"2026-10-09T08:00:00Z","theme":"system","language":"en","isTestData":false,"rows":[\(body)]\(extraSnapshot)}
        """
    }

    private static func rowJSON(extra: String = "") -> String {
        """
        {"id":"codex","name":"Codex","summary":"5h · 64% remaining","remaining":64,"activity":"running","stale":false,"observedAt":"2026-10-09T08:00:00Z"\(extra)}
        """
    }

    private static func isoDate(_ value: String) -> Date {
        ISO8601DateFormatter().date(from: value)!
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        checks += 1
        if !condition() { throw TestFailure.failed(message) }
    }

    private static func expectError(
        _ expected: AIWatchModelError,
        _ label: String,
        _ operation: () throws -> Void
    ) throws {
        checks += 1
        do {
            try operation()
            throw TestFailure.failed("Expected \(expected) for \(label)")
        } catch let error as AIWatchModelError {
            if error != expected {
                throw TestFailure.failed("Expected \(expected) for \(label), got \(error)")
            }
        }
    }
}
