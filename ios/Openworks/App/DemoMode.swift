import SwiftUI
import UIKit

// The demo intercepts transport before credentials or network access.
enum DemoMode {
    static var isEnabled: Bool { ProcessInfo.processInfo.arguments.contains("-OpenworksDemo") || ProcessInfo.processInfo.environment["OPENWORKS_DEMO"] == "1" }
    static func argument(_ key: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: key), args.indices.contains(index + 1) else { return nil }
        return args[index + 1]
    }
    static var initialTab: String { isEnabled ? argument("-OpenworksDemoTab") ?? "newsletter" : "newsletter" }
    static var empty: Bool { argument("-OpenworksDemoState") == "empty" }

    @MainActor
    static func response(kind: String, path: String, args: [String: Any]) async throws -> Any {
        let delay = Double(argument("-OpenworksDemoDelay") ?? "0.15") ?? 0.15
        try await Task.sleep(for: .seconds(max(0, delay)))
        if argument("-OpenworksDemoState") == "failed" {
            throw ConvexError.server(UIText.t("데모 서버 요청에 실패했어요.", "The demo server request failed."))
        }
        return try DemoFixtures.shared.response(kind: kind, path: path, args: args)
    }
}

@MainActor
private final class DemoFixtures {
    static let shared = DemoFixtures()
    private let now = Date().timeIntervalSince1970 * 1000
    private var today: String { calendarDay() }
    private var jobs: [[String: Any]] = []
    private var suggestions: [String: [[String: Any]]] = [:]
    private var insights: [[String: Any]] = []
    private var expressions: [[String: Any]] = []
    private var planItems: [[String: Any]] = []
    private var projects: [[String: Any]] = []
    private var drawings: [[String: Any]] = []
    private var entries: [[String: Any]] = []
    private var settings: [String: Any] = [:]
    private var connectors: [[String: Any]] = []
    private var reviewedWords: Set<String> = []
    private var closedPR = false

