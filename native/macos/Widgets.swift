import SwiftUI
import WidgetKit

private let aiWatchPanelURL = URL(string: "aiwatch://panel")!

struct AIWatchTimelineEntry: TimelineEntry, Sendable {
    let date: Date
    let state: AIWatchSnapshotLoadState
    let forceStale: Bool
}

struct AIWatchTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> AIWatchTimelineEntry {
        AIWatchTimelineEntry(
            date: Date(),
            state: .loaded(AIWatchSnapshot.preview()),
            forceStale: false
        )
    }

    func getSnapshot(in context: Context, completion: @escaping (AIWatchTimelineEntry) -> Void) {
        let now = Date()
        let state = context.isPreview
            ? AIWatchSnapshotLoadState.loaded(AIWatchSnapshot.preview(date: now))
            : AIWatchSnapshotReader.load()
        completion(AIWatchTimelineEntry(date: now, state: state, forceStale: false))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<AIWatchTimelineEntry>) -> Void) {
        let now = Date()
        let state = AIWatchSnapshotReader.load()
        var entries = [AIWatchTimelineEntry(date: now, state: state, forceStale: false)]

        if let snapshot = state.snapshot {
            let actualDeadline = snapshot.sampledAtDate?.addingTimeInterval(AIWatchSnapshot.staleInterval) ?? now
            let staleDate = max(actualDeadline, now.addingTimeInterval(60))
            entries.append(AIWatchTimelineEntry(date: staleDate, state: state, forceStale: true))
        }

        // WidgetKit scheduling is best-effort. The future entry still makes the UI
        // degrade to cached/unknown activity if the host app stops exporting data.
        let reload = now.addingTimeInterval(AIWatchSnapshot.staleInterval)
        completion(Timeline(entries: entries, policy: .after(reload)))
    }
}

enum AIWatchWidgetMode: Equatable {
    case overview
    case provider(AIWatchProviderID)
}

struct AIWatchWidgetRootView: View {
    let entry: AIWatchTimelineEntry
    let mode: AIWatchWidgetMode
    var familyOverride: WidgetFamily? = nil

    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var systemColorScheme

    var body: some View {
        let snapshot = entry.state.snapshot
        let palette = AIWatchPalette(preference: snapshot?.theme, system: systemColorScheme)
        AIWatchWidgetContent(
            entry: entry,
            mode: mode,
            family: familyOverride ?? family,
            palette: palette
        )
        .background(palette.canvas)
        .containerBackground(for: .widget) { palette.canvas }
        .widgetURL(aiWatchPanelURL)
    }
}

private struct AIWatchWidgetContent: View {
    let entry: AIWatchTimelineEntry
    let mode: AIWatchWidgetMode
    let family: WidgetFamily
    let palette: AIWatchPalette

    private var snapshot: AIWatchSnapshot? { entry.state.snapshot }
    private var copy: AIWatchCopy { AIWatchCopy(language: snapshot?.language) }
    private var snapshotIsStale: Bool {
        snapshot?.isStale(at: entry.date, forceStale: entry.forceStale) ?? true
    }

