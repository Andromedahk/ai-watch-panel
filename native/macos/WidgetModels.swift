import Darwin
import Foundation

public enum AIWatchProviderID: String, Codable, CaseIterable, Sendable {
    case claude
    case codex
    case antigravity
    case deepseek
    case zcode
    case kimi
    case qwen
    case workbuddy

    public var defaultName: String {
        switch self {
        case .claude: "Claude Code"
        case .codex: "Codex"
        case .antigravity: "Antigravity"
        case .deepseek: "DeepSeek Harness"
        case .zcode: "ZCode"
        case .kimi: "Kimi Code"
        case .qwen: "Qwen"
        case .workbuddy: "WorkBuddy"
        }
    }

    public var colorHex: UInt32 {
        switch self {
        case .claude: 0xDBA487
        case .codex: 0xC9D4DF
        case .antigravity: 0xACA8EF
        case .deepseek: 0x7FBDB3
        case .zcode: 0xB190DC
        case .kimi: 0x8DE8EE
        case .qwen: 0x8D9CFF
        case .workbuddy: 0x71D9C1
        }
    }
}

public enum AIWatchTheme: String, Codable, Sendable {
    case system
    case light
    case dark
}

public enum AIWatchModelError: Error, Equatable, LocalizedError, Sendable {
    case snapshotTooLarge
    case malformedJSON
    case unexpectedFields(String)
    case missingFields(String)
    case unsupportedSchema(Int)
    case invalidText(String)
    case invalidDate(String)
    case invalidRemaining
    case unknownProvider(String)
    case invalidActivity(String)
    case duplicateProvider(String)
    case tooManyRows

    public var errorDescription: String? {
        switch self {
        case .snapshotTooLarge: "The widget snapshot exceeds the 64 KB limit."
        case .malformedJSON: "The widget snapshot is not valid JSON."
        case .unexpectedFields(let scope): "The widget snapshot contains unexpected fields in \(scope)."
        case .missingFields(let scope): "The widget snapshot is missing fields in \(scope)."
        case .unsupportedSchema(let version): "Widget snapshot schema \(version) is unsupported."
        case .invalidText(let field): "The widget snapshot contains invalid text in \(field)."
        case .invalidDate(let field): "The widget snapshot contains an invalid date in \(field)."
        case .invalidRemaining: "The widget snapshot contains an invalid remaining value."
        case .unknownProvider(let id): "The widget snapshot contains unknown provider \(id)."
        case .invalidActivity(let activity): "The widget snapshot contains invalid activity \(activity)."
        case .duplicateProvider(let id): "The widget snapshot contains duplicate provider \(id)."
        case .tooManyRows: "The widget snapshot contains too many provider rows."
        }
    }
}

