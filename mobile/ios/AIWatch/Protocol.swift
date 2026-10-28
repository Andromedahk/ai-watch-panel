import Foundation
import CoreFoundation

struct Credentials: Codable {
    let server: String
    let token: String
    static func validate(server: String, token: String) throws -> Credentials {
        guard let url = URL(string: server.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme?.lowercased() == "https", url.host != nil, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, ["", "/"].contains(url.path),
              token.count >= 32, token.count <= 512,
              token.utf8.allSatisfy({ $0 > 32 && $0 < 127 }) else { throw CloudError.configuration }
        var normalized = URLComponents(url: url, resolvingAgainstBaseURL: false)
        normalized?.scheme = "https"
        guard let canonical = normalized?.url else { throw CloudError.configuration }
        return Credentials(server: canonical.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), token: token)
    }
}
enum CloudError: Error, LocalizedError {
    case configuration, unauthorized, rejected(Int), malformed, unavailable, secureStorage(Int32)
    var errorDescription: String? {
        switch self {
        case .configuration: return L("请输入 HTTPS 服务器地址和有效配对凭据。")
        case .unauthorized: return L("手机访问令牌无效或已撤销。")
        case .rejected(let code): return L("服务器拒绝操作，请刷新并确认请求仍有效") + " (\(code))"
        case .malformed: return L("服务器返回了无法识别的数据。")
        case .unavailable: return L("无法连接服务器，请检查网络。")
        case .secureStorage(let code): return L("无法安全保存连接，请检查应用签名。") + " (\(code))"
        }
    }
}
struct CloudState: Decodable {
    var wire: Data?
    var attention: AttentionState?
    var online: Bool
    var receivedAt: Double?
    var deviceId: String?
    var snapshot: Snapshot?
    var commands: [CommandState]
    var alerts: [CloudAlert]?
    static func parse(_ data: Data) throws -> CloudState {
        guard data.count <= 512 * 1024 else { throw CloudError.malformed }
        var state = try JSONDecoder().decode(CloudState.self, from: data)
        state.wire = data
        return state
    }
    func fresh(at now: Date) -> Bool {
        online && receivedAt.map { let age = now.timeIntervalSince1970 * 1000 - $0; return age >= -5_000 && age < 25_000 } == true
    }
}
struct Snapshot: Decodable { let p: [Provider]; let requests: [PendingRequest]; let sample: Bool; let stale: Bool?; let limited: Bool? }
struct Provider: Decodable, Identifiable {
    let i: String; let c: String; let a: String; let n: Int; let w: String?; let q: [Quota]
    var id: String { i }
}
struct Quota: Decodable { let m: String; let p: String; let r: Double?; let s: Bool?; let z: String? }
struct PendingRequest: Decodable, Identifiable {
    let id: String; let provider: String; let kind: String; let title: String; let detail: String
    let choices: [Choice]?; let questions: [Question]?; let expiresAt: Double
    func valid(at now: Date) -> Bool { expiresAt > now.timeIntervalSince1970 * 1000 }
}
struct Choice: Decodable, Identifiable { let id: String; let label: String }
struct Question: Decodable, Identifiable {
    let id: String; let header: String?; let question: String; let options: [Option]?
    let isOther: Bool?; let isSecret: Bool?
}
struct Option: Decodable { let label: String; let description: String? }
struct CommandState: Decodable, Identifiable { let id: String; let requestId: String?; let status: String; let error: String? }
struct CloudAlert: Decodable, Identifiable {
    let id: String; let type: String; let provider: String; let requestId: String?; let createdAt: Double; let active: Bool
}
struct Answer: Codable { let answers: [String] }
struct Command: Codable {
    let id: String; let requestId: String; let kind: String
    var answer: String?; var answers: [String: Answer]?; var choice: String?
}
func operationLabel(_ kind: String) -> String { ["approve": L("批准"), "deny": L("拒绝"), "answer": L("发送回答")][kind] ?? kind }

