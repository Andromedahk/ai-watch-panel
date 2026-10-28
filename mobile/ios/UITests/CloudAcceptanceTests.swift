import XCTest
import UIKit

// Uses the real bundled React UI and native HTTPS/Keychain bridge. All network
// data comes from an isolated synthetic fixture; there are no production tokens.
final class CloudAcceptanceTests: XCTestCase {
    private var app: XCUIApplication!
    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 20))
        addUIInterruptionMonitor(withDescription: "System notification permission") { alert in
            for label in ["Allow", "允许"] where alert.buttons[label].exists { alert.buttons[label].tap(); return true }; return false
        }
    }
    override func tearDownWithError() throws {
        if (testRun?.totalFailureCount ?? 0) > 0 { print("AIWATCH_FAILURE_UI\n" + app.debugDescription); screenshot("failure") }
    }
    private func screenshot(_ name: String) { let item = XCTAttachment(screenshot: app.screenshot()); item.name = name; item.lifetime = .keepAlways; add(item) }
    private func scrollTo(_ element: XCUIElement, up: Bool = true) {
        for _ in 0..<8 { if element.exists && element.isHittable { return }; if up { app.webViews.firstMatch.swipeUp() } else { app.webViews.firstMatch.swipeDown() } }
    }
    private let translated = ["Connection and inbox": "连接与消息", "Desktop online": "桌面在线", "Follow pending answers and approvals live": "实时关注待回答 / 待授权",
        "Disconnect and revoke this phone": "断开并注销此手机", "Confirm disconnect": "确认断开", "Connect": "连接",
        "Live attention is disabled": "实时关注已关闭", "Live attention is enabled; waiting for requests": "实时关注已开启，等待待处理请求"]
    private func button(_ name: String) -> XCUIElement { app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", name, translated[name] ?? name)).firstMatch }
    private func text(_ part: String) -> XCUIElement { app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ OR label CONTAINS %@", part, translated[part] ?? part)).firstMatch }
    private func tap(_ name: String) { let item = button(name); scrollTo(item); XCTAssertTrue(item.waitForExistence(timeout: 15)); item.tap() }
    private func waitText(_ part: String, timeout: TimeInterval = 30) { XCTAssertTrue(text(part).waitForExistence(timeout: timeout)) }
    private func inbox() {
        if button("Close mobile panel").waitForExistence(timeout: 3) { return }
        tap("Connection and inbox"); XCTAssertTrue(button("Close mobile panel").waitForExistence(timeout: 10))
    }
    private func online() { inbox(); waitText("Desktop online") }
    private func pending(_ contains: String) -> XCUIElement {
        let item = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", contains)).firstMatch
        scrollTo(item); XCTAssertTrue(item.waitForExistence(timeout: 20)); XCTAssertTrue(item.isEnabled); return item
    }
    private func receipt() { let item = text("Desktop confirmed completion"); scrollTo(item); XCTAssertTrue(item.waitForExistence(timeout: 35)); screenshot("shared-ui-desktop-confirmed") }
    private func settings() { tap("Preferences"); XCTAssertTrue(button("Close settings").waitForExistence(timeout: 10)); tap("Appearance") }
    private func setCheckbox(_ label: String, enabled: Bool) {
        let item = app.switches.matching(NSPredicate(format: "label == %@ OR label == %@", label, translated[label] ?? label)).firstMatch
        scrollTo(item); XCTAssertTrue(item.waitForExistence(timeout: 10)); if (item.value as? String == "1") != enabled { item.tap() }
    }
    private func skin(_ title: String) {
        let item = app.switches.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
        scrollTo(item); XCTAssertTrue(item.waitForExistence(timeout: 10)); item.tap()
    }
    func test00InspectSharedPanel() {
        XCTAssertTrue(button("Preferences").waitForExistence(timeout: 20)); settings()
        print("AIWATCH_WEB_SETTINGS\n" + app.debugDescription); screenshot("shared-react-settings")
        tap("Close settings"); inbox(); print("AIWATCH_WEB_INBOX\n" + app.debugDescription); screenshot("shared-react-inbox")
    }
    func test01PairAndStyles() throws {
        struct Config: Decodable { let url: String; let bootstrapToken: String }
        let config = try JSONDecoder().decode(Config.self, from: Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: "qa-config", withExtension: "json"))))
        inbox()
        let server = app.textFields["Server"]
        if !server.waitForExistence(timeout: 2) { tap("Disconnect and revoke this phone"); tap("Confirm disconnect") }
        XCTAssertTrue(server.waitForExistence(timeout: 15))
        if (server.value as? String) != config.url {
            server.tap(); server.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
            if let value = server.value as? String, !value.isEmpty { server.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count + 4)) }
            XCTAssertEqual(server.value as? String, "")
            server.typeText(config.url)
        }
        let credential = app.secureTextFields["Pairing credential"]; credential.tap(); credential.typeText(config.bootstrapToken)
        tap("Connect")
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.alerts.firstMatch.waitForExistence(timeout: 3), springboard.alerts.buttons["Allow"].exists { springboard.alerts.buttons["Allow"].tap() }
        XCTAssertTrue(button("Preferences").waitForExistence(timeout: 25)); online(); screenshot("shared-ui-paired"); tap("Close mobile panel")
        captureStyles()
        app.terminate(); app.launch(); XCTAssertTrue(button("Preferences").waitForExistence(timeout: 20)); settings()
        let party = app.switches.matching(NSPredicate(format: "label BEGINSWITH %@", "Party")).firstMatch
        XCTAssertEqual(party.value as? String, "1"); setCheckbox("Anime mode", enabled: false); setCheckbox("Dark mode", enabled: false); skin("Watchtower"); tap("Close settings")
        tap("Collapse panel"); XCTAssertTrue(button("Expand panel").waitForExistence(timeout: 10)); screenshot("shared-collapsed-rail"); tap("Expand panel")
    }
    private func captureStyles() {
        for title in ["Watchtower", "Dial", "Party"] {
            settings(); skin(title); setCheckbox("Anime mode", enabled: false); setCheckbox("Dark mode", enabled: false); tap("Close settings"); screenshot("shared-" + title + "-light")
            settings(); setCheckbox("Dark mode", enabled: true); tap("Close settings"); screenshot("shared-" + title + "-dark")
            settings(); setCheckbox("Anime mode", enabled: true); tap("Close settings"); screenshot("shared-" + title + "-anime-dark")
            settings(); setCheckbox("Dark mode", enabled: false); tap("Close settings"); screenshot("shared-" + title + "-anime-light")
        }
    }
    func test10SharedVisuals() {
        online(); tap("Close mobile panel"); captureStyles(); settings(); setCheckbox("Anime mode", enabled: false); setCheckbox("Dark mode", enabled: false); skin("Watchtower"); tap("Close settings")
    }
    func test02Answer() {
        online(); pending("Codex · Answer requested").tap(); waitText("Full content stays on the desktop")
        tap("Option 1"); tap("Send answer"); screenshot("shared-answer-confirmation"); tap("Confirm"); receipt()
    }
    func test03Approve() { approval("Approve this request", evidence: "shared-approval-confirmation") }
    func test04Deny() { approval("Deny this request", evidence: "shared-denial-confirmation") }
    private func approval(_ title: String, evidence: String) {
        online(); pending("Codex · Command approval").tap(); tap(title); screenshot(evidence); tap("Confirm"); receipt()
    }
    func test05Offline() {
        inbox(); waitText("Desktop offline", timeout: 40)
        let request = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Codex · Command approval")).firstMatch
        scrollTo(request); if request.exists { XCTAssertFalse(request.isEnabled) }; screenshot("shared-offline-actions-disabled")
    }
    func test06Inbox() {
        online(); let alert = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Low quota")).firstMatch
        scrollTo(alert); XCTAssertTrue(alert.waitForExistence(timeout: 20)); screenshot("shared-low-quota-inbox"); tap("Mark all as read")
        let readHeading = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", "INBOX · 0 UNREAD")).firstMatch
        XCTAssertTrue(readHeading.waitForExistence(timeout: 10)); app.terminate(); app.launch(); online()
        XCTAssertTrue(readHeading.waitForExistence(timeout: 10)); XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "● codex")).firstMatch.exists)
        screenshot("shared-inbox-read-persists")
    }
    func test09NativeAnimation() throws {
        online(); tap("Close mobile panel"); settings(); skin("Watchtower"); setCheckbox("Anime mode", enabled: false); setCheckbox("Dark mode", enabled: false); tap("Close settings")
        let target = button("Open Codex"); XCTAssertTrue(target.waitForExistence(timeout: 10)); XCTAssertTrue(target.isHittable)
        Thread.sleep(forTimeInterval: 2)
        let rectangle = target.frame.insetBy(dx: -12, dy: -12)
        var frames = Set<Data>()
        for index in 0..<4 {
            let shot = app.screenshot().image
            let pixels = try XCTUnwrap(shot.cgImage)
            let ratio = CGFloat(pixels.width) / app.frame.width
            let area = CGRect(x: rectangle.minX * ratio, y: rectangle.minY * ratio, width: rectangle.width * ratio, height: rectangle.height * ratio)
            let cropped = UIImage(cgImage: try XCTUnwrap(pixels.cropping(to: area)))
            frames.insert(try XCTUnwrap(cropped.pngData()))
            let item = XCTAttachment(image: cropped); item.name = "native-logo-breathe-\(index)"; item.lifetime = .keepAlways; add(item)
            Thread.sleep(forTimeInterval: 0.65)
        }
        XCTAssertGreaterThan(frames.count, 1, "The fixed Codex avatar region changes while its CSS glow breathes; clocks and other content are excluded")
        print("AIWATCH_NATIVE_ANIMATION_DISTINCT_FRAMES=\(frames.count)")
    }
    func test07SimulatedPush() {
        online(); XCUIDevice.shared.press(.home); print("AIWATCH_QA_PUSH_READY")
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let notice = springboard.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS %@", "Low quota", "额度偏低")).firstMatch
        XCTAssertTrue(notice.waitForExistence(timeout: 30)); let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = "simulated-push-notification"; shot.lifetime = .keepAlways; add(shot)
        notice.tap(); XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20)); screenshot("simulated-push-opened-shared-ui")
    }
    func test08Revoked() {
        inbox(); waitText("revoked"); tap("Disconnect and revoke this phone"); tap("Confirm disconnect")
        XCTAssertTrue(app.textFields["Server"].waitForExistence(timeout: 20)); screenshot("shared-revoked-device-disconnected")
    }
    func test11LivePairEnable() throws {
        struct Config: Decodable { let url: String; let bootstrapToken: String }
        let config = try JSONDecoder().decode(Config.self, from: Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: "qa-config", withExtension: "json"))))
        inbox()
        let server = app.textFields["Server"]
        if !server.waitForExistence(timeout: 3) {
            tap("Disconnect and revoke this phone"); tap("Confirm disconnect")
            XCTAssertTrue(server.waitForExistence(timeout: 15))
        }
        if server.exists {
            if (server.value as? String) != config.url {
                server.tap()
                if let value = server.value as? String, !value.isEmpty { server.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count + 4)) }
                server.typeText(config.url)
            }
            let credential = app.secureTextFields["Pairing credential"]; credential.tap(); credential.typeText(config.bootstrapToken)
            tap("Connect")
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            if springboard.alerts.firstMatch.waitForExistence(timeout: 3), springboard.alerts.buttons["Allow"].exists { springboard.alerts.buttons["Allow"].tap() }
            online()
        }
        setCheckbox("Follow pending answers and approvals live", enabled: true)
        let enabledStatus = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ OR label CONTAINS %@", "Live attention is enabled", "Live Activity push updates registered")).firstMatch
        XCTAssertTrue(enabledStatus.waitForExistence(timeout: 20))
        screenshot("live-enabled-in-app")
        inspectLiveSurface("live-enabled-system", expanded: true)
    }
    func test12LiveInspect() {
        online(); Thread.sleep(forTimeInterval: 3)
        screenshot("live-current-in-app"); inspectLiveSurface("live-current-system", expanded: true)
    }
    func test13LiveDisable() {
        online(); setCheckbox("Follow pending answers and approvals live", enabled: false)
        waitText("Live attention is disabled"); screenshot("live-disabled-in-app")
        inspectLiveSurface("live-disabled-system")
    }
    func test14LiveOpenApp() {
        online(); tap("Close mobile panel"); XCUIDevice.shared.press(.home)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        Thread.sleep(forTimeInterval: 2)
        // Dedicated iPhone 17 Pro simulator: the Dynamic Island has been visually
        // checked at this coordinate. It is not exposed in SpringBoard's AX tree.
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.04)).tap()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
        XCTAssertTrue(button("Close mobile panel").waitForExistence(timeout: 15))
        waitText("Desktop online"); screenshot("live-island-opened-inbox")
    }
    func test15LiveClear() {
        online(); waitText("Live attention is enabled; waiting for requests")
        screenshot("live-cleared-in-app"); inspectLiveSurface("live-cleared-system")
    }
    private func inspectLiveSurface(_ name: String, expanded: Bool = false) {
        XCUIDevice.shared.press(.home); Thread.sleep(forTimeInterval: 3)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        print("AIWATCH_LIVE_SYSTEM_UI\n" + springboard.debugDescription)
        let item = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); item.name = name; item.lifetime = .keepAlways; add(item)
        if expanded {
            springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.04)).press(forDuration: 1.2)
            Thread.sleep(forTimeInterval: 1)
            print("AIWATCH_LIVE_EXPANDED_UI\n" + springboard.debugDescription)
            let detail = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); detail.name = name + "-expanded"; detail.lifetime = .keepAlways; add(detail)
            springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.65)).tap()
            springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.12, dy: 0.005)).press(forDuration: 0.1, thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.12, dy: 0.8)))
            Thread.sleep(forTimeInterval: 1)
            let activityPermission = springboard.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ AND (label CONTAINS %@ OR label CONTAINS %@)", "AI Watch", "实时活动", "Live Activit")).firstMatch
            let allow = springboard.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Allow", "允许")).firstMatch
            if activityPermission.exists && allow.exists && allow.isHittable { allow.tap(); Thread.sleep(forTimeInterval: 1) }
            print("AIWATCH_LIVE_LOCK_UI\n" + springboard.debugDescription)
            let lock = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); lock.name = name + "-lock-screen"; lock.lifetime = .keepAlways; add(lock)
        }
    }
}
