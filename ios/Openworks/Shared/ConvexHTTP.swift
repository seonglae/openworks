import Foundation

// Convex function API client. Queries and mutations POST to
// {deployment}.convex.cloud/api/{query,mutation} with {path,args,format:"json"}
// and answer {status:"success", value} or {errorMessage}.
//
// Auth is OPENWORKS_SERVICE_KEY, the same single-owner key the CLI workers and
// the MCP server present (convex/auth.ts requireOwner). The phone is one more
// owner-side caller, so it needs no Clerk session and no browser origin.
enum ConvexError: LocalizedError {
    case notConfigured, badURL, server(String), shape
    var errorDescription: String? {
        switch self {
        case .notConfigured: return String(localized: "No deployment configured")
        case .badURL: return String(localized: "Bad URL")
        case .server(let m): return m
        case .shape: return String(localized: "Unexpected response shape")
        }
    }
}

// One page of a Convex paginated query.
struct Page {
    let rows: [[String: Any]]
    let cursor: String?
    let isDone: Bool
}

struct Convex {
    static let urlKey = "convexUrl"
    static let serviceKeyKey = "serviceKey"

    private static func plist(_ key: String) -> String {
        let v = Bundle.main.object(forInfoDictionaryKey: key) as? String ?? ""
        // An unfilled xcconfig leaves the literal "$(KEY)" behind; treat that as empty.
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

    private static func post(_ kind: String, _ path: String, _ args: [String: Any]) async throws -> Any {
        guard configured else { throw ConvexError.notConfigured }
        guard let url = URL(string: "\(cloudURL)/api/\(kind)") else { throw ConvexError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 25
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var keyed = args
        keyed["serviceKey"] = serviceKey
        req.httpBody = try JSONSerialization.data(withJSONObject: ["path": path, "args": keyed, "format": "json"])
        let (data, _) = try await URLSession.shared.data(for: req)
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ConvexError.shape }
        if (obj["status"] as? String) == "success" { return obj["value"] as Any }
        throw ConvexError.server((obj["errorMessage"] as? String) ?? "convex error")
    }

    static func query(_ path: String, _ args: [String: Any] = [:]) async throws -> Any { try await post("query", path, args) }
    @discardableResult
    static func mutation(_ path: String, _ args: [String: Any] = [:]) async throws -> Any { try await post("mutation", path, args) }

    private static func rows(_ value: Any) -> [[String: Any]] { (value as? [[String: Any]]) ?? [] }

    // A paginated query wants {numItems, cursor}; a null cursor is the first page.
    private static func paginated(_ path: String, _ args: [String: Any], numItems: Int, cursor: String?) async throws -> Page {
        var withOpts = args
        withOpts["paginationOpts"] = ["numItems": numItems, "cursor": cursor as Any? ?? NSNull()]
        let v = try await query(path, withOpts)
        guard let d = v as? [String: Any] else { throw ConvexError.shape }
        return Page(rows: (d["page"] as? [[String: Any]]) ?? [],
                    cursor: d["continueCursor"] as? String,
                    isDone: (d["isDone"] as? Bool) ?? true)
    }

    // MARK: - reading
    static func jobs(type: String, archived: Bool, numItems: Int = 30, cursor: String? = nil) async throws -> (items: [Job], cursor: String?, done: Bool) {
        let page = try await paginated("jobs:list", ["type": type, "archived": archived], numItems: numItems, cursor: cursor)
        return (page.rows.compactMap(Job.init), page.cursor, page.isDone)
    }
    static func jobCount(type: String, archived: Bool) async throws -> Int {
        let v = try await query("jobs:count", ["type": type, "archived": archived])
        return (v as? NSNumber)?.intValue ?? 0
    }
    static func summaries(jobId: String) async throws -> [Summary] {
        rows(try await query("summaries:listByJob", ["jobId": jobId])).compactMap(Summary.init)
    }
    static func archive(jobId: String) async throws { try await mutation("jobs:archive", ["jobId": jobId]) }
    static func unarchive(jobId: String) async throws { try await mutation("jobs:unarchive", ["jobId": jobId]) }

    // MARK: - plan
    static func plan() async throws -> (days: [PlanDay], items: [PlanItem]) {
        guard let d = try await query("plans:allItems") as? [String: Any] else { return ([], []) }
        return (rows(d["days"]).compactMap(PlanDay.init), rows(d["items"]).compactMap(PlanItem.init))
    }
    static func toggleDone(itemId: String) async throws { try await mutation("plans:toggleDone", ["itemId": itemId]) }

    // MARK: - research
    static func projects() async throws -> [Project] {
        rows(try await query("research:listAllProjects")).compactMap(Project.init)
    }
    static func timeline(slug: String, limit: Int = 40) async throws -> [TimelineEntry] {
        rows(try await query("research:getTimeline", ["slug": slug, "limit": limit])).compactMap(TimelineEntry.init)
    }

    // MARK: - connection
    // settings:whoami answers about the *Clerk* identity, and a service-key
    // caller has none, so it would report "not authenticated" on a perfectly
    // good connection. A counted query goes through requireOwner and comes back
    // with a number, which is the thing worth proving.
    static func reachable() async throws -> Int {
        try await jobCount(type: "newsletter", archived: false)
    }
}