public struct AIWatchWidgetRow: Codable, Equatable, Sendable {
    public let id: AIWatchProviderID
    public let name: String
    public let summary: String
    public let remaining: Double?
    public let activity: String
    public let stale: Bool
    public let observedAt: String?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case id, name, summary, remaining, activity, stale, observedAt
    }

    public init(
        id: AIWatchProviderID,
        name: String,
        summary: String,
        remaining: Double?,
        activity: String,
        stale: Bool,
        observedAt: String?
    ) throws {
        try AIWatchValidation.text(name, field: "row.name", maxLength: 64, allowEmpty: false)
        try AIWatchValidation.text(summary, field: "row.summary", maxLength: 512, allowEmpty: false)
        try AIWatchValidation.text(activity, field: "row.activity", maxLength: 96, allowEmpty: false)
        guard ["running", "waiting", "idle", "unknown", "offline"].contains(activity) else {
            throw AIWatchModelError.invalidActivity(activity)
        }
        try AIWatchValidation.optionalDate(observedAt, field: "row.observedAt")
        if let remaining, !remaining.isFinite || remaining < 0 || remaining > 100 {
            throw AIWatchModelError.invalidRemaining
        }
        self.id = id
        self.name = name
        self.summary = summary
        self.remaining = remaining
        self.activity = activity
        self.stale = stale
        self.observedAt = observedAt
    }

    public init(from decoder: Decoder) throws {
        try AIWatchValidation.exactKeys(decoder, keys: CodingKeys.allCases, scope: "row")
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let rawID = try container.decode(String.self, forKey: .id)
        guard let id = AIWatchProviderID(rawValue: rawID) else {
            throw AIWatchModelError.unknownProvider(rawID)
        }
        let name = try container.decode(String.self, forKey: .name)
        let summary = try container.decode(String.self, forKey: .summary)
        let remaining = try container.decodeIfPresent(Double.self, forKey: .remaining)
        let activity = try container.decode(String.self, forKey: .activity)
        let stale = try container.decode(Bool.self, forKey: .stale)
        let observedAt = try container.decodeIfPresent(String.self, forKey: .observedAt)
        try self.init(
            id: id,
            name: name,
            summary: summary,
            remaining: remaining,
            activity: activity,
            stale: stale,
            observedAt: observedAt
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(summary, forKey: .summary)
        if let remaining { try container.encode(remaining, forKey: .remaining) }
        else { try container.encodeNil(forKey: .remaining) }
        try container.encode(activity, forKey: .activity)
        try container.encode(stale, forKey: .stale)
        if let observedAt { try container.encode(observedAt, forKey: .observedAt) }
        else { try container.encodeNil(forKey: .observedAt) }
    }

    public var observedAtDate: Date? {
        observedAt.flatMap(AIWatchValidation.date)
    }
}

public struct AIWatchSnapshot: Codable, Equatable, Sendable {
    public static let schemaVersion = 1
    public static let maximumBytes = 64 * 1024
    public static let staleInterval: TimeInterval = 15 * 60

