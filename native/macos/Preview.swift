import AppKit
import Foundation
import SwiftUI
import WidgetKit

private enum AIWatchPreviewError: Error, LocalizedError {
    case usage
    case renderFailed(String)

    var errorDescription: String? {
        switch self {
        case .usage:
            "Usage: ai-watch-widget-preview OUTPUT_DIRECTORY"
        case .renderFailed(let name):
            "Failed to render \(name)."
        }
    }
}

private struct AIWatchPreviewSpec {
    enum Fixture { case all, enabledFour }

    let family: WidgetFamily
    let mode: AIWatchWidgetMode
    let fixture: Fixture
    let name: String
    let width: CGFloat
    let height: CGFloat
}

@main
struct AIWatchPreviewMain {
    @MainActor
    static func main() throws {
        let arguments = CommandLine.arguments
        guard arguments.count == 2, !arguments[1].isEmpty else {
            throw AIWatchPreviewError.usage
        }

        let outputDirectory = URL(fileURLWithPath: arguments[1], isDirectory: true)
        try FileManager.default.createDirectory(
            at: outputDirectory,
            withIntermediateDirectories: true
        )

        let specs = [
            AIWatchPreviewSpec(family: .systemSmall, mode: .overview, fixture: .enabledFour, name: "overview-four-small", width: 158, height: 158),
            AIWatchPreviewSpec(family: .systemMedium, mode: .overview, fixture: .enabledFour, name: "overview-four-medium", width: 338, height: 158),
            AIWatchPreviewSpec(family: .systemLarge, mode: .overview, fixture: .enabledFour, name: "overview-four-large", width: 338, height: 354),
            AIWatchPreviewSpec(family: .systemSmall, mode: .overview, fixture: .all, name: "overview-all-small", width: 158, height: 158),
            AIWatchPreviewSpec(family: .systemMedium, mode: .overview, fixture: .all, name: "overview-all-medium", width: 338, height: 158),
            AIWatchPreviewSpec(family: .systemLarge, mode: .overview, fixture: .all, name: "overview-all-large", width: 338, height: 354),
            AIWatchPreviewSpec(family: .systemSmall, mode: .provider(.codex), fixture: .enabledFour, name: "codex-small", width: 158, height: 158),
            AIWatchPreviewSpec(family: .systemMedium, mode: .provider(.codex), fixture: .enabledFour, name: "codex-medium", width: 338, height: 158)
        ]
        let referenceDate = Date(timeIntervalSince1970: 1_791_532_800)

        for language in ["en", "zh-CN"] {
            for theme in [AIWatchTheme.light, .dark] {
                let scheme: ColorScheme = theme == .dark ? .dark : .light
                let snapshot = AIWatchSnapshot.preview(theme: theme, language: language, date: referenceDate)
                let enabledFour = try AIWatchSnapshot(
                    generatedAt: snapshot.generatedAt,
                    sampledAt: snapshot.sampledAt,
                    theme: snapshot.theme,
                    language: snapshot.language,
                    isTestData: true,
                    rows: [.codex, .deepseek, .zcode, .kimi].compactMap(snapshot.row)
                )

                for spec in specs {
                    let selectedSnapshot = spec.fixture == .all ? snapshot : enabledFour
                    let entry = AIWatchTimelineEntry(
                        date: referenceDate,
                        state: .loaded(selectedSnapshot),
                        forceStale: false
                    )
                    let localeSuffix = language == "en" ? "" : "-zh-CN"
                    let filename = "\(spec.name)-\(theme.rawValue)\(localeSuffix).png"
                    let content = AIWatchWidgetRootView(
                        entry: entry,
                        mode: spec.mode,
                        familyOverride: spec.family
                    )
                        .environment(\.colorScheme, scheme)
                        .frame(width: spec.width, height: spec.height)

                    let renderer = ImageRenderer(content: content)
                    renderer.scale = 2
                    guard
                        let image = renderer.nsImage,
                        let representation = NSBitmapImageRep(data: image.tiffRepresentation ?? Data()),
                        let data = representation.representation(using: .png, properties: [:])
                    else { throw AIWatchPreviewError.renderFailed(filename) }

                    try data.write(to: outputDirectory.appendingPathComponent(filename), options: .atomic)
                    print(outputDirectory.appendingPathComponent(filename).path)
                }
            }
        }
    }
}
