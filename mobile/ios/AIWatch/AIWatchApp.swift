import SwiftUI
import WebKit
import Combine
import CryptoKit

@main struct AIWatchApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var store = CloudStore.shared
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            MobilePanelWebView(store: store)
                .ignoresSafeArea(.container, edges: [.leading, .trailing])
                .onAppear { store.setActive(true) }
                .onChange(of: scenePhase) { phase in store.setActive(phase == .active) }
                .onOpenURL { url in if url.scheme == "aiwatch" && url.host == "attention" { store.openAttention() } }
        }
    }
}

// Desktop React components, CSS, animation and bundled images are the visible UI.
// The web content has no networking capability; native code owns HTTPS and Keychain.
struct MobilePanelWebView: UIViewRepresentable {
    let store: CloudStore
    func makeCoordinator() -> Coordinator { Coordinator(store: store) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(context.coordinator, name: "aiWatch")
        configuration.setURLSchemeHandler(context.coordinator, forURLScheme: "aiwatch")
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.scrollView.isScrollEnabled = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.isOpaque = false
        view.backgroundColor = .systemBackground
        view.accessibilityIdentifier = "desktopPanelWebView"
        #if DEBUG
        if #available(iOS 16.4, *) { view.isInspectable = true }
        #endif
        context.coordinator.attach(view)
        view.load(URLRequest(url: context.coordinator.pageURL))
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) { }
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "aiWatch")
        view.navigationDelegate = nil
        coordinator.detach()
    }

    @MainActor final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKURLSchemeHandler {
        let store: CloudStore
        let resourceRoot = Bundle.main.resourceURL?.appendingPathComponent("mobile", isDirectory: true)
        let pageURL = URL(string: "aiwatch://app/index.html")!
        private weak var view: WKWebView?
        private var subscription: AnyCancellable?
        private var ready = false
        private var operationInFlight = false
        init(store: CloudStore) { self.store = store; super.init() }
        func attach(_ webView: WKWebView) {
            view = webView
            subscription = store.objectWillChange.sink { [weak self] _ in
                DispatchQueue.main.async { self?.publish() }
            }
        }
        func detach() { ready = false; subscription?.cancel(); subscription = nil; view = nil }
        private func isBundledPage(_ url: URL?) -> Bool {
            guard let url else { return false }
            return url == pageURL
        }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(action.targetFrame?.isMainFrame == true && isBundledPage(action.request.url) ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { ready = false }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            ready = false
            webView.load(URLRequest(url: pageURL))
        }
        // A fixed custom origin permits ES modules without relaxing file-origin CORS.
        // It maps only into the signed app bundle and has no remote proxy fallback.
        func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
            guard let url = urlSchemeTask.request.url, url.scheme == "aiwatch", url.host == "app",
                  url.port == nil, url.user == nil, url.password == nil, url.query == nil,
                  let root = resourceRoot?.standardizedFileURL,
                  !url.pathComponents.contains("..") else { urlSchemeTask.didFailWithError(CloudError.unavailable); return }
            let file = root.appendingPathComponent(String(url.path.dropFirst())).standardizedFileURL
            guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
                urlSchemeTask.didFailWithError(CloudError.unavailable); return
            }
            let types = ["html": "text/html", "js": "text/javascript", "css": "text/css", "json": "application/json", "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "gif": "image/gif", "ico": "image/x-icon", "woff2": "font/woff2"]
            let response = URLResponse(url: url, mimeType: types[file.pathExtension.lowercased()] ?? "application/octet-stream", expectedContentLength: data.count, textEncodingName: ["html", "js", "css", "json", "svg"].contains(file.pathExtension) ? "utf-8" : nil)
            urlSchemeTask.didReceive(response); urlSchemeTask.didReceive(data); urlSchemeTask.didFinish()
        }
        func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) { }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "aiWatch", message.frameInfo.isMainFrame,
                  message.frameInfo.securityOrigin.protocol == "aiwatch", message.frameInfo.securityOrigin.host == "app",
                  isBundledPage(message.frameInfo.request.url), isBundledPage(view?.url) else { return }
            let parsed: MobileBridgeMessage
            do { parsed = try MobileBridgeMessage.parse(message.body) }
            catch {
                if let body = message.body as? [String: Any], let id = body["id"] as? String, UUID(uuidString: id) != nil {
                    publish(reply: ["id": id, "ok": false, "error": CloudError.malformed.localizedDescription])
                }
                return
            }
            if parsed.type == "ready" { ready = true; publish(reply: ["id": parsed.id, "ok": true]); return }
            guard !operationInFlight else { publish(reply: ["id": parsed.id, "ok": false, "error": L("请等待当前操作完成")]); return }
            operationInFlight = true
            Task { [weak self] in
                guard let self else { return }
                var success = false
                defer { self.operationInFlight = false; self.publish(reply: ["id": parsed.id, "ok": success, "error": success ? "" : self.store.message.isEmpty ? CloudError.malformed.localizedDescription : self.store.message]) }
                switch parsed.type {
                case "configure":
                    guard store.credentials == nil, let server = parsed.value["server"] as? String, let token = parsed.value["token"] as? String else { return }
                    success = await store.configure(server: server, token: token)
                case "refresh": success = await store.refresh()
                case "logout": success = await store.logout()
                case "notifications": await store.enableNotifications(); success = true
                case "liveUpdates": if let enabled = parsed.value["enabled"] as? Bool { success = await store.setLiveUpdates(enabled) }
                case "submit":
                    guard store.actionable, let body = parsed.value["command"] as? [String: Any],
                          let requestId = body["requestId"] as? String,
                          let request = store.state?.snapshot?.requests.first(where: { $0.id == requestId }), request.valid(at: Date()),
                          let command = try? Command.parse(body, for: request),
                          store.state?.commands.contains(where: { $0.requestId == requestId && $0.id != command.id }) != true else { return }
                    success = await store.send(command)
                default: break
                }
            }
        }
        private func publish(reply: [String: Any]? = nil) {
            guard ready, let view, isBundledPage(view.url) else { return }
            var payload: [String: Any] = [
                "configured": store.credentials != nil, "platform": "ios",
                "state": (store.state?.wire.flatMap { try? JSONSerialization.jsonObject(with: $0) }) ?? NSNull(),
                "online": store.online, "connected": store.connected, "busy": store.busy,
                "message": store.message, "pushStatus": store.pushMessage,
                "liveUpdatesEnabled": store.liveUpdatesEnabled, "liveUpdatesStatus": store.liveUpdatesStatus,
                "attentionOpenSequence": store.attentionOpenSequence
            ]
            if let credentials = store.credentials {
                payload["accountKey"] = SHA256.hash(data: Data((credentials.server + "\n" + credentials.token).utf8)).map { String(format: "%02x", $0) }.joined()
            }
            if let reply { payload["reply"] = reply }
            // Argument binding avoids interpolating any server or user text as script.
            view.callAsyncJavaScript("window.aiWatchMobile?.receive(payload)", arguments: ["payload": payload], in: nil, in: .page) { _ in }
        }
    }
}
