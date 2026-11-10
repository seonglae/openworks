import SwiftUI

private let DASH_WEEK_MS = 7 * 86_400_000.0
private let DASH_STALE = Theme.failure

private func dashInt(_ value: Any?) -> Int { (value as? NSNumber)?.intValue ?? 0 }

private struct DashWeek {
    let thisWeek: Int
    let lastWeek: Int
    let lastAt: Double?

    init(_ json: Any?) {
        let obj = json as? [String: Any] ?? [:]
        thisWeek = dashInt(obj["thisWeek"])
        lastWeek = dashInt(obj["lastWeek"])
        lastAt = (obj["lastAt"] as? NSNumber)?.doubleValue
    }
}

private struct DashPhase {
    let key: String
    let label: String
    let count: Int
}

private struct DashProject {
    let slug: String
    let title: String
    let label: String
    let at: Double
}

private struct DashSummary {
    let newsletter: DashWeek
    let article: DashWeek
    let papers: DashWeek
    let insightsAwaiting: Int
    let insightsCapped: Bool
    let projects: Int
    let phases: [DashPhase]
    let recent: [DashProject]

    init?(_ json: [String: Any]) {
        guard let research = json["research"] as? [String: Any],
              let productivity = json["productivity"] as? [String: Any] else { return nil }
        newsletter = DashWeek(productivity["newsletter"])
        article = DashWeek(productivity["article"])
        insightsAwaiting = dashInt(productivity["insightsAwaiting"])
        insightsCapped = (productivity["insightsCapped"] as? Bool) ?? false
        papers = DashWeek(research["papers"])
        projects = dashInt(research["total"])
        phases = (research["phases"] as? [[String: Any]] ?? []).compactMap { p in
            guard let key = p["key"] as? String else { return nil }
            return DashPhase(key: key, label: (p["label"] as? String) ?? key, count: dashInt(p["count"]))
        }
        recent = (research["recent"] as? [[String: Any]] ?? []).compactMap { p in
            guard let slug = p["slug"] as? String else { return nil }
            return DashProject(slug: slug, title: (p["title"] as? String) ?? slug, label: (p["label"] as? String) ?? "",
                               at: (p["at"] as? NSNumber)?.doubleValue ?? 0)
        }

    }
}

private struct DashPR {
    let repo: String
    let number: Int
    var checksState: String
    var mergeable: Bool?
}

@MainActor
private final class DashboardModel: ObservableObject {
    @Published var summary: DashSummary?
    @Published var error: String?
    @Published var prs: [DashPR]?
    @Published var prError: String?

    func load(refreshPRs: Bool) async {
        async let summary: Void = loadSummary()
        if refreshPRs || prs == nil { await loadPRs() }
        await summary
    }

    private func loadSummary() async {
        do {
            async let newsletter = weekCounts("newsletter")
            async let article = weekCounts("article")
            async let papers = weekCounts("paper")
            async let projects = ConvexHTTP.query("research:listAllProjects")
            async let insights = ConvexHTTP.query("insights:list")
            guard let rows = try await projects as? [[String: Any]],
                  let notes = try await insights as? [[String: Any]] else { throw ConvexError.shape }
            let phases = Dictionary(grouping: rows, by: { $0["phase"] as? String ?? "" })
            let labels = ResearchModel()
            let recent: [[String: Any]] = rows.prefix(3).map { row in
                labels.kind = row["kind"] as? String ?? "own"
                return ["slug": row["slug"] ?? "", "title": row["title"] ?? "",
                        "label": labels.label(row["phase"] as? String ?? ""), "at": row["updatedAt"] ?? 0]
            }
            let counts: [[String: Any]] = phases.keys.sorted().map { phase in
                labels.kind = phases[phase]?.first?["kind"] as? String ?? "own"
                return ["key": phase, "label": labels.label(phase), "count": phases[phase]?.count ?? 0]
            }
            let awaiting = notes.filter {
                ["manual", "notion"].contains($0["origin"] as? String ?? "") && ["new", "suggested"].contains($0["status"] as? String ?? "")
            }.count
            let json: [String: Any] = try await [
                "productivity": ["newsletter": newsletter, "article": article, "insightsAwaiting": awaiting],
                "research": ["papers": papers, "total": rows.count, "phases": counts, "recent": recent]
            ]
            guard let summary = DashSummary(json) else { throw ConvexError.shape }
            self.summary = summary
            error = nil
        } catch {
            if !Task.isCancelled { self.error = error.localizedDescription }
        }
    }

