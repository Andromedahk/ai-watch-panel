import Foundation

// Exact ActivityKit content-state contract. No task text, paths, commands, or
// credentials belong in this model: it is visible on the Lock Screen.
struct AttentionState: Codable, Hashable {
    let inputCount: Int
    let approvalCount: Int
    let provider: String
    let updatedAt: Int
    let expiresAt: Int
    static let providerNames = ["claude": "Claude", "codex": "Codex", "antigravity": "Antigravity", "deepseek": "DeepSeek Harness", "zcode": "ZCode", "kimi": "Kimi", "qwen": "Qwen", "workbuddy": "WorkBuddy"]
    var total: Int { min(max(0, inputCount), 999) + min(max(0, approvalCount), 999) }
    var semanticKey: String { "\(inputCount):\(approvalCount):\(provider)" }
    var validFields: Bool {
        (0...999).contains(inputCount) && (0...999).contains(approvalCount) &&
        (Self.providerNames[provider] != nil || ["multiple", "none"].contains(provider)) &&
        updatedAt > 0 && expiresAt >= updatedAt && expiresAt - updatedAt <= 900
    }
    func isActive(at now: Int) -> Bool { validFields && total > 0 && updatedAt <= now + 5 && expiresAt > now }
    func cleared(at now: Int) -> AttentionState { .init(inputCount: 0, approvalCount: 0, provider: "none", updatedAt: now, expiresAt: now) }
}
struct AttentionActivityPolicy {
    static func mayStart(enabled: Bool, foreground: Bool, systemAllowed: Bool, attention: AttentionState?, now: Int, suppressed: Bool) -> Bool {
        guard enabled, foreground, systemAllowed, let attention, attention.isActive(at: now) else { return false }
        return !suppressed
    }
}