    private init() {
        let titles = ["newsletter": "Field notes: a week of small discoveries", "paper": "Measuring patterns in a small garden", "article": "How to keep a useful reading notebook"]
        for type in ["newsletter", "paper", "article"] {
            for i in 0..<8 {
                let id = "sample-\(type)-\(i)"
                jobs.append(["_id": id, "title": i == 0 ? titles[type]! : "\(titles[type]!) · \(i + 1)",
                             "type": type, "url": "", "status": "done", "archived": i == 7,
                             "createdAt": now - Double(i) * 3_600_000, "summaryScores": [7.5]])
                if type == "newsletter" { jobs[jobs.count - 1]["summaryCount"] = 2 }
                if type == "paper" && i == 0 { jobs[jobs.count - 1]["imageId"] = "sample-image" }
                suggestions[id] = [["_id": "suggestion-\(id)", "status": i == 1 ? "executed" : "pending", "output": "notion",
                                    "pageName": "Reading notebook", "topic": "A practical observation", "pageUrl": "https://example.com/notebook",
                                    "contextBefore": "Questions to explore", "content": "Record one observation each day.\n- Compare it with the previous week.",
                                    "contextAfter": "Next experiment", "decidedAt": now]]
            }
        }
        let fixtureDate = Date(timeIntervalSince1970: now / 1000)
        for ago in 1..<14 {
            let date = Calendar.current.date(byAdding: .day, value: -ago, to: fixtureDate) ?? fixtureDate
            for index in 0..<(1 + (ago * 3) % 4) {
                jobs.append(["_id": "sample-newsletter-previous-\(ago)-\(index)",
                             "title": "Field notes: daily discoveries · \(day(ago: ago)) · \(index + 1)",
                             "type": "newsletter", "url": "", "status": "done", "archived": false,
                             "createdAt": date.timeIntervalSince1970 * 1000,
                             "summaryCount": 1 + (ago + index) % 5, "summaryScores": [7.5]])
            }
        }
        insights = [
            ["_id": "sample-insight-0", "text": "A question becomes easier to test when its terms are clear.", "origin": "manual", "status": "suggested", "provider": "codex", "createdAt": now, "interpretation": "Write down the observation that would change your mind.", "tags": ["learning"], "notionPageId": "sample-page", "notionPageName": "Study notes", "notionPageUrl": "https://example.com/notes", "notionContent": "Define the terms before designing the test.", "notionContextBefore": "Designing a test", "notionContextAfter": "Record the outcome"],
            ["_id": "sample-insight-1", "text": "A short walk can make room for a new idea.", "origin": "notion", "status": "placed", "createdAt": now - 60_000, "notionPageUrl": "https://example.com/notes", "provider": "codex"],
            ["_id": "sample-harvested", "text": "This harvested item must stay out of personal insights.", "origin": "paper", "status": "suggested", "createdAt": now]
        ]
        expressions = [["_id": "sample-word", "en": "take a closer look", "jp": "詳しく見る", "reading": "くわしくみる", "meaning": "살펴보다 · examine carefully", "example": "Take a closer look at the leaf.", "due": today, "pendingEnrich": false]]
        planItems = [["_id": "sample-event", "planSlug": "sample-plan", "date": today, "kind": "event", "title": "Visit the community garden", "timeStart": "10:00", "timeEnd": "11:00", "time": "10:00", "order": 0, "done": false, "notes": "Bring a notebook and sketch a plant.", "tags": ["study"]],
                     ["_id": "sample-todo", "planSlug": "sample-plan", "date": today, "kind": "todo", "title": "Write three observations", "order": 1, "done": false, "tags": []]]
        projects = [["_id": "sample-project", "slug": "garden-study", "title": "Community garden observations", "kind": "own", "phase": "literature", "visibility": "private", "updatedAt": now, "venue": "Local workshop"],
                    ["_id": "sample-review", "slug": "methods-review", "title": "Review of observation methods", "kind": "review", "phase": "drafting", "visibility": "private", "updatedAt": now]]
        drawings = [["_id": "sample-drawing", "title": "Garden layout", "updatedAt": now, "thumbnail": "data:image/png;base64," + (Self.sketch().pngData()?.base64EncodedString() ?? "")]]
        entries = [["_id": "sample-meal", "date": today, "name": "Vegetable rice bowl", "status": "done", "kcal": 480, "protein": 18, "carbs": 70, "fat": 14, "notes": "Rice, beans and seasonal vegetables.", "imageId": "sample-image"]]
        for ago in 1..<14 {
            entries.append(["_id": "sample-meal-previous-\(ago)", "date": day(ago: ago),
                            "name": ago.isMultiple(of: 2) ? "Vegetable noodles" : "Bean and rice bowl",
                            "status": "done", "kcal": 420 + (ago * 73) % 360,
                            "protein": 16 + ago % 12, "carbs": 55 + ago % 25, "fat": 12 + ago % 10])
        }
        settings = ["language": "en", "uiLanguage": UIText.lang,
                    "tabs": AppTabsCatalog.modes.map { ["key": $0, "enabled": true] as [String: Any] },
                    "onboarding": ["doneAt": now, "inputs": ["links"], "outputs": ["notion"]],
                    "github": ["loggedIn": false], "google": ["loggedIn": false]]
        connectors = [["_id": "sample-notion", "type": "notion", "name": "Study notebook", "auth": "token", "status": "connected", "config": ["rootPageId": "sample-page"]]]
    }