    var body: some View {
        VStack(alignment: .leading, spacing: family == .systemLarge ? 6 : 4) {
            AIWatchHeader(
                snapshot: snapshot,
                stale: snapshotIsStale,
                family: family,
                copy: copy,
                palette: palette
            )
            switch entry.state {
            case .loaded(let snapshot):
                switch mode {
                case .overview:
                    AIWatchOverview(
                        snapshot: snapshot,
                        family: family,
                        stale: snapshotIsStale,
                        copy: copy,
                        palette: palette
                    )
                case .provider(let provider):
                    AIWatchProviderDetail(
                        provider: provider,
                        row: snapshot.row(for: provider),
                        family: family,
                        stale: snapshotIsStale,
                        copy: copy,
                        palette: palette
                    )
                }
            case .missing, .unavailable, .invalid:
                AIWatchEmptyState(copy: copy, palette: palette)
            }
        }
        .padding(family == .systemLarge ? 14 : 10)
        .foregroundStyle(palette.text)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct AIWatchHeader: View {
    let snapshot: AIWatchSnapshot?
    let stale: Bool
    let family: WidgetFamily
    let copy: AIWatchCopy
    let palette: AIWatchPalette

    var body: some View {
        HStack(spacing: family == .systemSmall ? 2 : 4) {
            Circle()
                .fill(stale ? palette.warning : palette.green)
                .frame(width: 6, height: 6)
            Text("AI WATCH")
                .font(.system(size: family == .systemSmall ? 8 : 10, weight: .bold, design: .rounded).width(.condensed))
                .tracking(family == .systemSmall ? 0 : 0.5)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .layoutPriority(1)
            Spacer(minLength: 2)
            if snapshot?.isTestData == true {
                Text(copy.sample)
                    .font(.system(size: family == .systemSmall ? 7 : 8, weight: .bold, design: .rounded))
                    .foregroundStyle(palette.testText)
                    .lineLimit(1)
                    .padding(.horizontal, family == .systemSmall ? 4 : 5)
                    .padding(.vertical, 2)
                    .background(palette.testBackground, in: Capsule())
                    .fixedSize(horizontal: true, vertical: false)
            }
            if let date = snapshot?.sampledAtDate ?? snapshot?.generatedAtDate {
                Text(date, style: .time)
                    .font(.system(size: family == .systemSmall ? 8 : 9, weight: .medium, design: .rounded))
                    .foregroundStyle(palette.muted)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(stale ? copy.cached : copy.updated)
    }
}

private struct AIWatchOverview: View {
    let snapshot: AIWatchSnapshot
    let family: WidgetFamily
    let stale: Bool
    let copy: AIWatchCopy
    let palette: AIWatchPalette

    private var displayedProviders: [AIWatchProviderID] {
        family == .systemSmall
            ? Array(snapshot.rows.map(\.id).prefix(2))
            : snapshot.rows.map(\.id)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: family == .systemLarge ? 5 : 3) {
            if family != .systemMedium {
                HStack {
                    Text(copy.overview)
                        .font(.system(size: family == .systemLarge ? 15 : 12, weight: .semibold, design: .rounded))
                    Spacer()
                    if stale {
                        Text(copy.cached)
                            .font(.system(size: 8, weight: .semibold, design: .rounded))
                            .foregroundStyle(palette.warning)
                    }
                }
            }

            if snapshot.rows.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text(copy.noProvidersEnabled)
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                    Text(copy.enableInApp)
                        .font(.system(size: 10, weight: .medium, design: .rounded))
                        .foregroundStyle(palette.muted)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            } else if family == .systemMedium {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 5) {
                    ForEach(displayedProviders, id: \.self) { provider in
                        AIWatchProviderLine(
                            provider: provider,
                            row: snapshot.row(for: provider),
                            stale: stale,
                            compact: true,
                            copy: copy,
                            palette: palette
                        )
                    }
                }
            } else {
                ForEach(displayedProviders, id: \.self) { provider in
                    AIWatchProviderLine(
                        provider: provider,
                        row: snapshot.row(for: provider),
                        stale: stale,
                        compact: true,
                        copy: copy,
                        palette: palette
                    )
                }
            }

            if family == .systemSmall {
                let remainingCount = snapshot.rows.count - displayedProviders.count
                if remainingCount > 0 {
                    Text(copy.moreProviders(remainingCount))
                        .font(.system(size: 9, weight: .medium, design: .rounded))
                        .foregroundStyle(palette.muted)
                }
            } else if family == .systemLarge {
                Spacer(minLength: 0)
                Text(stale ? copy.cachedExplanation : copy.updated)
                    .font(.system(size: 10, weight: .medium, design: .rounded))
                    .foregroundStyle(stale ? palette.warning : palette.muted)
            }
        }
    }
}

private struct AIWatchProviderLine: View {
    let provider: AIWatchProviderID
    let row: AIWatchWidgetRow?
    let stale: Bool
    let compact: Bool
    let copy: AIWatchCopy
    let palette: AIWatchPalette

