import Foundation

// Never forward the bearer credential across a redirect, even to another HTTPS host.
final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
final class CloudAPI {
    let credentials: Credentials
    private let session: URLSession
    private let dataSession: URLSession
    init(_ credentials: Credentials) {
        self.credentials = credentials
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 35
        config.timeoutIntervalForResource = 86_400
        config.urlCache = nil
        session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
        let dataConfig = URLSessionConfiguration.ephemeral
        dataConfig.timeoutIntervalForRequest = 15
        dataConfig.timeoutIntervalForResource = 20
        dataConfig.urlCache = nil
        dataSession = URLSession(configuration: dataConfig, delegate: NoRedirect(), delegateQueue: nil)
    }
    func close() { session.invalidateAndCancel(); dataSession.invalidateAndCancel() }
    private func request(_ path: String, method: String = "GET", body: Data? = nil) -> URLRequest {
        var request = URLRequest(url: URL(string: credentials.server + path)!)
        request.httpMethod = method
        request.setValue("Bearer " + credentials.token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        return request
    }
    private func check(_ response: URLResponse) throws {
        guard let response = response as? HTTPURLResponse else { throw CloudError.malformed }
        if response.statusCode == 401 || response.statusCode == 403 { throw CloudError.unauthorized }
        guard (200..<300).contains(response.statusCode) else { throw CloudError.rejected(response.statusCode) }
    }
    func json(_ path: String, method: String = "GET", body: Data? = nil) async throws -> Data {
        var req = request(path, method: method, body: body); req.timeoutInterval = 15
        let (bytes, response) = try await dataSession.bytes(for: req)
        try check(response)
        var data = Data()
        for try await byte in bytes {
            guard data.count < 512 * 1024 else { throw CloudError.malformed }
            data.append(byte)
        }
        return data
    }
    func state() async throws -> CloudState { try CloudState.parse(await json("/v1/state")) }
    func pair(installation: String) async throws -> Credentials {
        let body = try JSONSerialization.data(withJSONObject: ["id": installation, "name": "iPhone", "platform": "ios"])
        let data = try await json("/v1/pair", method: "POST", body: body)
        struct PairResult: Decodable { let token: String; let deviceId: String }
        let result = try JSONDecoder().decode(PairResult.self, from: data)
        guard result.deviceId == installation else { throw CloudError.malformed }
        return try Credentials.validate(server: credentials.server, token: result.token)
    }
    func command(_ command: Command) async throws -> CommandState {
        try JSONDecoder().decode(CommandState.self, from: await json("/v1/commands", method: "POST", body: JSONEncoder().encode(command)))
    }
    func register(token: String, id: String) async throws {
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        let data = try JSONSerialization.data(withJSONObject: ["id": id, "platform": "ios", "token": token, "environment": environment])
        _ = try await json("/v1/devices", method: "POST", body: data)
    }
    func registerLiveActivity(type: String, token: String, activityID: String?) async throws {
        guard ["start", "update"].contains(type), !token.isEmpty, token.count <= 1024,
              token.allSatisfy({ $0.isHexDigit }), type != "update" || activityID != nil else { throw CloudError.malformed }
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        var fields: [String: Any] = ["type": type, "token": token, "environment": environment]
        if let activityID { fields["activityId"] = activityID }
        _ = try await json("/v1/live-activity", method: "POST", body: JSONSerialization.data(withJSONObject: fields))
    }
    func removeLiveActivity(activityID: String? = nil) async throws {
        let fields: [String: Any] = activityID.map { ["activityId": $0] } ?? [:]
        do { _ = try await json("/v1/live-activity", method: "DELETE", body: JSONSerialization.data(withJSONObject: fields)) }
        catch CloudError.unauthorized { /* Revoked pairing cannot retain a live token registration. */ }
    }
    func revokePair() async throws {
        do { _ = try await json("/v1/pair", method: "DELETE") }
        catch CloudError.unauthorized { /* Already revoked credentials can be removed locally. */ }
    }
    func events(receive: @escaping (CloudState) async -> Void, connected: @escaping () async -> Void) async throws {
        var req = request("/v1/events"); req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let (bytes, response) = try await session.bytes(for: req)
        try check(response)
        guard (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type")?.contains("text/event-stream") == true else { throw CloudError.malformed }
        await connected()
        var parser = SSEParser()
        for try await byte in bytes {
            try Task.checkCancellation()
            if let json = try parser.feed(byte), let data = json.data(using: .utf8) {
                await receive(try CloudState.parse(data))
            }
        }
    }
}