    private func weekCounts(_ type: String) async throws -> [String: Any] {
        async let active = ConvexHTTP.query("jobs:jobDateStats", args: ["type": type, "archived": false])
        async let archived = ConvexHTTP.query("jobs:jobDateStats", args: ["type": type, "archived": true])
        let responses = try await [active, archived]
        var buckets: [String: Int] = [:]
        for response in responses {
            guard let value = response as? [String: Any], let rows = value["created"] as? [[String: Any]] else { throw ConvexError.shape }
            for row in rows {
                if let day = row["date"] as? String { buckets[day, default: 0] += dashInt(row["count"]) }
            }
        }
        let now = Date()
        let thisWeek = calendarDay(Calendar.current.date(byAdding: .day, value: -6, to: now) ?? now)
        let lastWeek = calendarDay(Calendar.current.date(byAdding: .day, value: -13, to: now) ?? now)
        let end = calendarDay(now)
        var result: [String: Any] = [
            "thisWeek": buckets.filter { $0.key >= thisWeek && $0.key <= end }.values.reduce(0, +),
            "lastWeek": buckets.filter { $0.key >= lastWeek && $0.key < thisWeek }.values.reduce(0, +)
        ]
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        if let last = buckets.keys.max(), let date = formatter.date(from: last) { result["lastAt"] = date.timeIntervalSince1970 * 1000 }
        return result
    }

    private func loadPRs() async {
        do {
            guard let grouped = try await ConvexHTTP.action("github:listOpenPRs") as? [String: Any] else {
                throw ConvexError.shape
            }
            var list = grouped.values.flatMap { $0 as? [[String: Any]] ?? [] }.compactMap { p -> DashPR? in
                guard let repo = p["repo"] as? String, let number = (p["number"] as? NSNumber)?.intValue else { return nil }
                return DashPR(repo: repo, number: number, checksState: (p["checksState"] as? String) ?? "",
                              mergeable: p["mergeable"] as? Bool)
            }
            for i in list.indices {
                guard let check = try await ConvexHTTP.action("github:getChecks", args: ["repo": list[i].repo, "number": list[i].number]) as? [String: Any] else { throw ConvexError.shape }
                list[i].checksState = check["checksState"] as? String ?? "none"
            }
            prError = nil
            guard !list.isEmpty else { prs = []; return }
            let refs = list.map { ["repo": $0.repo, "number": $0.number] as [String: Any] }
            guard let details = try await ConvexHTTP.action("github:listPRDetails", args: ["prs": refs]) as? [[String: Any]]
            else { throw ConvexError.shape }
            var mergeable: [String: Bool] = [:]
            for d in details {
                guard let repo = d["repo"] as? String, let number = (d["number"] as? NSNumber)?.intValue,
                      let m = d["mergeable"] as? Bool else { continue }
                mergeable["\(repo)#\(number)"] = m
            }
            prs = list.map { pr in
                var pr = pr
                pr.mergeable = mergeable["\(pr.repo)#\(pr.number)"] ?? pr.mergeable
                return pr
            }
        } catch {
            if !Task.isCancelled { prError = error.localizedDescription }
        }
    }
}

struct DashboardView: View {
    @Environment(\.appearanceTokens) private var theme
    @StateObject private var model = DashboardModel()
    @EnvironmentObject private var shell: Shell

    init() {}

    var body: some View {
        TabNavigationStack {
            List {
                LiquidRefreshHeader()
                if let error = model.error {
                    LoadFailure(message: error) { Task { await model.load(refreshPRs: true) } }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .glassRow().glassRowLayout()
                }
                if model.error == nil || model.summary != nil {
                    productivity
                    research
                }
                hobby
            }
            .liquidList()
            .accessibilityIdentifier("dashboard.scroll")
            .navigationTitle(UIText.t("대시보드", "Dashboard"))
            .liquidRefreshable { await model.load(refreshPRs: true) }
            .task { await model.load(refreshPRs: false) }
        }
    }

