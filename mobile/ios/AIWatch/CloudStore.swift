import Foundation
import SwiftUI
import UserNotifications
import UIKit
import CryptoKit

@MainActor final class CloudStore: ObservableObject {
    static let shared = CloudStore()
    @Published var credentials = Keychain.read()
    @Published var state: CloudState?
    @Published var now = Date()
    @Published var connected = false
    @Published var message = ""
    @Published var pushMessage = L("通知尚未启用")
    @Published var busy = false
    @Published var liveUpdatesEnabled = UserDefaults.standard.bool(forKey: "live-updates-enabled")
    @Published var liveUpdatesStatus = L("实时关注未启用")
    @Published var attentionOpenSequence = 0
    private var liveCoordinatorStorage: AnyObject?
    @available(iOS 16.1, *) private var liveCoordinator: AttentionActivityCoordinator {
        if let value = liveCoordinatorStorage as? AttentionActivityCoordinator { return value }
        let value = AttentionActivityCoordinator(installation: installation) { [weak self] message in self?.liveUpdatesStatus = message }
        liveCoordinatorStorage = value; return value
    }
    init() { Task { [weak self] in self?.restoreLiveUpdates() } }
    private func restoreLiveUpdates() {
        guard let credentials else { return }
        if #available(iOS 16.1, *) { liveCoordinator.configure(credentials: credentials, enabled: liveUpdatesEnabled, foreground: active) }
        else if liveUpdatesEnabled { liveUpdatesStatus = L("实时活动需要 iOS 16.1 或更新版本") }
    }
    @discardableResult func setLiveUpdates(_ enabled: Bool) async -> Bool {
        guard credentials != nil else { message = L("请先连接服务器"); return false }
        guard #available(iOS 16.1, *) else { liveUpdatesStatus = L("实时活动需要 iOS 16.1 或更新版本"); return false }
        liveUpdatesEnabled = enabled; UserDefaults.standard.set(enabled, forKey: "live-updates-enabled")
        if enabled, let credentials {
            liveCoordinator.configure(credentials: credentials, enabled: true, foreground: active, explicitEnable: true)
            if let state { liveCoordinator.receive(online && state.snapshot?.sample != true && state.snapshot?.stale != true ? state.attention : nil) }
        } else { await liveCoordinator.disable() }
        return true
    }
    func openAttention() {
        attentionOpenSequence += 1
        Task { await refresh() }
    }
    @Published var readAlertIDs = Set<String>()
    @Published var alertBanner = ""
    private var knownAlertIDs = Set<String>()
    private var api: CloudAPI?
    private var stream: Task<Void, Never>?
    private var fallback: Task<Void, Never>?
    private var active = false
    private var receivedLocally: Date?
    private var pushToken: String?
    private var registeredToken: String?
    private var registrationTask: Task<Void, Never>?
    private var loggingOut = false
    let installation: String = {
        if let value = UserDefaults.standard.string(forKey: "installation") { return value }
        let value = UUID().uuidString.lowercased(); UserDefaults.standard.set(value, forKey: "installation"); return value
    }()
    var online: Bool { state?.fresh(at: now) == true && receivedLocally.map { now.timeIntervalSince($0) < 25 } == true }
    var actionable: Bool { online && state?.snapshot?.sample != true && state?.snapshot?.stale != true }
    private var alertReadKey: String? {
        guard let credentials else { return nil }
        let digest = SHA256.hash(data: Data((credentials.server + "\n" + credentials.token).utf8))
        return "alert-read-" + digest.map { String(format: "%02x", $0) }.joined()
    }
    var unreadAlerts: Int { (state?.alerts ?? []).filter { !readAlertIDs.contains($0.id) }.count }
    func markAlertRead(_ id: String) {
        readAlertIDs.insert(id)
        if let key = alertReadKey { UserDefaults.standard.set(Array(readAlertIDs).suffix(500).map { $0 }, forKey: key) }
        if unreadAlerts == 0 { alertBanner = "" }
    }
    func markAllAlertsRead() { for alert in state?.alerts ?? [] { markAlertRead(alert.id) } }
    func openAlert(_ alert: CloudAlert) -> PendingRequest? {
        markAlertRead(alert.id)
        guard alert.active, actionable,
              let request = state?.snapshot?.requests.first(where: { $0.id == alert.requestId }), request.valid(at: Date()),
              state?.commands.contains(where: { $0.requestId == request.id }) != true else {
            message = L("提醒已解除或需在电脑处理。"); return nil
        }
        return request
    }
    @discardableResult func configure(server: String, token: String) async -> Bool {
        busy = true; defer { busy = false }
        do {
            let bootstrap = try Credentials.validate(server: server, token: token)
            let pairing = CloudAPI(bootstrap); defer { pairing.close() }
            let value = try await pairing.pair(installation: installation)
            let probe = CloudAPI(value); defer { probe.close() }
            _ = try await probe.state()
            try Keychain.save(value)
            stop(); credentials = value; registeredToken = nil; message = ""; start()
            await enableNotifications(); return true
        } catch { report(error); return false }
    }
    func setActive(_ value: Bool) {
        active = value
        if #available(iOS 16.1, *) { liveCoordinator.setForeground(value) }
        if value { start() } else { stop() }
    }
    func start() {
        guard active, stream == nil, let credentials else { return }
        if let key = alertReadKey { readAlertIDs = Set(UserDefaults.standard.stringArray(forKey: key) ?? []) }
        restoreLiveUpdates()
        let client = CloudAPI(credentials); api = client
        stream = Task { [weak self] in
            guard let self else { return }
            await refresh()
            while !Task.isCancelled {
                do {
                    try await client.events(receive: { [weak self] state in await self?.accept(state, from: client) },
                                            connected: { [weak self] in await self?.markConnected(client) })
                } catch { if !Task.isCancelled && self.api === client { report(error) } }
                if self.api === client { connected = false }
                if Task.isCancelled { break }
                try? await Task.sleep(for: .seconds(5))
            }
        }
        fallback = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5)); if Task.isCancelled { break }
                guard let self else { break }
                now = Date()
                if !connected { await refresh() }
                registerPush()
                if #available(iOS 16.1, *) { liveCoordinator.tick() }
            }
        }
        registerPush()
        Task {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional {
                UIApplication.shared.registerForRemoteNotifications()
            } else { pushMessage = L("系统通知尚未开启") }
        }
    }
    func stop() {
        stream?.cancel(); fallback?.cancel(); stream = nil; fallback = nil
        api?.close(); api = nil; connected = false; receivedLocally = nil
    }
    private func markConnected(_ source: CloudAPI) { if api === source { connected = true } }
    private func accept(_ value: CloudState, from source: CloudAPI) {
        guard api === source else { return }
        let alerts = value.alerts ?? []
        if let incoming = alerts.last(where: { $0.active && !knownAlertIDs.contains($0.id) && !readAlertIDs.contains($0.id) }) {
            alertBanner = alertTitle(incoming.type)
        }
        knownAlertIDs.formUnion(alerts.map(\.id))
        state = value; receivedLocally = Date(); now = Date(); message = ""
        if #available(iOS 16.1, *) { liveCoordinator.receive(online && value.snapshot?.sample != true && value.snapshot?.stale != true ? value.attention : nil) }
    }
    @discardableResult func refresh() async -> Bool {
        guard let api else { return false }
        do { let result = try await api.state(); accept(result, from: api); return true }
        catch { if self.api === api { report(error) }; return false }
    }
    func send(_ command: Command) async -> Bool {
        guard let api, actionable, let request = state?.snapshot?.requests.first(where: { $0.id == command.requestId }),
              request.valid(at: Date()) else { message = L("桌面离线或请求已失效，请刷新。"); return false }
        busy = true; defer { busy = false }
        do {
            try command.validate(for: request)
            let result = try await api.command(command)
            message = L("操作状态：") + statusLabel(result.status)
            await refresh(); return true
        } catch { report(error); return false }
    }
    @discardableResult func logout() async -> Bool {
        busy = true; loggingOut = true; defer { busy = false; loggingOut = false }
        await registrationTask?.value
        liveUpdatesEnabled = false; UserDefaults.standard.set(false, forKey: "live-updates-enabled")
        if #available(iOS 16.1, *) { await liveCoordinator.disable() }
        do {
            // Keep credentials if revocation fails, so a retry can actually stop pushes.
            if let credentials { let client = CloudAPI(credentials); defer { client.close() }; try await client.revokePair() }
            stop(); Keychain.clear(); credentials = nil; state = nil; registeredToken = nil
            knownAlertIDs.removeAll(); readAlertIDs.removeAll(); alertBanner = ""
            message = ""; pushMessage = L("已断开并注销此手机推送"); return true
        } catch { report(error); return false }
    }
    func enableNotifications() async {
        do {
            let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            pushMessage = allowed ? L("正在注册推送") : L("系统通知已关闭，可在系统设置中开启")
            if allowed { UIApplication.shared.registerForRemoteNotifications() }
        } catch { pushMessage = L("无法申请通知权限") }
    }
    func receivedPushToken(_ token: String) { pushToken = token; registerPush() }
    func pushRegistrationFailed() { pushMessage = L("推送注册失败，请检查签名与网络") }
    private func registerPush() {
        guard !loggingOut, registrationTask == nil, let token = pushToken, registeredToken != token, let api else { return }
        registrationTask = Task {
            defer { registrationTask = nil }
            do {
                try await api.register(token: token, id: installation)
                if self.api === api { registeredToken = token; pushMessage = L("推送已注册") }
            } catch { if self.api === api { pushMessage = L("推送登记失败，将自动重试") } }
        }
    }
    private func report(_ error: Error) {
        if error is CancellationError || (error as NSError).code == NSURLErrorCancelled { return }
        message = (error as? CloudError)?.localizedDescription ?? L("无法同步，请检查网络与服务器。")
    }
}

func statusLabel(_ value: String) -> String {
    ["queued": L("已排队"), "delivered": L("已送达桌面，等待确认"), "succeeded": L("桌面已确认完成"), "failed": L("操作失败"), "expired": L("已过期")][value] ?? value
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in CloudStore.shared.receivedPushToken(token) }
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in CloudStore.shared.pushRegistrationFailed() }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list]); Task { @MainActor in await CloudStore.shared.refresh() }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        Task { @MainActor in await CloudStore.shared.refresh(); completionHandler() }
    }
}
