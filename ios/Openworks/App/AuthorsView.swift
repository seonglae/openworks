import SwiftUI

private let AUTHORS_MIN_PAPERS = 2
private let AUTHORS_PAGE = 25
private let AUTHOR_PAPERS_PAGE = 10

private struct AuthorAxis {
    let key: String
    let ko: String
    let en: String
    let hintKo: String
    let hintEn: String
}

private let AUTHOR_POSITIONS = [
    AuthorAxis(key: "first", ko: "제1저자", en: "1st author",
               hintKo: "제1저자로 쓴 논문", hintEn: "papers where this researcher is first author"),
    AuthorAxis(key: "last", ko: "교신저자", en: "corresponding",
               hintKo: "마지막(교신) 저자로 쓴 논문", hintEn: "papers where this researcher is last author"),
    AuthorAxis(key: "all", ko: "모든 저자", en: "any author",
               hintKo: "이름이 오른 모든 논문", hintEn: "every paper the researcher appears on"),
]

private let AUTHOR_METRICS = [
    AuthorAxis(key: "score", ko: "점수", en: "Score",
               hintKo: "paper score의 shrunk mean이라 운 좋은 한 편이 1위가 되지 못해요",
               hintEn: "shrunk mean of the paper scores, so one lucky paper cannot top the list"),
    AuthorAxis(key: "count", ko: "편수", en: "Count",
               hintKo: "서로 다른 논문 수", hintEn: "number of distinct papers"),
]

private struct AuthorStat: Identifiable {
    let id: String
    let name: String
    let orcid: URL?
    let institution: String?
    let count: [String: Int]
    let score: [String: Double]
    let raw: [String: Double]
    let scored: [String: Int]

    init?(_ json: [String: Any]) {
        guard let id = json["authorId"] as? String, let name = json["name"] as? String else { return nil }
        func n(_ key: String) -> Double { (json[key] as? NSNumber)?.doubleValue ?? 0 }
        self.id = id
        self.name = name
        orcid = (json["orcid"] as? String).flatMap(URL.init(string:))
        institution = json["institution"] as? String
        count = ["first": Int(n("firstCount")), "last": Int(n("lastCount")), "all": Int(n("paperCount"))]
        score = ["first": n("scoreFirst"), "last": n("scoreLast"), "all": n("scoreAll")]
        raw = ["first": n("rawFirst"), "last": n("rawLast"), "all": n("rawAll")]
        scored = ["first": Int(n("scoredFirst")), "last": Int(n("scoredLast")), "all": Int(n("scoredAll"))]
    }
}

private struct AuthorPaper: Identifiable {
    let id: String
    let title: String
    let url: URL?
    let archived: Bool
    let position: String
    let overall: Double?

    init?(_ json: [String: Any]) {
        guard let id = json["jobId"] as? String else { return nil }
        self.id = id
        title = (json["title"] as? String) ?? UIText.t("(제목 없음)", "(untitled)")
        url = (json["url"] as? String).flatMap { $0.isEmpty ? nil : URL(string: $0) }
        archived = (json["archived"] as? Bool) ?? false
        position = (json["position"] as? String) ?? ""
        overall = (json["overall"] as? NSNumber)?.doubleValue
    }
}

private func authorsPage(_ cursor: String?, size: Int) -> [String: Any] {
    var opts: [String: Any] = ["numItems": size, "cursor": NSNull()]
    if let cursor { opts["cursor"] = cursor }
    return opts
}

@MainActor
private final class AuthorsModel: ObservableObject {
    @Published var position = "first"
    @Published var metric = "score"
    @Published var rows: [AuthorStat] = []
    @Published var done = false
    @Published var cursor: String?
    @Published var progress: (total: Int, resolved: Int, pending: Int)?
    @Published var sweeping = false
    @Published var error: String?
    @Published var loaded = false
    private var generation = 0

    var axis: String { "\(position):\(metric)" }

    func select(position: String, metric: String) {
        guard position != self.position || metric != self.metric else { return }
        self.position = position
        self.metric = metric
        generation += 1
        rows = []
        cursor = nil
        done = false
        loaded = false
    }

    private func fetch(after cursor: String?) async throws -> (rows: [AuthorStat], done: Bool, cursor: String?) {
        let value = try await ConvexHTTP.query("authors:leaderboard", args: [
            "position": position, "metric": metric,
            "paginationOpts": authorsPage(cursor, size: AUTHORS_PAGE),
        ])
        guard let obj = value as? [String: Any], let page = obj["page"] as? [[String: Any]] else { throw ConvexError.shape }
        return (page.compactMap(AuthorStat.init).filter { ($0.scored[position] ?? 0) >= AUTHORS_MIN_PAPERS }, (obj["isDone"] as? Bool) ?? true, obj["continueCursor"] as? String)
    }