    public let schemaVersion: Int
    public let generatedAt: String
    public let sampledAt: String?
    public let theme: AIWatchTheme
    public let language: String
    public let isTestData: Bool
    public let rows: [AIWatchWidgetRow]

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case schemaVersion, generatedAt, sampledAt, theme, language, isTestData, rows
    }

    public init(
        schemaVersion: Int = AIWatchSnapshot.schemaVersion,
        generatedAt: String,
        sampledAt: String?,
        theme: AIWatchTheme,
        language: String,
        isTestData: Bool,
        rows: [AIWatchWidgetRow]
    ) throws {
        guard schemaVersion == Self.schemaVersion else {
            throw AIWatchModelError.unsupportedSchema(schemaVersion)
        }
        try AIWatchValidation.requiredDate(generatedAt, field: "generatedAt")
        try AIWatchValidation.optionalDate(sampledAt, field: "sampledAt")
        try AIWatchValidation.language(language)
        guard rows.count <= AIWatchProviderID.allCases.count else {
            throw AIWatchModelError.tooManyRows
        }
        var ids = Set<AIWatchProviderID>()
        for row in rows where !ids.insert(row.id).inserted {
            throw AIWatchModelError.duplicateProvider(row.id.rawValue)
        }
        self.schemaVersion = schemaVersion
        self.generatedAt = generatedAt
        self.sampledAt = sampledAt
        self.theme = theme
        self.language = language
        self.isTestData = isTestData
        self.rows = rows
    }

    public init(from decoder: Decoder) throws {
        try AIWatchValidation.exactKeys(decoder, keys: CodingKeys.allCases, scope: "snapshot")
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        let generatedAt = try container.decode(String.self, forKey: .generatedAt)
        let sampledAt = try container.decodeIfPresent(String.self, forKey: .sampledAt)
        let theme = try container.decode(AIWatchTheme.self, forKey: .theme)
        let language = try container.decode(String.self, forKey: .language)
        let isTestData = try container.decode(Bool.self, forKey: .isTestData)
        let rows = try container.decode([AIWatchWidgetRow].self, forKey: .rows)
        try self.init(
            schemaVersion: schemaVersion,
            generatedAt: generatedAt,
            sampledAt: sampledAt,
            theme: theme,
            language: language,
            isTestData: isTestData,
            rows: rows
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(generatedAt, forKey: .generatedAt)
        if let sampledAt { try container.encode(sampledAt, forKey: .sampledAt) }
        else { try container.encodeNil(forKey: .sampledAt) }
        try container.encode(theme, forKey: .theme)
        try container.encode(language, forKey: .language)
        try container.encode(isTestData, forKey: .isTestData)
        try container.encode(rows, forKey: .rows)
    }

    public static func decode(_ data: Data, maxBytes: Int = maximumBytes) throws -> AIWatchSnapshot {
        guard maxBytes > 0, maxBytes <= maximumBytes, data.count <= maxBytes else {
            throw AIWatchModelError.snapshotTooLarge
        }
        do {
            return try JSONDecoder().decode(AIWatchSnapshot.self, from: data)
        } catch let error as AIWatchModelError {
            throw error
        } catch {
            throw AIWatchModelError.malformedJSON
        }
    }

    public var generatedAtDate: Date {
        AIWatchValidation.date(generatedAt)!
    }

    public var sampledAtDate: Date? {
        sampledAt.flatMap(AIWatchValidation.date)
    }

    public func row(for provider: AIWatchProviderID) -> AIWatchWidgetRow? {
        rows.first { $0.id == provider }
    }

    public func isStale(at date: Date, forceStale: Bool = false) -> Bool {
        guard !forceStale, let sampledAtDate else { return true }
        let age = date.timeIntervalSince(sampledAtDate)
        return age < -300 || age >= Self.staleInterval
    }

    public static func preview(theme: AIWatchTheme = .system, language: String = "en", date: Date = Date()) -> AIWatchSnapshot {
        let stamp = AIWatchValidation.string(date)
        let chinese = language.lowercased().hasPrefix("zh")
        let specs: [(AIWatchProviderID, String, Double?, String)] = chinese ? [
            (.claude, "5 小时 · 剩余 72%", 72, "running"),
            (.codex, "5 小时 · 剩余 64%", 64, "running"),
            (.antigravity, "Gemini · 剩余 100%", 100, "waiting"),
            (.deepseek, "余额 · ¥42.80 CNY", nil, "idle"),
            (.zcode, "套餐 · 剩余 68%", 68, "running"),
            (.kimi, "订阅积分 · 剩余 73%", 73, "unknown"),
            (.qwen, "积分 / 额度未知", nil, "waiting"),
            (.workbuddy, "积分 / 额度未知", nil, "waiting")
        ] : [
            (.claude, "5h · 72% remaining", 72, "running"),
            (.codex, "5h · 64% remaining", 64, "running"),
            (.antigravity, "Gemini · 100% remaining", 100, "waiting"),
            (.deepseek, "Balance · ¥42.80 CNY", nil, "idle"),
            (.zcode, "Plan · 68% remaining", 68, "running"),
            (.kimi, "Subscription credits · 73% remaining", 73, "unknown"),
            (.qwen, "Credits unavailable", nil, "waiting"),
            (.workbuddy, "Credits unavailable", nil, "waiting")
        ]
        let rows = specs.map { id, summary, remaining, activity in
            try! AIWatchWidgetRow(
                id: id,
                name: id == .kimi ? "Kimi Work" : id.defaultName,
                summary: summary,
                remaining: remaining,
                activity: activity,
                stale: false,
                observedAt: stamp
            )
        }
        return try! AIWatchSnapshot(
            generatedAt: stamp,
            sampledAt: stamp,
            theme: theme,
            language: language,
            isTestData: true,
            rows: rows
        )
    }
}

public enum AIWatchSnapshotLoadState: Equatable, Sendable {
    case loaded(AIWatchSnapshot)
    case missing
    case unavailable
    case invalid