    private var productivity: some View {
        card("productivity") {
            if let s = model.summary {
                HStack(alignment: .top, spacing: theme.space(3)) {
                    week(UIText.tab("newsletter"), s.newsletter).accessibilityIdentifier("dashboard.loaded").frame(maxWidth: .infinity, alignment: .leading)
                    week(UIText.tab("article"), s.article).frame(maxWidth: .infinity, alignment: .leading)
                }
                stat(UIText.t("배치를 기다리는 인사이트", "Insights awaiting placement"),
                     "\(s.insightsAwaiting)\(s.insightsCapped ? "+" : "")")
            } else {
                HStack(alignment: .top, spacing: theme.space(3)) {
                    week(UIText.tab("newsletter"), DashWeek(nil)).frame(maxWidth: .infinity, alignment: .leading)
                    week(UIText.tab("article"), DashWeek(nil)).frame(maxWidth: .infinity, alignment: .leading)
                }.loadingPlaceholder()
                    .loadingAccessibility("dashboard.loading", label: UIText.t("대시보드 불러오는 중", "Loading dashboard"))
                stat(UIText.t("배치를 기다리는 인사이트", "Insights awaiting placement"), "0").loadingPlaceholder()
            }
            links {
                go("newsletter")
                go("article")
                go("insights")
            }
        }
    }

