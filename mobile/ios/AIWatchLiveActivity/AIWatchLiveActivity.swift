import ActivityKit
import SwiftUI
import WidgetKit

private func words(_ zh: String, _ en: String) -> String { Locale.preferredLanguages.first?.hasPrefix("zh") == true ? zh : en }
private func providerName(_ value: String) -> String { AttentionState.providerNames[value] ?? words("多个助手", "Multiple assistants") }

@available(iOSApplicationExtension 16.1, *)
struct AIWatchAttentionWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AIWatchAttentionAttributes.self) { context in
            let stale = isStale(context)
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Label("AI Watch", systemImage: "waveform.path.ecg").font(.headline)
                    Spacer(); Text(providerName(context.state.provider)).font(.subheadline).foregroundStyle(.white.opacity(0.7))
                }
                if stale { Label(words("状态已过期，打开 App 更新", "State expired; open the app to refresh"), systemImage: "clock.badge.exclamationmark").font(.subheadline) }
                else { counts(context.state) }
                HStack {
                    Text(words("点按打开 App 处理", "Tap to review in the app")).font(.caption)
                    Spacer()
                    if context.state.validFields { Text(Date(timeIntervalSince1970: Double(context.state.updatedAt)), style: .time).font(.caption.monospacedDigit()).foregroundStyle(.white.opacity(0.7)) }
                }
            }.padding(16).foregroundStyle(.white)
            .activityBackgroundTint(.black.opacity(0.9))
            .activitySystemActionForegroundColor(.white)
            .widgetURL(URL(string: "aiwatch://attention"))
        } dynamicIsland: { context in
            let stale = isStale(context)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Image(systemName: "waveform.path.ecg").foregroundStyle(.orange) }
                DynamicIslandExpandedRegion(.trailing) { Text(providerName(context.state.provider)).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                DynamicIslandExpandedRegion(.center) {
                    Text("AI Watch").font(.headline).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 8) {
                        if stale { Label(words("状态已过期", "State expired"), systemImage: "clock.badge.exclamationmark") }
                        else { counts(context.state) }
                        Text(words("打开 App 查看并处理", "Open the app to review and respond")).font(.caption).foregroundStyle(.secondary)
                    }.padding(.top, 6)
                }
            } compactLeading: {
                Image(systemName: stale ? "clock.badge.exclamationmark" : context.state.inputCount > 0 ? "questionmark.bubble.fill" : "checkmark.shield.fill").foregroundStyle(stale ? .gray : .orange)
            } compactTrailing: {
                Text(stale ? "—" : displayCount(context.state.total)).font(.caption.monospacedDigit()).foregroundStyle(.orange)
            } minimal: {
                Text(stale ? "—" : displayCount(context.state.total)).font(.caption.monospacedDigit()).foregroundStyle(.orange)
            }.widgetURL(URL(string: "aiwatch://attention")).keylineTint(.orange)
        }
    }
    private func isStale(_ context: ActivityViewContext<AIWatchAttentionAttributes>) -> Bool {
        if #available(iOSApplicationExtension 16.2, *) { return context.isStale || !context.state.validFields }
        return !context.state.isActive(at: Int(Date().timeIntervalSince1970))
    }
    private func displayCount(_ value: Int) -> String { value > 99 ? "99+" : String(max(0, value)) }
    private func counts(_ state: AttentionState) -> some View {
        HStack(spacing: 20) {
            Label { Text(words("待回答 ", "Answers ") + displayCount(state.inputCount)).monospacedDigit() } icon: { Image(systemName: "questionmark.bubble.fill").foregroundStyle(.orange) }
            Label { Text(words("待授权 ", "Approvals ") + displayCount(state.approvalCount)).monospacedDigit() } icon: { Image(systemName: "checkmark.shield.fill").foregroundStyle(.orange) }
        }.font(.headline)
    }
}

@main struct AIWatchLiveActivityBundle: WidgetBundle {
    var body: some Widget { AIWatchAttentionWidget() }
}