    func load() async {
        generation += 1
        let mine = generation
        do {
            let first = try await fetch(after: nil)
            guard mine == generation else { return }
            rows = first.rows
            done = first.done
            cursor = first.cursor
            error = nil
        } catch {
            guard mine == generation, !Task.isCancelled else { return }
            self.error = error.localizedDescription
            done = true
        }
        loaded = true
        await loadProgress()
    }

    func loadMore() async {
        guard loaded, !done, let cursor else { return }
        let mine = generation
        do {
            let next = try await fetch(after: cursor)
            guard mine == generation else { return }
            let seen = Set(rows.map(\.id))
            rows += next.rows.filter { !seen.contains($0.id) }
            done = next.done
            self.cursor = next.cursor
        } catch {
            guard mine == generation, !Task.isCancelled else { return }
            self.error = error.localizedDescription
            done = true
        }
    }

    func loadProgress() async {
        do {
        guard let p = try await ConvexHTTP.query("authors:resolveProgress") as? [String: Any] else { throw ConvexError.shape }
        func n(_ key: String) -> Int { (p[key] as? NSNumber)?.intValue ?? 0 }
        progress = (n("total"), n("resolved"), n("pending"))
        } catch { self.error = error.localizedDescription }
    }

    func sweep() async {
        sweeping = true
        defer { sweeping = false }
        do {
            try await ConvexHTTP.mutation("authors:startResolveSweep")
            await loadProgress()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

@MainActor
private final class AuthorPapersModel: ObservableObject {
    let authorId: String
    @Published var papers: [AuthorPaper] = []
    @Published var done = false
    @Published var loading = false
    @Published var error: String?
    private var cursor: String?

    init(authorId: String) { self.authorId = authorId }

    func more() async {
        guard !done, !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let value = try await ConvexHTTP.query("authors:papersByAuthor", args: [
                "authorId": authorId, "paginationOpts": authorsPage(cursor, size: AUTHOR_PAPERS_PAGE),
            ])
            guard let obj = value as? [String: Any], let page = obj["page"] as? [[String: Any]] else {
                throw ConvexError.shape
            }
            let seen = Set(papers.map(\.id))
            papers += page.compactMap(AuthorPaper.init).filter { !seen.contains($0.id) }
            cursor = obj["continueCursor"] as? String
            done = (obj["isDone"] as? Bool) ?? true
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct AuthorsView: View {
    @Environment(\.appearanceTokens) private var theme
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = AuthorsModel()
    @State private var openId: String?
    let showsClose: Bool

    init(showsClose: Bool = false) { self.showsClose = showsClose }

    private var namesakes: Set<String> {
        let counts = Dictionary(model.rows.map { ($0.name, 1) }, uniquingKeysWith: +)
        return Set(counts.filter { $0.value > 1 }.keys)
    }

    var body: some View {
        TabNavigationStack {
            List {
                LiquidRefreshHeader()
                controls.glassRow().glassRowLayout()
                if let error = model.error {
                    LoadFailure(message: error)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .glassRow().glassRowLayout()
                }
                Section {
                    let repeated = namesakes
                    ForEach(Array(model.rows.enumerated()), id: \.element.id) { i, row in
                        AuthorCard(rank: i + 1, row: row, position: model.position, metric: model.metric,
                                   namesake: repeated.contains(row.name), open: openId == row.id) {
                            openId = openId == row.id ? nil : row.id
                        }
                        .glassRow().glassRowLayout()
                    }
                    if !model.loaded || !model.done {
                        VStack(spacing: theme.value("cardGap")) {
                            ForEach(0..<(model.loaded ? 1 : 5), id: \.self) { _ in
                                HStack(alignment: .firstTextBaseline, spacing: theme.value("rowGap")) {
                                    SkeletonIcon()
                                    SkeletonText(role: .meta).frame(width: theme.space(5.5))
                                    VStack(alignment: .leading, spacing: theme.space(0.5)) {
                                        SkeletonText(width: 0.85)
                                        SkeletonText(role: .meta, width: 0.7)
                                    }
                                    if model.metric == "score" {
                                        SkeletonText(role: .meta).frame(width: theme.space(12))
                                    }
                                    SkeletonText().frame(width: theme.space(8))
                                }
                                .glassRow()
                            }
                        }.glassRowLayout()
                            .loadingAccessibility("authors.loading", label: UIText.t("저자 불러오는 중", "Loading authors"))
                            .task(id: model.cursor) { await model.loadMore() }
                    } else if model.rows.isEmpty && model.error == nil {
                        Text(emptyText)
                            .themeText(.meta).foregroundStyle(Theme.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .glassRow().glassRowLayout()
                    }
                } header: {
                    Text(UIText.t("순위", "Leaderboard")).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary).textCase(nil)
                }
                Text(UIText.t(
                    "순위에 오르려면 지금 보는 position에서 score가 매겨진 논문이 \(AUTHORS_MIN_PAPERS)편 이상이어야 해요. 그래서 목록이 짧은 건 논문을 한 편씩 읽어 온 결과이지 빠진 게 아니에요. 저자는 이름이 아니라 OpenAlex author entity로 구분해서, 이름이 같은 연구자도 따로 남아요. OpenAlex에 entity가 없는 저자는 이름으로 합치지 않고 순위에서 빠져요.",
                    "Ranked authors need \(AUTHORS_MIN_PAPERS) scored papers in the position being ranked, so a short board means a corpus read one paper at a time, not a missing one. Identities are OpenAlex author entities, not names, so researchers who share a name stay separate. Authors OpenAlex has no entity for are left off these rankings rather than merged by name."))
                    .themeText(.meta).foregroundStyle(Theme.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, theme.space(1))
                    .glassRowLayout()
            }
            .liquidList()
            .accessibilityIdentifier("authors.scroll")
            .navigationTitle(UIText.t("저자", "Authors"))
            .toolbar {
                if showsClose {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(UIText.t("닫기", "Close")) { dismiss() }
                            .accessibilityIdentifier("authors.close")
                    }
                }
            }
            .liquidRefreshable { await model.load() }
            .task(id: model.axis) { await model.load() }
        }
    }

    private var emptyText: String {
        if (model.progress?.resolved ?? 0) > 0 {
            return UIText.t("이 position에서 score가 매겨진 논문이 \(AUTHORS_MIN_PAPERS)편 이상인 저자가 아직 없어요.",
                            "No author has \(AUTHORS_MIN_PAPERS) scored papers in this position yet.")
        }
        return UIText.t("아직 저자가 없어요. 논문을 처리하면 자동으로 resolve돼요.",
                        "No authors yet. Process a paper and they resolve automatically.")
    }

    private var controls: some View {
        let position = AUTHOR_POSITIONS.first { $0.key == model.position } ?? AUTHOR_POSITIONS[0]
        let metric = AUTHOR_METRICS.first { $0.key == model.metric } ?? AUTHOR_METRICS[0]
        return VStack(alignment: .leading, spacing: theme.space(2.5)) {
            SegmentedButtons(title: UIText.t("자리", "Position"), selection: Binding(
                get: { model.position },
                set: { openId = nil; model.select(position: $0, metric: model.metric) }), options:
                AUTHOR_POSITIONS.map { .init(id: "authors.position.\($0.key)", value: $0.key, title: UIText.t($0.ko, $0.en)) })
            SegmentedButtons(title: UIText.t("기준", "Metric"), selection: Binding(
                get: { model.metric },
                set: { openId = nil; model.select(position: model.position, metric: $0) }), options:
                AUTHOR_METRICS.map { .init(id: "authors.metric.\($0.key)", value: $0.key, title: UIText.t($0.ko, $0.en)) })
            Text(UIText.t(position.hintKo, position.hintEn) + " · " + UIText.t(metric.hintKo, metric.hintEn))
                .themeText(.meta).foregroundStyle(Theme.secondary)
            if let pending = model.progress?.pending, pending > 0 {
                Button {
                    Task { await model.sweep() }
                } label: {
                    HStack(spacing: theme.space(1.5)) {
                        if model.sweeping { ProgressView().controlSize(.small) }
                        Text(UIText.t("대기 중인 \(pending)편 resolve", "Resolve \(pending) pending"))
                    }
                    .themeText(.meta, design: .monospaced)
                }
                .buttonStyle(.borderless)
                .tint(Theme.accent)
                .disabled(model.sweeping)
            }
        }
    }
}

private struct AuthorCard: View {
    @Environment(\.appearanceTokens) private var theme
    let rank: Int
    let row: AuthorStat
    let position: String
    let metric: String
    let namesake: Bool
    let open: Bool
    let toggle: () -> Void

    private var scored: Int { row.scored[position] ?? 0 }
    private var score: Double { row.score[position] ?? 0 }
    private var raw: Double { row.raw[position] ?? 0 }

    private var value: String {
        metric == "count" ? "\(row.count[position] ?? 0)" : String(format: "%.2f", score)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space(2)) {
            Button(action: toggle) {
                HStack(alignment: .firstTextBaseline, spacing: theme.value("rowGap")) {
                    ListIcon(systemName: "chevron.right")
                        .foregroundStyle(Theme.secondary)
                        .rotationEffect(.degrees(open ? 90 : 0))
                    Text("\(rank)").themeText(.meta).monospacedDigit().foregroundStyle(Theme.secondary)
                        .frame(minWidth: 22, alignment: .trailing)
                    VStack(alignment: .leading, spacing: theme.space(0.5)) {
                        HStack(spacing: theme.space(1.5)) {
                            Text(row.name).themeText(.title).lineLimit(1)
                            if namesake {
                                Text(row.id).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary).lineLimit(1)
                            }
                        }
                        if let institution = row.institution {
                            Text(institution).themeText(.meta).foregroundStyle(Theme.secondary).lineLimit(1)
                        }
                    }
                    Spacer(minLength: theme.space(2))
                    if metric == "score" {
                        Text(UIText.t("\(scored)편", "\(scored) papers"))
                            .themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary)
                    }
                    Text(value).themeText(.title).monospacedDigit()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("authors.row.\(row.id)")
            if open {
                FlowLayout(spacing: theme.space(2.5)) {
                    Text(UIText.t("제1저자 \(row.count["first"] ?? 0)", "1st \(row.count["first"] ?? 0)"))
                    Text(UIText.t("교신 \(row.count["last"] ?? 0)", "corresponding \(row.count["last"] ?? 0)"))
                    Text(UIText.t("전체 \(row.count["all"] ?? 0)", "total \(row.count["all"] ?? 0)"))
                    if scored > 0 {
                        Text(UIText.t(
                            "score \(String(format: "%.2f", score)) (평균 \(String(format: "%.2f", raw)), \(scored)편)",
                            "score \(String(format: "%.2f", score)) (mean \(String(format: "%.2f", raw)) of \(scored))"))
                    }
                    if let orcid = row.orcid {
                        Link("ORCID", destination: orcid).foregroundStyle(Theme.link).buttonStyle(.borderless)
                    }
                }
                .themeText(.meta, design: .monospaced)
                .foregroundStyle(Theme.secondary)
                .padding(.leading, theme.space(7.5))
                AuthorPaperList(authorId: row.id).padding(.leading, theme.space(7.5))
            }
        }
    }
}

private struct AuthorPaperList: View {
    @Environment(\.appearanceTokens) private var theme
    @StateObject private var model: AuthorPapersModel

    init(authorId: String) {
        _model = StateObject(wrappedValue: AuthorPapersModel(authorId: authorId))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space(1.5)) {
            ForEach(model.papers) { paper in
                HStack(alignment: .firstTextBaseline, spacing: theme.space(2)) {
                    Text(paper.position == "first" ? UIText.t("제1저자", "First") : paper.position == "last" ? UIText.t("교신저자", "Last") : UIText.t("공동저자", "Coauthor")).themeText(.meta, design: .monospaced).textCase(.uppercase)
                        .foregroundStyle(Theme.secondary).frame(width: 46, alignment: .leading)
                    Group {
                        if let url = paper.url {
                            Link(paper.title, destination: url).foregroundStyle(Theme.link).buttonStyle(.borderless)
                        } else {
                            Text(paper.title)
                        }
                    }
                    .themeText(.meta)
                    .multilineTextAlignment(.leading)
                    .accessibilityIdentifier("authors.paper.\(paper.id)")
                    Spacer(minLength: theme.space(1))
                    if paper.archived {
                        Text(UIText.t("보관", "archived")).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary)
                    }
                    if let overall = paper.overall {
                        Text(String(format: "%g", overall)).themeText(.meta, design: .monospaced)
                    }
                }
            }
            if model.done && model.papers.isEmpty && model.error == nil {
                Text(UIText.t("연결된 논문이 없어요.", "No linked papers.")).themeText(.meta).foregroundStyle(Theme.secondary)
            }
            if model.loading {
                HStack(alignment: .firstTextBaseline, spacing: theme.space(2)) {
                    SkeletonText(role: .meta).frame(width: theme.space(11.5))
                    SkeletonText(role: .meta, lines: 2, width: 0.8)
                    SkeletonText(role: .meta).frame(width: theme.space(6))
                }
            } else if !model.done {
                Button(UIText.t("더 보기", "More")) { Task { await model.more() } }
                    .themeText(.meta, design: .monospaced)
                    .buttonStyle(.borderless)
                    .tint(Theme.accent)
            }
            if let error = model.error {
                LoadFailure(message: error)
            }
        }
        .task { if model.papers.isEmpty && !model.done { await model.more() } }
    }
}
