import Foundation

enum ConvexError: LocalizedError {
    case notConfigured, badURL, shape, server(String)
    var errorDescription: String? {
        switch self {
        case .notConfigured: return UIText.t("설정에서 서버 연결을 저장하세요.", "Save a server connection in Settings.")
        case .badURL: return UIText.t("서버 주소를 확인하세요.", "Check the server address.")
        case .shape: return UIText.t("불러오기에 실패했어요. 예상하지 못한 응답입니다.", "Load failed: unexpected server response.")
        case .server(let message): return message
        }
    }
}

struct ConvexHTTP {
    static let urlKey = "convexUrl"
    static let serviceKeyKey = "serviceKey"

    private static func plist(_ key: String) -> String {
        let v = Bundle.main.object(forInfoDictionaryKey: key) as? String ?? ""
        if v.hasPrefix("$(") { return "" }
        return v
    }

    private static func setting(_ defaultsKey: String, _ plistKey: String) -> String {
        let saved = UserDefaults.standard.string(forKey: defaultsKey) ?? ""
        if !saved.isEmpty { return saved }
        return plist(plistKey)
    }

    static var cloudURL: String { setting(urlKey, "OPENWORKS_CONVEX_URL") }
    static var serviceKey: String { setting(serviceKeyKey, "OPENWORKS_SERVICE_KEY") }
    static var configured: Bool { !cloudURL.isEmpty && !serviceKey.isEmpty }

    static func setURL(_ v: String) { UserDefaults.standard.set(v, forKey: urlKey) }
    static func setServiceKey(_ v: String) { UserDefaults.standard.set(v, forKey: serviceKeyKey) }

    private static func call(_ kind: String, _ path: String, args: [String: Any]) async throws -> Any {
        if DemoMode.isEnabled { return try await DemoMode.response(kind: kind, path: path, args: args) }
        guard configured else { throw ConvexError.notConfigured }
        guard let base = URL(string: cloudURL), let scheme = base.scheme,
              ["https", "http"].contains(scheme), base.host != nil,
              base.user == nil, base.password == nil else { throw ConvexError.badURL }
        let url = base.appendingPathComponent("api").appendingPathComponent(kind)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 25
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var keyed = args
        keyed["serviceKey"] = serviceKey
        request.httpBody = try JSONSerialization.data(withJSONObject: ["path": path, "args": keyed, "format": "json"])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            throw ConvexError.server(UIText.t("요청에 실패했어요. 연결을 확인하세요.", "Request failed. Check your connection."))
        }
        guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ConvexError.shape }
        guard result["status"] as? String == "success" else {
            throw ConvexError.server((result["errorMessage"] as? String) ?? UIText.t("요청 실패", "Request failed"))
        }
        return result["value"] ?? NSNull()
    }

    static func query(_ path: String, args: [String: Any] = [:]) async throws -> Any {
        try await call("query", path, args: args)
    }
    @discardableResult
    static func mutation(_ path: String, args: [String: Any] = [:]) async throws -> Any {
        try await call("mutation", path, args: args)
    }
    @discardableResult
    static func action(_ path: String, args: [String: Any] = [:]) async throws -> Any {
        try await call("action", path, args: args)
    }

    static func listJobs(type: String, archived: Bool, skip: Int, limit: Int) async throws -> [[String: Any]] {
        let args: [String: Any] = ["type": type, "archived": archived, "skip": skip, "limit": limit]
        let value = try await query("jobs:listOffset", args: args)
        guard let value = value as? [[String: Any]] else { throw ConvexError.shape }
        return value
    }

    static func search(type: String, archived: Bool, query text: String) async throws -> [[String: Any]] {
        let value = try await query("jobs:searchWithContent", args: [
            "type": type, "archived": archived, "query": text, "limit": 60,
        ])
        guard let value = value as? [[String: Any]] else { throw ConvexError.shape }
        return value
    }

    static func job(id: String) async throws -> [String: Any]? {
        let value = try await query("jobs:getById", args: ["jobId": id])
        if value is NSNull { return nil }
        guard let value = value as? [String: Any] else { throw ConvexError.shape }
        return value
    }

    static func summaries(jobId: String) async throws -> [[String: Any]] {
        let value = try await query("summaries:listByJob", args: ["jobId": jobId])
        guard let value = value as? [[String: Any]] else { throw ConvexError.shape }
        return value
    }

    static func archive(jobId: String) async throws {
        try await mutation("jobs:archive", args: ["jobId": jobId])
    }

    static func unarchive(jobId: String) async throws {
        try await mutation("jobs:unarchive", args: ["jobId": jobId])
    }

    static func setType(jobId: String, type: String) async throws {
        try await mutation("jobs:updateType", args: ["jobId": jobId, "type": type])
    }

    @discardableResult
    static func createJob(url: String, content: String, type: String) async throws -> String? {
        var args: [String: Any] = ["url": url, "type": type]
        if !content.isEmpty { args["content"] = content }
        let value = try await mutation("jobs:create", args: args)
        return value as? String
    }

    static func imageUrls(jobId: String) async throws -> [String] {
        let value = try await query("jobs:imageUrls", args: ["jobId": jobId])
        guard let value = value as? [String] else { throw ConvexError.shape }
        return value
    }

    @discardableResult
    static func placeInsight(id: String) async throws -> URL? {
        let value = try await call("action", "notion:placeInsight", args: ["insightId": id])
        return ((value as? [String: Any])?["url"] as? String).flatMap(URL.init(string:))
    }

    static func dismissInsight(id: String) async throws {
        try await mutation("insights:setStatus", args: ["id": id, "status": "dismissed"])
    }

    static func suggestions(jobId: String) async throws -> [[String: Any]] {
        let value = try await query("suggestions:listByJob", args: ["jobId": jobId])
        guard let value = value as? [[String: Any]] else { throw ConvexError.shape }
        return value
    }

    @discardableResult
    static func approveSuggestion(id: String) async throws -> URL? {
        let value = try await call("action", "notion:approveAndExecute", args: ["suggestionId": id])
        return ((value as? [String: Any])?["url"] as? String).flatMap(URL.init(string:))
    }

    static func approveAllSuggestions(jobId: String) async throws {
        _ = try await call("action", "notion:approveAllAndExecute", args: ["jobId": jobId])
    }

    static func rejectSuggestion(id: String) async throws {
        try await mutation("suggestions:updateStatus", args: ["suggestionId": id, "status": "rejected"])
    }

    static func rejectAllSuggestions(jobId: String) async throws {
        try await mutation("suggestions:rejectAll", args: ["jobId": jobId])
    }

    static func newsletterStats(archived: Bool) async throws -> [String: Any] {
        let value = try await query("jobs:newsletterStats", args: ["archived": archived])
        guard let value = value as? [String: Any] else { throw ConvexError.shape }
        return value
    }

    static func scoreStats(archived: Bool) async throws -> [String: Any] {
        let value = try await query("summaries:scoreStats", args: ["archived": archived])
        guard let value = value as? [String: Any] else { throw ConvexError.shape }
        return value
    }
}
