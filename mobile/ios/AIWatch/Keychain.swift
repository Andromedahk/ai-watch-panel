import Foundation
import Security

enum Keychain {
    private static let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "app.aiwatch.mobile", kSecAttrAccount as String: "cloud"]
    static func read() -> Credentials? {
        var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(Credentials.self, from: data)
    }
    static func save(_ credentials: Credentials) throws {
        let data = try JSONEncoder().encode(credentials)
        let attributes: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let update = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if update == errSecItemNotFound {
            let add = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
            guard add == errSecSuccess else { throw CloudError.secureStorage(add) }
        } else if update != errSecSuccess { throw CloudError.secureStorage(update) }
    }
    static func clear() { SecItemDelete(query as CFDictionary) }
}
