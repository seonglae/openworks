import Foundation

private func num(_ d: [String: Any], _ k: String) -> Double? { (d[k] as? NSNumber)?.doubleValue }

// A job is one thing that came in: a newsletter issue, a paper, an article.
// The pipeline fetches it, an agent summarises it, and the tldr is what the
// list shows so a row is readable without opening it.
struct Job: Identifiable {
    let id: String
    let url: String
    let title: String
    let source: String?
    let type: String
    let status: String
    let error: String?
    let archived: Bool
    let createdAt: Double
    let tldr: [String]
    let tldrPending: Bool

    init?(_ d: [String: Any]) {
        guard let id = d["_id"] as? String else { return nil }
        self.id = id
        url = d["url"] as? String ?? ""
        title = d["title"] as? String ?? (d["url"] as? String ?? "")
        source = d["source"] as? String
        type = d["type"] as? String ?? "newsletter"
        status = d["status"] as? String ?? ""
        error = d["error"] as? String
        archived = (d["archived"] as? Bool) ?? false
        createdAt = num(d, "createdAt") ?? 0
        tldr = (d["tldr"] as? [String]) ?? []
        tldrPending = (d["tldrPending"] as? Bool) ?? false
    }

    var isDone: Bool { status == "done" }
    var isFailed: Bool { status == "failed" || status == "error" }
    var host: String { URL(string: url)?.host?.replacingOccurrences(of: "www.", with: "") ?? "" }
}

// One item inside a job. A newsletter issue yields several; a paper yields one,
// carrying the structured review scores as well as the prose.
struct Summary: Identifiable {
    let id: String
    let index: Int
    let title: String
    let category: String
    let summary: String
    let keywords: [String]
    let url: String
    let researchLevel: String?
    let overall: Double?

    init?(_ d: [String: Any]) {
        guard let id = d["_id"] as? String, let title = d["title"] as? String else { return nil }
        self.id = id
        self.title = title
        index = (d["index"] as? NSNumber)?.intValue ?? 0
        category = d["category"] as? String ?? ""
        summary = d["summary"] as? String ?? ""
        keywords = (d["keywords"] as? [String]) ?? []
        url = d["url"] as? String ?? ""
        researchLevel = d["researchLevel"] as? String
        overall = num(d["scores"] as? [String: Any] ?? [:], "overall")
    }
}

struct PlanDay: Identifiable {
    let id: String
    let planSlug: String
    let date: String        // yyyy-mm-dd
    let dayLabel: String?
    let summary: String?
    let order: Int

    init?(_ d: [String: Any]) {
        guard let id = d["_id"] as? String, let date = d["date"] as? String else { return nil }
        self.id = id
        self.date = date
        planSlug = d["planSlug"] as? String ?? ""
        dayLabel = d["dayLabel"] as? String
        summary = d["summary"] as? String
        order = (d["order"] as? NSNumber)?.intValue ?? 0
    }
}

struct PlanItem: Identifiable {
    let id: String
    let planSlug: String
    let date: String
    let kind: String        // event | todo
    let order: Int
    let title: String
    let notes: String?
    let time: String?
    let timeStart: String?
    let timeEnd: String?
    let location: String?
    let tags: [String]
    let done: Bool

    init?(_ d: [String: Any]) {
        guard let id = d["_id"] as? String, let title = d["title"] as? String else { return nil }
        self.id = id
        self.title = title
        planSlug = d["planSlug"] as? String ?? ""
        date = d["date"] as? String ?? ""
        kind = d["kind"] as? String ?? "todo"
        order = (d["order"] as? NSNumber)?.intValue ?? 0
        notes = d["notes"] as? String
        time = d["time"] as? String
        timeStart = d["timeStart"] as? String
        timeEnd = d["timeEnd"] as? String
        location = d["location"] as? String
        tags = (d["tags"] as? [String]) ?? []
        done = (d["done"] as? Bool) ?? false
    }

    var isEvent: Bool { kind == "event" }
    var clock: String? {
        if let start = timeStart, let end = timeEnd { return "\(start)-\(end)" }
        return timeStart ?? time
    }
}

struct Project: Identifiable {
    let slug: String
    let title: String
    let kind: String
    let phase: String
    let updatedAt: Double
    var id: String { slug }

    init?(_ d: [String: Any]) {
        guard let slug = d["slug"] as? String else { return nil }
        self.slug = slug
        title = d["title"] as? String ?? slug
        kind = d["kind"] as? String ?? ""
        phase = d["phase"] as? String ?? ""
        updatedAt = num(d, "updatedAt") ?? 0
    }
}

// One state transition on a project. This is the record openworks exists for:
// the work while it is still moving, not the finished artifact.
struct TimelineEntry: Identifiable {
    let id: String
    let state: String
    let at: Double
    let note: String?
    let artifactRef: String?
    let actor: String?

    init?(_ d: [String: Any]) {
        guard let id = d["_id"] as? String, let state = d["state"] as? String else { return nil }
        self.id = id
        self.state = state
        at = num(d, "at") ?? 0
        note = d["note"] as? String
        artifactRef = d["artifactRef"] as? String
        actor = d["actor"] as? String
    }
}