    var body: some View {
        HStack(spacing: 7) {
            RoundedRectangle(cornerRadius: 2.5)
                .fill(Color(rgb: provider.colorHex))
                .frame(width: 5, height: compact ? 22 : 27)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Text(row?.name ?? provider.defaultName)
                        .font(.system(size: compact ? 10 : 11, weight: .semibold, design: .rounded).width(.condensed))
                        .lineLimit(1)
                    if row == nil {
                        Text(copy.disabled)
                            .font(.system(size: 8, weight: .medium, design: .rounded))
                            .foregroundStyle(palette.muted)
                    }
                }
                Text(row.map { stale || $0.stale ? copy.cachedSummary($0.summary) : $0.summary } ?? copy.noCachedData)
                    .font(.system(size: compact ? 8.5 : 9.5, weight: .medium, design: .rounded).width(.condensed))
                    .foregroundStyle(row == nil ? palette.faint : palette.secondary)
                    .lineLimit(1)
                if let remaining = row?.remaining {
                    AIWatchProgressBar(
                        value: remaining,
                        color: stale || row?.stale == true ? palette.warning : Color(rgb: provider.colorHex),
                        track: palette.track
                    )
                    .frame(height: 2)
                }
            }
            Spacer(minLength: 2)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, compact ? 2 : 4)
        .background(palette.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

private struct AIWatchProviderDetail: View {
    let provider: AIWatchProviderID
    let row: AIWatchWidgetRow?
    let family: WidgetFamily
    let stale: Bool
    let copy: AIWatchCopy
    let palette: AIWatchPalette

    var body: some View {
        if let row {
            let rowIsStale = stale || row.stale
            HStack(alignment: .center, spacing: family == .systemMedium ? 15 : 10) {
                AIWatchBrandMark(
                    provider: provider,
                    size: family == .systemMedium ? 70 : 48
                )
                details(row: row, stale: rowIsStale)
            }
            .padding(10)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .background(palette.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        } else {
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 8) {
                    Circle().fill(Color(rgb: provider.colorHex)).frame(width: 9, height: 9)
                    Text(provider.defaultName)
                        .font(.system(size: 16, weight: .bold, design: .rounded).width(.condensed))
                }
                Text(copy.providerDisabled)
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                Text(copy.noCachedExplanation)
                    .font(.system(size: 10, weight: .medium, design: .rounded))
                    .foregroundStyle(palette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .background(palette.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
    }

    private func details(row: AIWatchWidgetRow, stale: Bool) -> some View {
        VStack(alignment: .leading, spacing: family == .systemMedium ? 6 : 4) {
            Text(row.name)
                .font(.system(size: family == .systemMedium ? 18 : 14, weight: .bold, design: .rounded).width(.condensed))
                .lineLimit(1)
            if let remaining = row.remaining {
                Text(copy.remainingScope(row.summary))
                    .font(.system(size: family == .systemMedium ? 10 : 9, weight: .semibold, design: .rounded).width(.condensed))
                    .foregroundStyle(palette.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Text(AIWatchFormat.remaining(remaining))
                        .font(.system(size: family == .systemMedium ? 29 : 21, weight: .bold, design: .rounded).width(.condensed))
                        .foregroundStyle(stale ? palette.warning : palette.strong)
                    if stale {
                        Text(copy.cached)
                            .font(.system(size: 8, weight: .bold, design: .rounded))
                            .foregroundStyle(palette.warning)
                            .lineLimit(1)
                    }
                }
                AIWatchProgressBar(
                    value: remaining,
                    color: stale ? palette.warning : Color(rgb: provider.colorHex),
                    track: palette.track
                )
                .frame(height: family == .systemMedium ? 5 : 4)
            } else {
                Text(row.summary)
                    .font(.system(size: family == .systemMedium ? 12 : 10, weight: .semibold, design: .rounded).width(.condensed))
                    .foregroundStyle(stale ? palette.warning : palette.secondary)
                    .lineLimit(2)
            }
            statusLine(row: row, stale: stale)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func statusLine(row: AIWatchWidgetRow, stale: Bool) -> some View {
        let activity = stale ? "unknown" : row.activity
        return HStack(spacing: 5) {
            Circle()
                .fill(stale ? palette.warning : palette.activity(activity))
                .frame(width: 6, height: 6)
            Text(copy.activity(activity))
                .font(.system(size: 10, weight: .medium, design: .rounded).width(.condensed))
                .foregroundStyle(stale ? palette.warning : palette.muted)
                .lineLimit(1)
            if stale && row.remaining == nil {
                Text(copy.cached)
                    .font(.system(size: 8, weight: .bold, design: .rounded))
                    .foregroundStyle(palette.warning)
            }
        }
    }
}

private struct AIWatchBrandMark: View {
    let provider: AIWatchProviderID
    let size: CGFloat

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color(rgb: provider.colorHex))
                .frame(width: size, height: size)
            Text(provider.initials)
                .font(.system(size: 16, weight: .black, design: .rounded).width(.condensed))
                .foregroundStyle(Color(rgb: 0x111519))
                .fixedSize()
                .layoutPriority(1)
        }
        .frame(width: size, height: size)
        .fixedSize()
        .accessibilityHidden(true)
    }
}

private struct AIWatchProgressBar: View {
    let value: Double
    let color: Color
    let track: Color

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(track)
                Capsule()
                    .fill(color)
                    .frame(width: geometry.size.width * min(max(value, 0), 100) / 100)
            }
        }
        .accessibilityHidden(true)
    }
}

private enum AIWatchFormat {
    static func remaining(_ value: Double) -> String {
        let rounded = (value * 10).rounded() / 10
        if rounded.rounded(.towardZero) == rounded { return "\(Int(rounded))%" }
        return String(format: "%.1f%%", locale: Locale(identifier: "en_US_POSIX"), rounded)
    }
}

private struct AIWatchEmptyState: View {
    let copy: AIWatchCopy
    let palette: AIWatchPalette

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(palette.muted)
            Text(copy.openToSync)
                .font(.system(size: 14, weight: .semibold, design: .rounded))
            Text(copy.noSnapshotExplanation)
                .font(.system(size: 10, weight: .medium, design: .rounded))
                .foregroundStyle(palette.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(palette.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

private struct AIWatchCopy {
    let isChinese: Bool

    init(language: String?) {
        isChinese = language?.lowercased().hasPrefix("zh") == true
    }

    var overview: String { isChinese ? "额度与活动概览" : "Quota & activity" }
    var sample: String { isChinese ? "测试" : "SAMPLE" }
    var cached: String { isChinese ? "缓存 · 非实时" : "CACHED · NOT LIVE" }
    var updated: String { isChinese ? "已更新" : "Updated" }
    var disabled: String { isChinese ? "已停用" : "Disabled" }
    var noCachedData: String { isChinese ? "无历史数据" : "No cached data" }
    var noProvidersEnabled: String { isChinese ? "未启用提供商" : "No providers enabled" }
    var enableInApp: String { isChinese ? "在 AI Watch 中启用后会显示在这里。" : "Enable a provider in AI Watch to show it here." }
    var providerDisabled: String { isChinese ? "此提供商已停用" : "Provider disabled" }
    var noCachedExplanation: String {
        isChinese ? "AI Watch 不会显示停用前的缓存数据。" : "AI Watch does not show data cached before it was disabled."
    }
    var openToSync: String { isChinese ? "打开 AI Watch 以同步" : "Open AI Watch to sync" }
    var noSnapshotExplanation: String {
        isChinese ? "桌面小组件会在应用导出有效快照后显示数据。" : "The widget shows data after the app exports a valid snapshot."
    }
    var cachedExplanation: String {
        isChinese ? "采样超过 15 分钟；数值为缓存，活动未知。" : "Sample is over 15 minutes old; values are cached and activity is unknown."
    }

    func cachedSummary(_ summary: String) -> String {
        isChinese ? "缓存 · \(summary)" : "Cached · \(summary)"
    }

    func moreProviders(_ count: Int) -> String {
        isChinese ? "另有 \(count) 个提供商" : "+\(count) more providers"
    }

    func remainingScope(_ summary: String) -> String {
        let scope = summary.components(separatedBy: " · ").first?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let remaining = isChinese ? "剩余" : "Remaining"
        return scope.isEmpty ? remaining : "\(scope) · \(remaining)"
    }

    func activity(_ value: String) -> String {
        switch value {
        case "running": isChinese ? "运行中" : "Running"
        case "waiting": isChinese ? "等待中" : "Waiting"
        case "idle": isChinese ? "空闲" : "Idle"
        case "offline": isChinese ? "离线" : "Offline"
        default: isChinese ? "活动未知" : "Activity unknown"
        }
    }
}

private struct AIWatchPalette {
    let canvas: Color
    let card: Color
    let text: Color
    let muted: Color
    let secondary: Color
    let faint: Color
    let strong: Color
    let track: Color
    let green: Color
    let warning: Color
    let danger: Color
    let testText: Color
    let testBackground: Color

    init(preference: AIWatchTheme?, system: ColorScheme) {
        let dark = preference == .dark || (preference != .light && system == .dark)
        if dark {
            canvas = Color(rgb: 0x111519)
            card = Color(rgb: 0x171D24)
            text = Color(rgb: 0xE1E7EE)
            muted = Color(rgb: 0x8B98A5)
            secondary = Color(rgb: 0x8795A3)
            faint = Color(rgb: 0x616A76)
            strong = Color(rgb: 0xBFCCDB)
            track = Color(rgb: 0x2A3037)
            green = Color(rgb: 0x8BC5A4)
            warning = Color(rgb: 0xBB9B72)
            danger = Color(rgb: 0xFF848B)
            testText = Color(rgb: 0xEBD3A5)
            testBackground = Color(rgb: 0x3A3225)
        } else {
            canvas = Color(rgb: 0xEDF1F5)
            card = Color(rgb: 0xFFFFFF)
            text = Color(rgb: 0x233746)
            muted = Color(rgb: 0x627383)
            secondary = Color(rgb: 0x5D7080)
            faint = Color(rgb: 0x657585)
            strong = Color(rgb: 0x344C60)
            track = Color(rgb: 0xDCE4EB)
            green = Color(rgb: 0x38815C)
            warning = Color(rgb: 0x947035)
            danger = Color(rgb: 0xB72035)
            testText = Color(rgb: 0x7A561D)
            testBackground = Color(rgb: 0xFFF1D5)
        }
    }

    func activity(_ value: String) -> Color {
        switch value {
        case "running": green
        case "waiting": warning
        case "offline": danger
        default: muted
        }
    }
}

private extension AIWatchProviderID {
    var initials: String {
        switch self {
        case .claude: "CC"
        case .codex: "CX"
        case .antigravity: "AG"
        case .deepseek: "DS"
        case .zcode: "ZC"
        case .kimi: "KM"
        case .qwen: "QW"
        case .workbuddy: "WB"
        }
    }
}

private extension Color {
    init(rgb: UInt32) {
        self.init(
            red: Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8) & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255
        )
    }
}

private struct AIWatchOverviewWidget: Widget {
    let kind = "AIWatch.Overview"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: AIWatchTimelineProvider()) { entry in
            AIWatchWidgetRootView(entry: entry, mode: .overview)
        }
        .configurationDisplayName("AI Watch 概览 / Overview")
        .description("配额、余额与活动快照。Quota, balance, and activity snapshot.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
        .contentMarginsDisabled()
    }
}

private protocol AIWatchProviderDescriptor {
    static var provider: AIWatchProviderID { get }
    static var kind: String { get }
}

private struct AIWatchClaudeDescriptor: AIWatchProviderDescriptor {
    static let provider = AIWatchProviderID.claude
    static let kind = "AIWatch.Claude"
}
private struct AIWatchCodexDescriptor: AIWatchProviderDescriptor {
    static let provider = AIWatchProviderID.codex
    static let kind = "AIWatch.Codex"
}
private struct AIWatchAntigravityDescriptor: AIWatchProviderDescriptor {
    static let provider = AIWatchProviderID.antigravity
    static let kind = "AIWatch.Antigravity"
}
private struct AIWatchDeepSeekDescriptor: AIWatchProviderDescriptor {
    static let provider = AIWatchProviderID.deepseek
    static let kind = "AIWatch.DeepSeek"
}
private struct AIWatchZCodeDescriptor: AIWatchProviderDescriptor {
    static let provider = AIWatchProviderID.zcode
    static let kind = "AIWatch.ZCode"
}
private struct AIWatchKimiDescriptor: AIWatchProviderDescriptor {
    static let provider = AIWatchProviderID.kimi
    static let kind = "AIWatch.Kimi"
}
private struct AIWatchQwenDescriptor: AIWatchProviderDescriptor {
    static let provider = AIWatchProviderID.qwen
    static let kind = "AIWatch.Qwen"
}
private struct AIWatchWorkBuddyDescriptor: AIWatchProviderDescriptor {
    static let provider = AIWatchProviderID.workbuddy
    static let kind = "AIWatch.WorkBuddy"
}

private struct AIWatchProviderWidget<Descriptor: AIWatchProviderDescriptor>: Widget {
    init() {}

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Descriptor.kind, provider: AIWatchTimelineProvider()) { entry in
            AIWatchWidgetRootView(entry: entry, mode: .provider(Descriptor.provider))
        }
        .configurationDisplayName("\(Descriptor.provider.defaultName) · AI Watch")
        .description("提供商配额与活动。Provider quota and activity.")
        .supportedFamilies([.systemSmall, .systemMedium])
        .contentMarginsDisabled()
    }
}

#if !WIDGET_PREVIEW
@main
struct AIWatchWidgetBundle: WidgetBundle {
    var body: some Widget {
        AIWatchOverviewWidget()
        AIWatchProviderWidget<AIWatchClaudeDescriptor>()
        AIWatchProviderWidget<AIWatchCodexDescriptor>()
        AIWatchProviderWidget<AIWatchAntigravityDescriptor>()
        AIWatchProviderWidget<AIWatchDeepSeekDescriptor>()
        AIWatchProviderWidget<AIWatchZCodeDescriptor>()
        AIWatchProviderWidget<AIWatchKimiDescriptor>()
        AIWatchProviderWidget<AIWatchQwenDescriptor>()
        AIWatchProviderWidget<AIWatchWorkBuddyDescriptor>()
    }
}
#endif