    public var snapshot: AIWatchSnapshot? {
        guard case .loaded(let snapshot) = self else { return nil }
        return snapshot
    }
}

public enum AIWatchSnapshotReader {
    public static let appGroupInfoKey = "AIWatchAppGroup"
    public static let filename = "snapshot.json"

    public static func load(
        bundle: Bundle = .main,
        fileManager: FileManager = .default,
        maxBytes: Int = AIWatchSnapshot.maximumBytes
    ) -> AIWatchSnapshotLoadState {
        guard maxBytes > 0, maxBytes <= AIWatchSnapshot.maximumBytes else { return .invalid }
        guard
            let appGroup = bundle.object(forInfoDictionaryKey: appGroupInfoKey) as? String,
            !appGroup.isEmpty,
            appGroup.count <= 255,
            AIWatchValidation.safeSingleLine(appGroup),
            let container = fileManager.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
        else { return .unavailable }

        let file = container.appendingPathComponent(filename, isDirectory: false)
        guard fileManager.fileExists(atPath: file.path) else { return .missing }
        do {
            let descriptor = file.path.withCString {
                Darwin.open($0, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
            }
            guard descriptor >= 0 else { return .invalid }
            defer { Darwin.close(descriptor) }

            var status = stat()
            guard
                Darwin.fstat(descriptor, &status) == 0,
                status.st_mode & S_IFMT == S_IFREG,
                status.st_size >= 0,
                status.st_size <= maxBytes
            else { return .invalid }

            let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
            let data = try handle.read(upToCount: maxBytes + 1) ?? Data()
            guard data.count <= maxBytes else { return .invalid }
            return .loaded(try AIWatchSnapshot.decode(data, maxBytes: maxBytes))
        } catch {
            return .invalid
        }
    }
}

private struct AIWatchAnyCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }

    init?(intValue: Int) {
        self.stringValue = String(intValue)
        self.intValue = intValue
    }
}

private enum AIWatchValidation {
    private static let forbiddenScalars: Set<UInt32> = [
        0x7F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
        0x2066, 0x2067, 0x2068, 0x2069
    ]

    static func safeSingleLine(_ value: String) -> Bool {
        value.unicodeScalars.allSatisfy { scalar in
            scalar.value >= 0x20 && !forbiddenScalars.contains(scalar.value)
        }
    }

    static func text(_ value: String, field: String, maxLength: Int, allowEmpty: Bool) throws {
        guard
            value.count <= maxLength,
            allowEmpty || !value.trimmingCharacters(in: .whitespaces).isEmpty,
            safeSingleLine(value)
        else { throw AIWatchModelError.invalidText(field) }
    }

    static func language(_ value: String) throws {
        try text(value, field: "language", maxLength: 32, allowEmpty: false)
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-")
        guard value.unicodeScalars.allSatisfy(allowed.contains) else {
            throw AIWatchModelError.invalidText("language")
        }
    }

    static func exactKeys<Key>(_ decoder: Decoder, keys: [Key], scope: String) throws
    where Key: CodingKey {
        let container = try decoder.container(keyedBy: AIWatchAnyCodingKey.self)
        let actual = Set(container.allKeys.map(\.stringValue))
        let expected = Set(keys.map(\.stringValue))
        if !actual.subtracting(expected).isEmpty {
            throw AIWatchModelError.unexpectedFields(scope)
        }
        if !expected.subtracting(actual).isEmpty {
            throw AIWatchModelError.missingFields(scope)
        }
    }

    static func requiredDate(_ value: String, field: String) throws {
        try text(value, field: field, maxLength: 40, allowEmpty: false)
        guard date(value) != nil else { throw AIWatchModelError.invalidDate(field) }
    }

    static func optionalDate(_ value: String?, field: String) throws {
        if let value { try requiredDate(value, field: field) }
    }

    static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    static func string(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}
