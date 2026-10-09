#if WIDGET_BRIDGE_TESTING
import Foundation

@main
private enum WidgetBridgeTests {
    static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() {
            throw NSError(domain: "WidgetBridgeTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
        }
    }

    static func main() throws {
        let fileManager = FileManager.default
        let directory = fileManager.temporaryDirectory
            .appendingPathComponent("ai-watch-widget-bridge-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? fileManager.removeItem(at: directory) }

        let destination = directory.appendingPathComponent("snapshot.json", isDirectory: false)
        try Data("old".utf8).write(to: destination)
        let expected = Data(#"{"schemaVersion":1,"rows":[]}"#.utf8)
        try require(aiWatchTestAtomicWrite(expected, to: destination), "atomic replacement failed")
        let actual = try Data(contentsOf: destination)
        try require(actual == expected, "atomic replacement changed the payload")
        let attributes = try fileManager.attributesOfItem(atPath: destination.path)
        try require((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600, "snapshot permissions are not 0600")

        try fileManager.removeItem(at: destination)
        try fileManager.createDirectory(at: destination, withIntermediateDirectories: false)
        try require(!aiWatchTestAtomicWrite(expected, to: destination), "writer unexpectedly replaced a directory")
        let leftovers = try fileManager.contentsOfDirectory(atPath: directory.path)
            .filter { $0.hasPrefix(".snapshot-") && $0.hasSuffix(".tmp") }
        try require(leftovers.isEmpty, "failed write left a temporary snapshot")

        print("WidgetBridgeTests: atomic replacement, 0600 permissions, and failure cleanup passed")
    }
}
#endif