// Byte parser preserves empty SSE lines and enforces a bounded event size.
struct SSEParser {
    private var line = Data()
    private var data: [String] = []
    private var kind = "message"
    private var bytes = 0
    mutating func feed(_ byte: UInt8) throws -> String? {
        bytes += 1
        guard bytes <= 512 * 1024 else { throw CloudError.malformed }
        guard byte == 10 else { if byte != 13 { line.append(byte) }; return nil }
        guard let text = String(data: line, encoding: .utf8) else { throw CloudError.malformed }
        line.removeAll(keepingCapacity: true)
        if text.isEmpty {
            let result = kind == "state" && !data.isEmpty ? data.joined(separator: "\n") : nil
            data.removeAll(keepingCapacity: true); kind = "message"; bytes = 0
            return result
        }
        if text.hasPrefix("event:") { kind = String(text.dropFirst(6)).trimmingCharacters(in: .whitespaces) }
        if text.hasPrefix("data:") { var value = String(text.dropFirst(5)); if value.first == " " { value.removeFirst() }; data.append(value) }
        return nil
    }
}


// The bundled page has a deliberately small native capability surface.
struct MobileBridgeMessage {
    let id: String
    let type: String
    let value: [String: Any]
    static func parse(_ object: Any) throws -> MobileBridgeMessage {
        guard let value = object as? [String: Any], JSONSerialization.isValidJSONObject(value),
              try JSONSerialization.data(withJSONObject: value).count <= 128 * 1024,
              let id = value["id"] as? String, UUID(uuidString: id) != nil,
              let type = value["type"] as? String else { throw CloudError.malformed }
        let keys: Set<String>
        switch type {
        case "ready", "refresh", "logout", "notifications": keys = ["id", "type"]
        case "configure":
            keys = ["id", "type", "server", "token"]
            guard let server = value["server"] as? String, let token = value["token"] as? String else { throw CloudError.configuration }
            _ = try Credentials.validate(server: server, token: token)
        case "liveUpdates":
            keys = ["id", "type", "enabled"]
            guard let enabled = value["enabled"] as? NSNumber, CFGetTypeID(enabled) == CFBooleanGetTypeID() else { throw CloudError.malformed }
        case "submit":
            keys = ["id", "type", "command"]
            guard value["command"] is [String: Any] else { throw CloudError.malformed }
        default: throw CloudError.malformed
        }
        guard Set(value.keys).isSubset(of: keys) else { throw CloudError.malformed }
        return MobileBridgeMessage(id: id, type: type, value: value)
    }
}
extension Command {
    static func parse(_ object: Any, for request: PendingRequest) throws -> Command {
        guard let value = object as? [String: Any],
              Set(value.keys).isSubset(of: ["id", "requestId", "kind", "answer", "answers"]),
              JSONSerialization.isValidJSONObject(value) else { throw CloudError.malformed }
        let command = try JSONDecoder().decode(Command.self, from: JSONSerialization.data(withJSONObject: value))
        try command.validate(for: request)
        return command
    }
    func validate(for request: PendingRequest) throws {
        guard UUID(uuidString: id) != nil, requestId == request.id, choice == nil,
              ["answer", "approve", "deny"].contains(kind),
              (request.kind == "input" && kind == "answer") || (request.kind == "approval" && ["approve", "deny"].contains(kind)) else { throw CloudError.malformed }
        guard kind == "answer" else {
            guard answer == nil, answers == nil else { throw CloudError.malformed }; return
        }
        let questions = request.questions ?? []
        func validText(_ text: String) -> Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && text.count <= 4000 }
        if questions.isEmpty {
            guard answers == nil, let answer, validText(answer) else { throw CloudError.malformed }
        } else {
            guard answer == nil, let answers, Set(answers.keys) == Set(questions.map(\.id)) else { throw CloudError.malformed }
            for question in questions {
                guard question.isSecret != true, let values = answers[question.id]?.answers, values.count == 1,
                      let text = values.first, validText(text) else { throw CloudError.malformed }
                let options = question.options ?? []
                guard question.isOther != false || options.isEmpty || options.contains(where: { $0.label == text }) else { throw CloudError.malformed }
            }
        }
    }
}
