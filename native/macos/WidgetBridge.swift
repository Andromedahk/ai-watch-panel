import Darwin
import Foundation
import Security
import WidgetKit

private enum WidgetSnapshotStore {
    static let maximumSnapshotBytes = 64 * 1024
    static let expectedBundleIdentifier = "app.aiwatch.panel"
    static let snapshotName = "snapshot.json"
    static let lock = NSLock()

    static func entitlement(_ name: String, task: SecTask) -> AnyObject? {
        SecTaskCopyValueForEntitlement(task, name as CFString, nil)
    }

    static func containerURL() -> URL? {
        guard
            Bundle.main.bundleIdentifier == expectedBundleIdentifier,
            let appGroup = Bundle.main.object(forInfoDictionaryKey: "AIWatchAppGroup") as? String,
            let task = SecTaskCreateFromSelf(nil),
            let teamIdentifier = entitlement("com.apple.developer.team-identifier", task: task) as? String,
            teamIdentifier.range(of: #"^[A-Z0-9]{10}$"#, options: .regularExpression) != nil,
            appGroup == "\(teamIdentifier).\(expectedBundleIdentifier)",
            let applicationIdentifier = entitlement("com.apple.application-identifier", task: task) as? String,
            applicationIdentifier == "\(teamIdentifier).\(expectedBundleIdentifier)",
            let entitledGroups = entitlement("com.apple.security.application-groups", task: task) as? [String],
            entitledGroups.contains(appGroup)
        else {
            return nil
        }

        return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    }

    static func atomicWrite(_ data: Data, to destination: URL) -> Bool {
        let temporary = destination.deletingLastPathComponent()
            .appendingPathComponent(".snapshot-\(UUID().uuidString).tmp", isDirectory: false)
        let descriptor = temporary.path.withCString {
            Darwin.open($0, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, S_IRUSR | S_IWUSR)
        }
        guard descriptor >= 0 else { return false }

        var completed = false
        defer {
            Darwin.close(descriptor)
            if !completed {
                temporary.path.withCString { _ = Darwin.unlink($0) }
            }
        }

        let wroteAllBytes = data.withUnsafeBytes { rawBuffer -> Bool in
            guard let baseAddress = rawBuffer.baseAddress else { return data.isEmpty }
            var written = 0
            while written < rawBuffer.count {
                let count = Darwin.write(descriptor, baseAddress.advanced(by: written), rawBuffer.count - written)
                if count < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                if count == 0 { return false }
                written += count
            }
            return true
        }
        guard wroteAllBytes, Darwin.fsync(descriptor) == 0 else { return false }

        let renamed = temporary.path.withCString { temporaryPath in
            destination.path.withCString { destinationPath in
                Darwin.rename(temporaryPath, destinationPath)
            }
        }
        guard renamed == 0 else { return false }
        completed = true
        return true
    }

    static func publish(_ bytes: UnsafePointer<UInt8>?, length: Int, reload: Bool) -> Bool {
        guard let bytes, length >= 0, length <= maximumSnapshotBytes else { return false }
        let data = Data(bytes: bytes, count: length)

        do {
            _ = try AIWatchSnapshot.decode(data, maxBytes: maximumSnapshotBytes)
        } catch {
            return false
        }

        lock.lock()
        defer { lock.unlock() }
        guard let container = containerURL() else { return false }
        let destination = container.appendingPathComponent(snapshotName, isDirectory: false)
        guard atomicWrite(data, to: destination) else { return false }
        if reload { WidgetCenter.shared.reloadAllTimelines() }
        return true
    }

    static func clear() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let container = containerURL() else { return false }
        let destination = container.appendingPathComponent(snapshotName, isDirectory: false)
        do {
            if FileManager.default.fileExists(atPath: destination.path) {
                try FileManager.default.removeItem(at: destination)
            }
            WidgetCenter.shared.reloadAllTimelines()
            return true
        } catch {
            return false
        }
    }
}

@_cdecl("aiwatch_widget_publish")
public func aiwatchWidgetPublish(
    _ bytes: UnsafePointer<UInt8>?,
    _ length: Int,
    _ reload: Int32
) -> Int32 {
    WidgetSnapshotStore.publish(bytes, length: length, reload: reload != 0) ? 1 : 0
}

@_cdecl("aiwatch_widget_clear")
public func aiwatchWidgetClear() -> Int32 {
    WidgetSnapshotStore.clear() ? 1 : 0
}

@_cdecl("aiwatch_widget_available")
public func aiwatchWidgetAvailable() -> Int32 {
    WidgetSnapshotStore.containerURL() == nil ? 0 : 1
}

#if WIDGET_BRIDGE_TESTING
func aiWatchTestAtomicWrite(_ data: Data, to destination: URL) -> Bool {
    WidgetSnapshotStore.atomicWrite(data, to: destination)
}
#endif