    private var research: some View {
        card("research") {
            if let s = model.summary {
                VStack(alignment: .leading, spacing: theme.space(2.5)) {
                    stat(UIText.t("프로젝트", "Projects"), "\(s.projects)")
                    DashPhaseBar(phases: s.phases)
                }
                week(UIText.tab("paper"), s.papers)
                if !s.recent.isEmpty {
                    links(stacked: true) {
                        ForEach(s.recent, id: \.slug) { p in
                            Button { shell.tab = "research" } label: {
                                HStack(spacing: theme.space(1)) {
                                    VStack(alignment: .leading, spacing: theme.space(0.25)) {
                                        Text(p.title).themeText(.meta).lineLimit(1)
                                        Text("\(p.label) · \(UIText.relativeTime(p.at))")
                                            .themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary)
                                    }
                                    Spacer(minLength: theme.space(1))
                                    ListIcon(systemName: "arrow.up.right").foregroundStyle(Theme.secondary)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("dashboard.research.\(p.slug)")
                        }
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: theme.space(2.5)) {
                    stat(UIText.t("프로젝트", "Projects"), "0").loadingPlaceholder()
                    Skeleton().frame(height: theme.space(2))
                    SkeletonText(role: .meta, width: 0.7)
                }
                week(UIText.tab("paper"), DashWeek(nil)).loadingPlaceholder()
                links(stacked: true) {
                    ForEach(0..<2, id: \.self) { _ in
                        VStack(alignment: .leading, spacing: theme.space(0.25)) {
                            SkeletonText(role: .meta, width: 0.8)
                            SkeletonText(role: .meta, width: 0.6)
                        }
                    }
                }
            }
        }
    }

    private var hobby: some View {
        card("hobby") {
            if let error = model.prError { LoadFailure(message: error) }
            if let prs = model.prs {
                HStack(alignment: .top, spacing: theme.space(3)) {
                    stat(UIText.t("열린 PR", "Open PRs"), "\(prs.count)")
                        .frame(maxWidth: .infinity, alignment: .leading)
                    stat(UIText.t("check 실패", "Failing checks"), "\(prs.filter { $0.checksState == "failure" }.count)")
                        .frame(maxWidth: .infinity, alignment: .leading)
                    stat(UIText.t("충돌", "Conflicts"),
                         prs.contains(where: { $0.mergeable != nil }) ? "\(prs.filter { $0.mergeable == false }.count)" : "…")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else if model.prError == nil {
                HStack(alignment: .top, spacing: theme.space(3)) {
                    stat(UIText.t("열린 PR", "Open PRs"), "0").frame(maxWidth: .infinity, alignment: .leading)
                    stat(UIText.t("check 실패", "Failing checks"), "0").frame(maxWidth: .infinity, alignment: .leading)
                    stat(UIText.t("충돌", "Conflicts"), "0").frame(maxWidth: .infinity, alignment: .leading)
                }.loadingPlaceholder()
            }
            links { go("pr") }
        }
    }

    private func card<Content: View>(_ island: String, title: String? = nil,
                                     @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: theme.space(3.5)) {
            HStack(alignment: .firstTextBaseline, spacing: theme.value("rowGap")) {
                IslandMark(key: island)
                Text(title ?? Island.label(island))
                    .themeText(.title).foregroundStyle(Theme.secondary)
            }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassRow().glassRowLayout()
    }

    private func links<Items: View>(stacked: Bool = false, @ViewBuilder _ items: () -> Items) -> some View {
        VStack(alignment: .leading, spacing: theme.space(2.5)) {
            Divider()
            if stacked {
                VStack(alignment: .leading, spacing: theme.space(2)) { items() }
            } else {
                HStack(spacing: theme.space(4)) { items() }
            }
        }
    }

    @ViewBuilder
    private func go(_ tab: String) -> some View {
        if !shell.hiddenTabs.contains(tab) {
            Button { shell.tab = tab } label: { linkLabel(UIText.tab(tab)) }
                .buttonStyle(.plain)
        }
    }

    private func linkLabel(_ text: String) -> some View {
        HStack(spacing: theme.space(0.75)) {
            Text(text).themeText(.meta)
            ListIcon(systemName: "arrow.up.right").foregroundStyle(Theme.secondary)
        }
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: theme.value("rowTextGap")) {
            Text(value).themeText(.heading, design: .monospaced)
            Text(label).themeText(.meta).foregroundStyle(Theme.secondary)
        }
    }

    private func week(_ label: String, _ week: DashWeek) -> some View {
        VStack(alignment: .leading, spacing: theme.value("rowTextGap")) {
            Text("\(week.thisWeek)").themeText(.heading, design: .monospaced)
            Text(label).themeText(.meta)
            Text(UIText.t("최근 7일 · 지난주 \(week.lastWeek)", "last 7 days · week before \(week.lastWeek)"))
                .themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary)
            if let at = week.lastAt, Date().timeIntervalSince1970 * 1000 - at > DASH_WEEK_MS {
                Text(UIText.t("마지막 수집 \(UIText.relativeTime(at))", "last intake \(UIText.relativeTime(at))"))
                    .themeText(.meta).foregroundStyle(DASH_STALE)
            }
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).themeText(.meta).foregroundStyle(Theme.secondary)
    }

}

private struct DashPhaseBar: View {
    @Environment(\.appearanceTokens) private var theme
    let phases: [DashPhase]

    private var total: Int { phases.reduce(0) { $0 + $1.count } }
    private func shade(_ i: Int) -> Double { 0.35 + 0.65 * Double(i + 1) / Double(phases.count) }

    var body: some View {
        if total > 0 {
            VStack(alignment: .leading, spacing: theme.space(2)) {
                GeometryReader { geo in
                    HStack(spacing: theme.space(0)) {
                        ForEach(Array(phases.enumerated()), id: \.element.key) { i, p in
                            Rectangle().fill(Theme.ink).opacity(shade(i))
                                .frame(width: geo.size.width * CGFloat(p.count) / CGFloat(total))
                        }
                    }
                }
                .frame(height: 8)
                .background(Color.primary.opacity(0.07))
                .clipShape(RoundedRectangle(cornerRadius: theme.value("radiusPill")))
                FlowLayout(spacing: theme.space(2.5)) {
                    ForEach(Array(phases.enumerated()), id: \.element.key) { i, p in
                        HStack(alignment: .firstTextBaseline, spacing: theme.value("rowGap")) {
                            IslandMark(key: "research").opacity(shade(i))
                            Text(p.label)
                            Text("\(p.count)").monospaced().foregroundStyle(Theme.secondary)
                        }
                        .themeText(.meta)
                    }
                }
            }
        }
    }
}
