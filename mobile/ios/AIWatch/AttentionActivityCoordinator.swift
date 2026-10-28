import ActivityKit
import Foundation
import UIKit

@available(iOS 16.1, *)
@MainActor final class AttentionActivityCoordinator {
    typealias Live = Activity<AIWatchAttentionAttributes>
    private let installation: String
    private let status: (String) -> Void
    private var credentials: Credentials?
    private var enabled = false
    private var foreground = false
    private var attention: AttentionState?
    private var attentionKnown = false
    private var currentID: String?
    private var ending = Set<String>()
    private var tokenObservers: [String: Task<Void, Never>] = [:]
    private var stateObservers: [String: Task<Void, Never>] = [:]
    private var activityObserver: Task<Void, Never>?
    private var authorizationObserver: Task<Void, Never>?
    private var startTokenObserver: Task<Void, Never>?
    private var expiryObserver: Task<Void, Never>?
    private var registered: [String: String] = [:]
    private var registrations: [String: Task<Void, Never>] = [:]
    private var desired: [String: Registration] = [:]
    private var pendingRetirements = Set<String>()
    private var retiring = Set<String>()
    private var retirementKey: String { "live-activity-retire-" + installation }
    private var retryCleanup = false
    private var cleanupInFlight = false
    private var cleanupKey: String { "live-activity-cleanup-" + installation }
    private var reconciling = false
    private var needsReconcile = false
    private var lastStartAttempt = Date.distantPast
    private var generation = 0
    private var suppressed = false
    private var suppressionKey: String { "live-activity-dismissed-" + installation }
    private struct Registration { let type: String; let token: String; let activityID: String? }
    init(installation: String, status: @escaping (String) -> Void) {
        self.installation = installation; self.status = status
        suppressed = UserDefaults.standard.bool(forKey: suppressionKey)
        retryCleanup = UserDefaults.standard.bool(forKey: cleanupKey)
        pendingRetirements = Set(UserDefaults.standard.stringArray(forKey: retirementKey) ?? [])
    }
    func configure(credentials: Credentials, enabled: Bool, foreground: Bool, explicitEnable: Bool = false) {
        self.credentials = credentials; self.enabled = enabled; self.foreground = foreground
        if explicitEnable { clearSuppression(); lastStartAttempt = .distantPast }
        observeActivities()
        if !enabled {
            Task { [weak self] in guard let self else { return }; await self.endLocalActivities(); if self.retryCleanup { await self.cleanupServer() } }
        } else { scheduleReconcile() }
    }
    func setForeground(_ value: Bool) { foreground = value; if value { retryRegistrations(); scheduleReconcile() } }
    func receive(_ value: AttentionState?) {
        attentionKnown = true
        attention = value?.validFields == true ? value : nil
        if attention?.total == 0 { clearSuppression() }
        scheduleReconcile()
    }
    func tick() { retryRegistrations(); scheduleReconcile() }
    private func clearSuppression() { suppressed = false; UserDefaults.standard.removeObject(forKey: suppressionKey) }
    private func suppressCurrent() {
        suppressed = true; UserDefaults.standard.set(true, forKey: suppressionKey)
    }
    private func observeActivities() {
        if activityObserver == nil {
            for activity in Live.activities { observe(activity) }
            activityObserver = Task { [weak self] in
                for await activity in Live.activityUpdates { guard !Task.isCancelled else { break }; self?.observe(activity) }
            }
        }
        guard enabled, authorizationObserver == nil else { return }
        authorizationObserver = Task { [weak self] in
            for await allowed in ActivityAuthorizationInfo().activityEnablementUpdates {
                guard !Task.isCancelled, let self else { break }
                if !allowed {
                    self.generation += 1
                    self.retryCleanup = true; UserDefaults.standard.set(true, forKey: self.cleanupKey)
                    await self.endLocalActivities()
                    for task in Array(self.registrations.values) { await task.value }
                    await self.cleanupServer(); self.status(L("系统已关闭实时活动"))
                } else { self.retryRegistrations(); self.scheduleReconcile() }
            }
        }
        if #available(iOS 17.2, *) {
            startTokenObserver = Task { [weak self] in
                for await token in Live.pushToStartTokenUpdates {
                    guard !Task.isCancelled, let self, self.enabled else { break }
                    self.register(.init(type: "start", token: token.map { String(format: "%02x", $0) }.joined(), activityID: nil))
                }
            }
        }
        expiryObserver = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5)); if Task.isCancelled { break }
                guard let self else { break }
                if self.foreground { self.scheduleReconcile() }
            }
        }
    }
    private func observe(_ activity: Live) {
        guard enabled, activity.attributes.scope == installation else {
            Task { [weak self] in await self?.end(activity) }; return
        }
        guard tokenObservers[activity.id] == nil else { return }
        if let currentID, currentID != activity.id, Live.activities.contains(where: { $0.id == currentID && $0.activityState != .ended && $0.activityState != .dismissed }) {
            Task { [weak self] in await self?.end(activity) }; return
        }
        currentID = activity.id
        if let token = activity.pushToken { register(.init(type: "update", token: token.map { String(format: "%02x", $0) }.joined(), activityID: activity.id)) }
        tokenObservers[activity.id] = Task { [weak self] in
            for await token in activity.pushTokenUpdates {
                guard !Task.isCancelled, let self, self.enabled else { break }
                self.register(.init(type: "update", token: token.map { String(format: "%02x", $0) }.joined(), activityID: activity.id))
            }
        }
        stateObservers[activity.id] = Task { [weak self] in
            for await state in activity.activityStateUpdates {
                guard !Task.isCancelled, let self else { break }
                if state == .ended || state == .dismissed {
                    if !self.ending.contains(activity.id) {
                        if state == .dismissed { self.suppressCurrent() }
                        await self.retire(activity.id)
                    }
                    self.tokenObservers.removeValue(forKey: activity.id)?.cancel()
                    if self.currentID == activity.id { self.currentID = nil }
                    self.stateObservers.removeValue(forKey: activity.id)
                    break
                }
            }
        }
        status(L("实时关注已开启"))
    }
    private func scheduleReconcile() {
        needsReconcile = true; guard !reconciling else { return }
        reconciling = true
        Task { [weak self] in
            guard let self else { return }
            while self.needsReconcile { self.needsReconcile = false; await self.reconcile() }
            self.reconciling = false
        }
    }
    private func reconcile() async {
        guard enabled, credentials != nil else { return }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { status(L("系统已关闭实时活动")); return }
        if retryCleanup { await cleanupServer(); if retryCleanup { return } }
        guard foreground, UIApplication.shared.applicationState == .active, attentionKnown else { return }
        let now = Int(Date().timeIntervalSince1970)
        guard let value = attention, value.isActive(at: now) else {
            await endLocalActivities(); status(L("实时关注已开启，等待待处理请求")); return
        }
        if let existing = Live.activities.first(where: { $0.id == currentID && $0.activityState != .ended && $0.activityState != .dismissed }) {
            // The app can update while active; APNs owns updates after suspension.
            if foreground {
                if #available(iOS 16.2, *) { if existing.content.state != value { await existing.update(.init(state: value, staleDate: Date(timeIntervalSince1970: Double(value.expiresAt)))) } }
                else if existing.contentState != value { await existing.update(using: value) }
            }
            return
        }
        guard AttentionActivityPolicy.mayStart(enabled: enabled, foreground: foreground, systemAllowed: true, attention: value, now: now, suppressed: suppressed), Date().timeIntervalSince(lastStartAttempt) >= 10 else { return }
        lastStartAttempt = Date()
        do {
            let activity: Live
            if #available(iOS 16.2, *) { activity = try Live.request(attributes: .init(scope: installation), content: .init(state: value, staleDate: Date(timeIntervalSince1970: Double(value.expiresAt))), pushType: .token) }
            else { activity = try Live.request(attributes: .init(scope: installation), contentState: value, pushType: .token) }
            currentID = activity.id; observe(activity)
        } catch { status(L("暂时无法创建实时活动，请检查系统设置")) }
    }
    private func register(_ value: Registration) {
        guard enabled, ActivityAuthorizationInfo().areActivitiesEnabled, let credentials else { return }
        let key = value.activityID ?? "start"
        desired[key] = value
        guard !retryCleanup else { return }
        guard registered[key] != value.token, registrations[key] == nil else { return }
        let stamp = generation
        registrations[key] = Task { [weak self] in
            guard let self else { return }
            let client = CloudAPI(credentials); defer { client.close(); self.registrations[key] = nil }
            do {
                try await client.registerLiveActivity(type: value.type, token: value.token, activityID: value.activityID)
                guard self.enabled, self.generation == stamp else { return }
                self.registered[key] = value.token
                self.status(L("实时活动推送已登记"))
            } catch { if self.enabled && self.generation == stamp { self.status(L("实时活动已在本机开启，远程更新登记待重试")) } }
        }
    }
    private func retryRegistrations() {
        if retryCleanup { Task { [weak self] in await self?.cleanupServer() } }
        for id in pendingRetirements { Task { [weak self] in await self?.retire(id) } }
        guard enabled else { return }
        for value in Array(desired.values) { register(value) }
    }
    private func retire(_ activityID: String) async {
        desired.removeValue(forKey: activityID); registered.removeValue(forKey: activityID)
        pendingRetirements.insert(activityID); saveRetirements()
        guard !retiring.contains(activityID) else { return }
        retiring.insert(activityID); defer { retiring.remove(activityID) }
        await registrations[activityID]?.value
        guard let credentials else { return }
        let client = CloudAPI(credentials); defer { client.close() }
        do {
            try await client.removeLiveActivity(activityID: activityID)
            pendingRetirements.remove(activityID); saveRetirements()
        } catch { /* Preserve the retirement for the next connected foreground tick. */ }
    }
    private func saveRetirements() { UserDefaults.standard.set(Array(pendingRetirements).sorted(), forKey: retirementKey) }
    private func end(_ activity: Live) async {
        ending.insert(activity.id)
        let final = AttentionState(inputCount: 0, approvalCount: 0, provider: "none", updatedAt: Int(Date().timeIntervalSince1970), expiresAt: Int(Date().timeIntervalSince1970))
        if #available(iOS 16.2, *) { await activity.end(.init(state: final, staleDate: nil), dismissalPolicy: .immediate) }
        else { await activity.end(using: final, dismissalPolicy: .immediate) }
        tokenObservers.removeValue(forKey: activity.id)?.cancel(); stateObservers.removeValue(forKey: activity.id)?.cancel()
        if currentID == activity.id { currentID = nil }
        await retire(activity.id); ending.remove(activity.id)
    }
    private func endLocalActivities() async { for activity in Live.activities { await end(activity) } }
    func disable() async {
        enabled = false; generation += 1; clearSuppression()
        authorizationObserver?.cancel(); authorizationObserver = nil
        startTokenObserver?.cancel(); startTokenObserver = nil; expiryObserver?.cancel(); expiryObserver = nil
        await endLocalActivities()
        for task in Array(registrations.values) { await task.value }
        desired.removeAll(); registered.removeAll()
        retryCleanup = true; UserDefaults.standard.set(true, forKey: cleanupKey); await cleanupServer()
        if !retryCleanup { status(L("实时关注已关闭")) }
    }
    private func cleanupServer() async {
        guard !cleanupInFlight else { return }
        guard let credentials else { return }
        cleanupInFlight = true
        let client = CloudAPI(credentials); defer { client.close(); cleanupInFlight = false }
        do {
            try await client.removeLiveActivity(); retryCleanup = false
            UserDefaults.standard.removeObject(forKey: cleanupKey); registered.removeAll()
            pendingRetirements.removeAll(); saveRetirements()
            if enabled { retryRegistrations(); scheduleReconcile() }
        } catch { retryCleanup = true; UserDefaults.standard.set(true, forKey: cleanupKey); status(L("本机实时活动已结束，云端注销将在联网后重试")) }
    }
}