    private static func sketch() -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 480, height: 300)).image { context in
            UIColor(red: 0.92, green: 0.94, blue: 0.89, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 480, height: 300))
            UIColor(red: 0.28, green: 0.43, blue: 0.32, alpha: 1).setStroke()
            for i in 0..<3 {
                let path = UIBezierPath(roundedRect: CGRect(x: 35 + i * 145, y: 50, width: 120, height: 190), cornerRadius: 18)
                path.lineWidth = 5
                path.stroke()
            }
        }
    }

    private var imageURL: String {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("openworks-demo-garden.png")
        if !FileManager.default.fileExists(atPath: url.path) { try? Self.sketch().pngData()?.write(to: url) }
        return url.absoluteString
    }

    private func page(_ rows: [[String: Any]], _ args: [String: Any]) -> [String: Any] {
        let options = args["paginationOpts"] as? [String: Any] ?? [:]
        let start = min(Int(options["cursor"] as? String ?? "0") ?? 0, rows.count)
        let end = min(start + (options["numItems"] as? Int ?? 25), rows.count)
        return ["page": Array(rows[start..<end]), "isDone": end == rows.count, "continueCursor": String(end)]
    }

    private func day(ago: Int) -> String {
        let date = Date(timeIntervalSince1970: now / 1000)
        return calendarDay(Calendar.current.date(byAdding: .day, value: -ago, to: date) ?? date)
    }

    private func usageOverview(days requestedDays: Int) -> [String: Any] {
        let days = min(max(requestedDays, 1), 90)
        var perDay: [[String: Any]] = []
        var tabs: [[String: Any]] = []
        var totalVisits = 0
        var totalMs = 0
        for (index, tab) in ["paper", "plan", "vocab"].enumerated() {
            var visits = 0
            var activeMs = 0
            if !DemoMode.empty {
                for ago in (0..<days).reversed() {
                    let count = 2 + (ago * 7 + index * 3) % (9 - index)
                    let ms = count * (45 + (ago + index * 11) % 80) * 1_000
                    visits += count
                    activeMs += ms
                    if index == 0 {
                        perDay.append(["day": day(ago: ago), "visits": count, "activeMs": ms])
                    } else {
                        let i = days - ago - 1
                        perDay[i]["visits"] = (perDay[i]["visits"] as? Int ?? 0) + count
                        perDay[i]["activeMs"] = (perDay[i]["activeMs"] as? Int ?? 0) + ms
                    }
                }
                tabs.append(["tab": tab, "visits": visits, "activeMs": activeMs])
            }
            totalVisits += visits
            totalMs += activeMs
        }
        return ["totals": ["visits": totalVisits, "activeMs": totalMs,
                           "tabs": tabs.count, "browsers": DemoMode.empty ? 0 : 1],
                "tabs": tabs, "days": perDay, "truncated": false, "devCount": 0]
    }

    private func dietHistory(from: String, to: String) -> [[String: Any]] {
        guard !DemoMode.empty else { return [] }
        let completed = entries.filter { ($0["status"] as? String) == "done" }
        let byDay = Dictionary(grouping: completed) { $0["date"] as? String ?? today }
        return byDay.keys.filter { $0 >= from && $0 <= to }.sorted().map { date in
            let kcal = (byDay[date] ?? []).reduce(0.0) { $0 + (($1["kcal"] as? NSNumber)?.doubleValue ?? 0) }
            return ["date": date, "kcal": kcal]
        }
    }

    func response(kind: String, path: String, args: [String: Any]) throws -> Any {
        let id = args["jobId"] as? String ?? "sample-paper-0"
        switch path {
        case "settings:get": return settings
        case "settings:setUiLanguage": settings["uiLanguage"] = args["uiLanguage"]; return NSNull()
        case "settings:setLanguage": settings["language"] = args["language"]; return NSNull()
        case "settings:setTabs": settings["tabs"] = args["tabs"]; return NSNull()
        case "settings:saveOnboarding": settings["onboarding"] = args; return NSNull()
        case "settings:reopenOnboarding": return NSNull()
        case "jobs:count": return filteredJobs(args).count
        case "jobs:jobDateStats": return ["created": DemoMode.empty ? [] : [["date": today, "count": filteredJobs(args).count]], "published": []]
        case "jobs:listOffset":
            let rows = filteredJobs(args)
            let start = min(args["skip"] as? Int ?? 0, rows.count)
            return Array(rows.dropFirst(start).prefix(args["limit"] as? Int ?? 30))
        case "jobs:searchWithContent":
            let text = args["query"] as? String ?? ""
            return filteredJobs(args).filter { jobHeadline($0).localizedCaseInsensitiveContains(text) }
        case "jobs:getById": return jobs.first { $0["_id"] as? String == id } as Any? ?? NSNull()
        case "jobs:imageUrls": return id == "sample-paper-0" ? [imageURL] : []
        case "summaries:listByJob":
            return DemoMode.empty ? [] : [["_id": "summary-\(id)", "title": "Observations and next steps", "summary": "## What changed\nA small, repeatable observation helps answer a larger question.\n\nCompare two measurements with $x_2 - x_1$.", "tldr": ["Keep the method consistent.", "Write down what surprised you."], "scores": ["overall": 7.5, "clarity": 8, "soundness": 7], "keywords": ["observation", "learning"]]]
        case "suggestions:listByJob": return DemoMode.empty ? [] : suggestions[id] ?? []
        case "notion:approveAndExecute", "suggestions:updateStatus":
            let target = args["suggestionId"] as? String ?? ""
            for key in Array(suggestions.keys) {
                suggestions[key] = suggestions[key]?.map { row in
                    guard row["_id"] as? String == target else { return row }
                    var next = row
                    next["status"] = path.hasPrefix("notion:") ? "executed" : args["status"]
                    return next
                }
            }
            return NSNull()
        case "notion:approveAllAndExecute", "suggestions:rejectAll":
            suggestions[id] = suggestions[id]?.map { row in var next = row; next["status"] = path.hasPrefix("notion:") ? "executed" : "rejected"; return next }
            return NSNull()
        case "jobs:archive", "jobs:unarchive", "jobs:updateType":
            if let index = jobs.firstIndex(where: { $0["_id"] as? String == id }) {
                if path == "jobs:updateType" { jobs[index]["type"] = args["type"] }
                else { jobs[index]["archived"] = path == "jobs:archive" }
            }
            return NSNull()
        case "jobs:create":
            var row = args
            let id = "sample-added-\(jobs.count)"
            row["_id"] = id; row["title"] = args["title"] ?? args["content"] ?? "New reading item"
            row["status"] = "pending"; row["archived"] = false; row["createdAt"] = now
            jobs.insert(row, at: 0)
            return id
        case "jobs:newsletterStats":
            let rows = filteredJobs(args.merging(["type": "newsletter"]) { _, next in next })
            let byDay = Dictionary(grouping: rows) { row in
                calendarDay(Date(timeIntervalSince1970: (row["createdAt"] as? Double ?? now) / 1000))
            }
            let byDate = byDay.keys.sorted().map { date -> [String: Any] in
                let arrivals = byDay[date] ?? []
                return ["date": date, "total": arrivals.count,
                        "elements": arrivals.reduce(0) { $0 + ($1["summaryCount"] as? Int ?? 0) }]
            }
            return ["count": rows.count, "done": rows.filter { $0["status"] as? String == "done" }.count,
                    "elements": rows.reduce(0) { $0 + ($1["summaryCount"] as? Int ?? 0) },
                    "byDate": byDate, "bySource": rows.isEmpty ? [:] : ["Field notes": rows.count]]
        case "summaries:scoreStats":
            let slot: [String: Any] = ["count": DemoMode.empty ? 0 : 6, "sum": DemoMode.empty ? 0 : 42, "min": DemoMode.empty ? 0 : 5, "max": DemoMode.empty ? 0 : 9, "buckets": DemoMode.empty ? [:] : ["5": 1, "6": 1, "7": 2, "8": 1, "9": 1]]
            return ["paper": slot, "article": slot]
        case "insights:list": return DemoMode.empty ? [] : insights
        case "insights:imageUrl": return imageURL
        case "insights:setStatus", "notion:placeInsight":
            let target = args["id"] as? String ?? args["insightId"] as? String ?? ""
            if let index = insights.firstIndex(where: { $0["_id"] as? String == target }) { insights[index]["status"] = args["status"] ?? "placed" }
            return NSNull()
        case "insights:remove": insights.removeAll { $0["_id"] as? String == args["id"] as? String }; return NSNull()
        case "insights:add":
            insights.insert(["_id": "sample-insight-\(insights.count)", "text": args["raw"] ?? "", "origin": "manual", "status": "new", "createdAt": now], at: 0)
            return ["added": 1]
        case "plans:listAll": return DemoMode.empty ? [] : [["slug": "sample-plan", "title": "A day of discovery", "firstDate": today, "lastDate": today]]
        case "plans:allItems": return ["days": DemoMode.empty ? [] : [["_id": "sample-day", "planSlug": "sample-plan", "date": today, "dayLabel": "A day outdoors", "summary": "Observe, sketch and reflect."]], "items": DemoMode.empty ? [] : planItems]
        case "plans:toggleDone":
            if let index = planItems.firstIndex(where: { $0["_id"] as? String == args["itemId"] as? String }) { planItems[index]["done"] = !(planItems[index]["done"] as? Bool ?? false) }
            return NSNull()
        case "plans:createItem":
            var row = args
            row["_id"] = "sample-event-\(planItems.count)"
            row["planSlug"] = args["slug"]
            row["kind"] = "event"
            planItems.append(row)
            return row["_id"]!
        case "plans:updateItem", "plans:setArchived":
            if let i = planItems.firstIndex(where: { $0["_id"] as? String == args["itemId"] as? String }) {
                if path == "plans:updateItem" { planItems[i].merge(args) { _, next in next } }
                else {
                    var tags = (planItems[i]["tags"] as? [String] ?? []).filter { $0 != "archived" }
                    if args["archived"] as? Bool == true { tags.append("archived") }
                    planItems[i]["tags"] = tags
                }
            }
            return NSNull()
        case "plans:deleteItem": planItems.removeAll { $0["_id"] as? String == args["itemId"] as? String }; return NSNull()
        case "calendar:requestSyncDay", "calendar:latestForDay": return ["status": "done"]
        case "research:listByKind", "research:listAllProjects": return DemoMode.empty ? [] : projects.filter { args["kind"] == nil || $0["kind"] as? String == args["kind"] as? String }
        case "research:getStateInfo":
            guard let project = projects.first(where: { $0["slug"] as? String == args["slug"] as? String }) else { return NSNull() }
            let review = project["kind"] as? String == "review"
            return project.merging(["next": review ? ["ranking"] : ["poc", "ideation"],
                                    "allStates": review ? ["setup", "lit_review", "drafting", "ranking", "submitted", "rebuttal_audit", "final"] : ["ideation", "literature", "poc", "exp_plan", "design", "setup", "run", "analysis", "writing", "pre_submit_check", "submit_workshop", "submit_main", "reviews", "rebuttal", "accepted", "rejected", "takeaway", "slide", "poster"]]) { _, next in next }
        case "research:getTimeline": return [["state": "literature", "note": "Collected three methods to compare.", "at": now]]
        case "researchFiles:summary": return ["total": 3, "byType": ["memo": 2, "figure": 1]]
        case "researchPapers:listByResearch": return [["title": "A field guide to observation", "url": "https://example.com/paper"]]
        case "research:updatePhase", "research:setVisibility":
            if let i = projects.firstIndex(where: { $0["_id"] as? String == args["id"] as? String }) { projects[i].merge(args) { _, new in new } }
            return NSNull()
        case "research:upsert": var row = args; row["_id"] = "sample-project-\(projects.count)"; row["updatedAt"] = now; projects.append(row); return NSNull()
        case "research:remove": projects.removeAll { $0["_id"] as? String == args["id"] as? String }; return ["done": true]
        case "researchPhaseInfer:requestAll": return ["queued": projects.count]
        case "expressions:list": return DemoMode.empty ? [] : expressions
        case "expressions:due":
            let due = DemoMode.empty ? [] : expressions.filter { !reviewedWords.contains($0["_id"] as? String ?? "") }
            return ["due": due, "dueCount": due.count, "total": DemoMode.empty ? 0 : expressions.count]
        case "expressions:add": var row = args; row["_id"] = "sample-word-\(expressions.count)"; row["due"] = today; expressions.append(row); return NSNull()
        case "expressions:review": reviewedWords.insert(args["id"] as? String ?? ""); return NSNull()
        case "expressions:remove": expressions.removeAll { $0["_id"] as? String == args["id"] as? String }; return NSNull()
        case "diet:listByDate":
            let date = args["date"] as? String ?? today
            let shown = DemoMode.empty ? [] : entries.filter { $0["date"] as? String == date }
            let totals = Dictionary(uniqueKeysWithValues: ["kcal", "protein", "carbs", "fat"].map { key in
                (key, shown.reduce(0.0) { $0 + (($1[key] as? NSNumber)?.doubleValue ?? 0) })
            })
            return ["entries": shown, "totals": totals]
        case "diet:dailyTotals": return dietHistory(from: args["from"] as? String ?? day(ago: 13), to: args["to"] as? String ?? today)
        case "diet:imageUrl": return imageURL
        case "diet:createEntry": var row = args; row["_id"] = "sample-meal-\(entries.count)"; row["status"] = "pending"; entries.append(row); return NSNull()
        case "diet:remove": entries.removeAll { $0["_id"] as? String == args["entryId"] as? String }; return NSNull()
        case "usage:overview": return usageOverview(days: args["days"] as? Int ?? 30)
        case "usage:flow":
            let days = min(max(args["days"] as? Int ?? 30, 1), 90)
            return ["edges": DemoMode.empty ? [] : [["from": "paper", "to": "plan", "count": (days + 1) / 2], ["from": "plan", "to": "vocab", "count": (days + 2) / 3]], "truncated": false]
        case "authors:leaderboard": return page(DemoMode.empty ? [] : [["authorId": "sample-author", "name": "Researcher A", "institution": "Community Research Lab", "firstCount": 3, "lastCount": 2, "paperCount": 5, "scoreFirst": 7.4, "scoreLast": 7.2, "scoreAll": 7.3, "scoredFirst": 3, "scoredLast": 2, "scoredAll": 5]], args)
        case "authors:papersByAuthor": return page([["jobId": "sample-paper-0", "title": "Measuring patterns in a small garden", "position": "first", "overall": 7.5]], args)
        case "authors:resolveProgress": return ["total": DemoMode.empty ? 0 : 5, "resolved": DemoMode.empty ? 0 : 5, "pending": 0]
        case "authors:startResolveSweep": return ["queued": 0]
        case "mailbox:requestList": return ["id": "sample-mail-request"]
        case "mailbox:getRequest":
            let rows: [[String: Any]] = DemoMode.empty ? [] : [["id": "sample-mail", "from": "Weekly notebook", "subject": "Three questions for a curious weekend"]]
            return ["status": "done", "result": String(data: try JSONSerialization.data(withJSONObject: rows), encoding: .utf8)!]
        case "mailbox:requestMarkRead": return NSNull()
        case "drawings:list": return DemoMode.empty ? [] : drawings
        case "drawings:rename": if let i = drawings.firstIndex(where: { $0["_id"] as? String == args["id"] as? String }) { drawings[i]["title"] = args["title"] }; return NSNull()
        case "drawings:remove": drawings.removeAll { $0["_id"] as? String == args["id"] as? String }; return NSNull()
        case "connectors:list": return connectors
        case "setup:latestByKind": return NSNull()
        case "setup:request": return ["id": "sample-check"]
        case "connectors:connectNotionToken", "connectors:addObsidian", "connectors:setNotionConfig", "connectors:remove": return NSNull()
        case "notion:searchPages": return [["id": "sample-page", "title": "Study notes"]]
        case "notion:exportVocab": return ["count": expressions.count]
        case "notion:importVocabFromNotion": return ["imported": 1, "found": 1]
        case "github:listOpenPRs": return DemoMode.empty || closedPR ? [:] : ["sample/garden": [["id": 1, "repo": "sample/garden", "number": 12, "title": "Make the reading list easier to scan", "url": "https://example.com/pull/12", "author": "contributor", "labels": ["interface"], "draft": false, "updatedAt": "2026-11-01T09:00:00Z", "comments": 2, "mergeable": true]]]
        case "github:listPRDetails": return [["repo": "sample/garden", "number": 12, "mergeable": true, "behindBy": 1, "additions": 24, "deletions": 8, "changedFiles": 3]]
        case "github:getChecks": return ["checksPass": 3, "checksTotal": 3, "checksState": "success"]
        case "github:mergePR", "github:closePR": closedPR = true; return NSNull()
        case "github:updatePRBranch", "chats:send": return NSNull()
        case "chats:listByUrl": return [["role": "assistant", "content": "The layout change is ready for review."]]
        default: throw ConvexError.server("Missing demo response: \(path)")
        }
    }

    private func filteredJobs(_ args: [String: Any]) -> [[String: Any]] {
        if DemoMode.empty { return [] }
        return jobs.filter { $0["type"] as? String == args["type"] as? String && ($0["archived"] as? Bool ?? false) == (args["archived"] as? Bool ?? false) }
    }
}
