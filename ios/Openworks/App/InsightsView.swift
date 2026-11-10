import PhotosUI
import SwiftUI
import UIKit

private let INSIGHT_STATUSES = ["suggested", "new", "placed", "dismissed", "error"]
private let AGENT_ORDER = ["claude", "gemini", "antigravity", "codex"]

private func statusLabel(_ status: String) -> String {
    switch status {
    case "suggested": return UIText.t("제안", "Suggested")
    case "new": return UIText.t("대기", "New")
    case "placed": return UIText.t("넣음", "Placed")
    case "dismissed": return UIText.t("닫음", "Dismissed")
    case "error": return UIText.t("오류", "Error")
    default: return status
    }
}

private func statusTone(_ status: String) -> Color {
    switch status {
    case "suggested": return Theme.link
    case "new": return Theme.warning
    case "placed": return Theme.success
    case "error": return Theme.failure
    default: return Theme.secondary
    }
}

private func agentLabel(_ agent: String) -> String { agent == "antigravity" ? "agy" : agent }

private struct InsightRow: Identifiable {
    let id: String
    let text: String
    var status: String
    let island: String
    let provider: String?
    let source: String?
    let sourceUrl: URL?
    let interpretation: String?
    let evaluation: String?
    let tags: [String]
    let hasImage: Bool
    let error: String?
    let pageId: String?
    let pageName: String?
    var pageUrl: URL?
    let content: String?
    let contextBefore: String?
    let contextAfter: String?
    let reason: String?
    let createdAt: Double

    init?(_ r: [String: Any]) {
        guard let id = r["_id"] as? String, let status = r["status"] as? String else { return nil }
        self.id = id
        self.status = status
        text = (r["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        island = Self.clean(r["island"]) ?? "productivity"
        provider = Self.clean(r["provider"])
        source = Self.clean(r["source"])
        sourceUrl = Self.clean(r["sourceUrl"]).flatMap(URL.init(string:))
        interpretation = Self.clean(r["interpretation"])
        evaluation = Self.clean(r["evaluation"])
        tags = (r["tags"] as? [String]) ?? []
        hasImage = r["imageId"] is String
        error = Self.clean(r["error"])
        pageId = Self.clean(r["notionPageId"])
        pageName = Self.clean(r["notionPageName"])
        pageUrl = Self.clean(r["notionPageUrl"]).flatMap(URL.init(string:))
        content = Self.clean(r["notionContent"])
        contextBefore = Self.clean(r["notionContextBefore"])
        contextAfter = Self.clean(r["notionContextAfter"])
        reason = Self.clean(r["notionReason"])
        createdAt = (r["createdAt"] as? Double) ?? 0
    }

    private static func clean(_ value: Any?) -> String? {
        guard let s = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return s
    }

    var place: [String: Any]? {
        guard pageId != nil, let content else { return nil }
        var p: [String: Any] = ["pageName": pageName ?? UIText.t("출력 페이지", "Output page"), "content": content, "status": "pending"]
        if let contextBefore { p["contextBefore"] = contextBefore }
        if let contextAfter { p["contextAfter"] = contextAfter }
        return p
    }

    var meta: String {
        let home = Island.label(island)
        let when = createdAt > 0 ? UIText.relativeTime(createdAt) : nil
        return [home, provider.map(agentLabel), when].compactMap { $0 }.joined(separator: " · ")
    }
}

@MainActor
private final class InsightsModel: ObservableObject {
    @Published var rows: [InsightRow] = []
    @Published var filter: String?
    @Published var agents: [String] = []
    @Published var counts: [String: Int] = [:]
    @Published var agentCounts: [String: Int] = [:]
    @Published var total: Int?
    @Published var opened: Set<String> = []
    @Published var busy: Set<String> = []
    @Published var images: [String: URL] = [:]
    @Published var failedImages: Set<String> = []
    @Published var notice: String?
    @Published var error: String?
    @Published var loaded = false
    @Published var loading = false
    @Published private(set) var cursor: String?
    @Published private(set) var done = true
    private var generation = 0
    private let pageSize = 25
    private var personal: [[String: Any]] = []

    private var agentArgs: [String: Any] { agents.isEmpty ? [:] : ["providers": agents] }

    var agentNames: [String] {
        let rank = { (a: String) in AGENT_ORDER.firstIndex(of: a) ?? AGENT_ORDER.count }
        return Set(agentCounts.keys).union(agents).sorted { a, b in
            if rank(a) != rank(b) { return rank(a) < rank(b) }
            let na = agentCounts[a] ?? 0, nb = agentCounts[b] ?? 0
            return na != nb ? na > nb : a < b
        }
    }

    func load() async {
        generation += 1
        let mine = generation
        loading = true
        total = nil
        defer { if mine == generation { loading = false } }
        do {
            let first = try await page(after: nil)
            let tally: [String: Any]? = personalCounts
            guard mine == generation else { return }
            rows = first.rows
            cursor = first.cursor
            done = first.done
            if let tally { setCounts(tally) }
            error = nil
        } catch is CancellationError {
            return
        } catch let failure as URLError where failure.code == .cancelled {
            return
        } catch {
            if mine == generation { self.error = error.localizedDescription }
        }
        loaded = true
    }

    func loadMore() async {
        guard !loading, !done, let cursor else { return }
        let mine = generation
        loading = true
        defer { if mine == generation { loading = false } }
        do {
            let next = try await page(after: cursor)
            guard mine == generation else { return }
            let seen = Set(rows.map(\.id))
            rows += next.rows.filter { !seen.contains($0.id) }
            self.cursor = next.cursor
            done = next.done
        } catch is CancellationError {
        } catch let failure as URLError where failure.code == .cancelled {
        } catch {
            if mine == generation {
                self.error = error.localizedDescription
                done = true
            }
        }
    }

    private var personalCounts: [String: Any] {
        let selected = personal.filter { agents.isEmpty || agents.contains($0["provider"] as? String ?? "") }
        var counts: [String: Int] = [:]
        var providers: [String: Int] = [:]
        for row in selected { counts[row["status"] as? String ?? "new", default: 0] += 1 }
        for row in personal {
            if let provider = row["provider"] as? String { providers[provider, default: 0] += 1 }
        }
        return ["counts": counts, "providers": providers, "total": selected.filter { $0["status"] as? String != "dismissed" }.count]
    }

    private func page(after cursor: String?) async throws -> (rows: [InsightRow], cursor: String?, done: Bool) {
        if cursor == nil {
            guard let all = try await ConvexHTTP.query("insights:list") as? [[String: Any]] else { throw ConvexError.shape }
            personal = all.filter { ["manual", "notion"].contains($0["origin"] as? String ?? "") }
        }
        let filtered = personal.filter { row in
            let status = row["status"] as? String ?? "new"
            return (filter.map { status == $0 } ?? (status != "dismissed"))
                && (agents.isEmpty || agents.contains(row["provider"] as? String ?? ""))
        }.sorted { a, b in
            let ra = INSIGHT_STATUSES.firstIndex(of: a["status"] as? String ?? "") ?? 9
            let rb = INSIGHT_STATUSES.firstIndex(of: b["status"] as? String ?? "") ?? 9
            return ra == rb ? (a["createdAt"] as? Double ?? 0) > (b["createdAt"] as? Double ?? 0) : ra < rb
        }
        let start = min(Int(cursor ?? "0") ?? 0, filtered.count)
        let end = min(start + pageSize, filtered.count)
        return (filtered[start..<end].compactMap(InsightRow.init), String(end), end == filtered.count)
    }

    private func setCounts(_ tally: [String: Any]) {
        counts = Self.ints(tally["counts"])
        agentCounts = Self.ints(tally["providers"])
        total = (tally["total"] as? NSNumber)?.intValue
    }

    private static func ints(_ value: Any?) -> [String: Int] {
        (value as? [String: Any] ?? [:]).compactMapValues { ($0 as? NSNumber)?.intValue }
    }

    private func recount() async {
        do {
            guard let all = try await ConvexHTTP.query("insights:list") as? [[String: Any]] else { throw ConvexError.shape }
            personal = all.filter { ["manual", "notion"].contains($0["origin"] as? String ?? "") }
            setCounts(personalCounts)
        } catch { self.error = error.localizedDescription }
    }

    private func restart() async {
        rows = []
        cursor = nil
        done = true
        await load()
    }

    func pick(_ status: String?) async {
        guard status != filter else { return }
        filter = status
        await restart()
    }

    func toggle(agent: String) async {
        if let i = agents.firstIndex(of: agent) { agents.remove(at: i) } else { agents.append(agent) }
        await restart()
    }

    func clearAgents() async {
        agents = []
        await restart()
    }

    func toggleOpen(_ id: String) {
        if opened.contains(id) { opened.remove(id) } else { opened.insert(id) }
    }

    func loadImage(_ row: InsightRow) async {
        guard row.hasImage, images[row.id] == nil else { return }
        do {
            guard let link = try await ConvexHTTP.query("insights:imageUrl", args: ["id": row.id]) as? String,
                  let url = URL(string: link) else { throw ConvexError.shape }
            images[row.id] = url
            failedImages.remove(row.id)
        } catch {
            failedImages.insert(row.id)
            self.error = error.localizedDescription
        }
    }

    private func settle(_ id: String, _ status: String, landed: URL? = nil) {
        if filter.map({ $0 != status }) ?? (status == "dismissed") {
            rows.removeAll { $0.id == id }
            opened.remove(id)
        } else if let i = rows.firstIndex(where: { $0.id == id }) {
            rows[i].status = status
            if let landed { rows[i].pageUrl = landed }
        }
    }

    func setStatus(_ row: InsightRow, _ status: String) async {
        busy.insert(row.id)
        defer { busy.remove(row.id) }
        do {
            try await ConvexHTTP.mutation("insights:setStatus", args: ["id": row.id, "status": status])
            settle(row.id, status)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        await recount()
    }

    func place(_ row: InsightRow) async -> URL? {
        busy.insert(row.id)
        defer { busy.remove(row.id) }
        do {
            let url = try await ConvexHTTP.placeInsight(id: row.id) ?? row.pageUrl
            settle(row.id, "placed", landed: url)
            notice = UIText.t("출력에 넣었어요", "Placed in output")
            error = nil
            await recount()
            return url
        } catch {
            self.error = UIText.t("넣지 못했어요: ", "Place failed: ") + error.localizedDescription
            return nil
        }
    }

    func remove(_ row: InsightRow) async {
        busy.insert(row.id)
        defer { busy.remove(row.id) }
        do {
            try await ConvexHTTP.mutation("insights:remove", args: ["id": row.id])
            rows.removeAll { $0.id == row.id }
            opened.remove(row.id)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        await recount()
    }
}

struct InsightsView: View {
    @Environment(\.appearanceTokens) private var theme
    @StateObject private var model = InsightsModel()
    @State private var composing = false

    init() {}

    var body: some View {
        TabNavigationStack {
            List {
                LiquidRefreshHeader()
                filters.glassRowLayout()
                if let error = model.error {
                    LoadFailure(message: error)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .glassRow().glassRowLayout()
                }
                if let notice = model.notice {
                    Text(notice).themeText(.meta).foregroundStyle(Theme.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .glassRow().glassRowLayout()
                }
                Section {
                    if !model.loaded || (model.loading && model.rows.isEmpty) {
                        ForEach(0..<5, id: \.self) { _ in
                            ContentRowSkeleton(badge: model.filter != nil && model.filter != "suggested", chevron: true,
                                               spacerUnits: nil, chevronTopUnits: 1)
                                .glassRow().glassRowLayout()
                                .loadingAccessibility("insights.loading", label: UIText.t("인사이트 불러오는 중", "Loading insights"))
                        }
                    }
                    ForEach(model.rows) { row in
                        InsightCard(row: row, model: model)
                            .glassRowLayout()
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button(role: .destructive) {
                                    Task { await model.remove(row) }
                                } label: {
                                    Label(UIText.t("삭제", "Delete"), systemImage: "trash")
                                }
                            }
                    }
                    if model.loaded && !model.done && model.cursor != nil {
                        ContentRowSkeleton(badge: model.filter != nil && model.filter != "suggested", chevron: true,
                                           spacerUnits: nil, chevronTopUnits: 1)
                            .glassRow().glassRowLayout()
                            .task(id: model.cursor) { await model.loadMore() }
                    }
                    if model.loaded && model.rows.isEmpty && !model.loading && model.error == nil {
                        Text(emptyText).themeText(.title).foregroundStyle(Theme.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .glassRow().glassRowLayout()
                    }
                } header: {
                    countHeader
                }
            }
            .liquidList()
            .navigationTitle(UIText.t("인사이트", "Insights"))
            .accessibilityIdentifier("insights.scroll")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { composing = true } label: { ListIcon(systemName: "plus") }
                        .accessibilityLabel(UIText.t("인사이트 추가", "Add insight"))
                        .accessibilityIdentifier("insights.add")
                }
            }
            .sheet(isPresented: $composing) {
                InsightComposer { message in
                    model.notice = message
                    Task { await model.load() }
                }
            }
            .liquidRefreshable { await model.load() }
            .task { if !model.loaded { await model.load() } }
        }
    }

    @ViewBuilder
    private var countHeader: some View {
        let label = model.filter.map(statusLabel) ?? UIText.t("활성", "Active")
        if let total = model.total {
            let n = model.filter.map { model.counts[$0] ?? 0 } ?? total
            header("\(label) · \(n)").accessibilityIdentifier("insights.total")
        } else if model.error != nil {
            header(UIText.t("개수를 불러오지 못했어요", "Count failed to load"))
        } else {
            HStack(spacing: theme.space(1)) {
                header("\(label) ·")
                SkeletonText(role: .meta, design: .monospaced)
                    .frame(width: theme.space(5))
                    .loadingAccessibility("insights.total.loading", label: UIText.t("개수 불러오는 중", "Loading count"))
            }
        }
    }

    private var emptyText: String {
        model.filter == nil && model.agents.isEmpty
            ? UIText.t("활성 인사이트가 없어요. +로 인용이나 스크린샷을 더해요.", "No active insights. Add a quote or a screenshot with +.")
            : UIText.t("이 필터에 맞는 인사이트가 없어요.", "No insights match this filter.")
    }

    private func header(_ text: String) -> some View {
        Text(text).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary).textCase(nil)
    }

    private var filters: some View {
        VStack(alignment: .leading, spacing: theme.space(0.5)) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: theme.space(1.5)) {
                    chip(UIText.t("활성", "Active"), count: model.total, active: model.filter == nil) {
                        Task { await model.pick(nil) }
                    }
                    ForEach(INSIGHT_STATUSES, id: \.self) { s in
                        if s == "dismissed" || (model.counts[s] ?? 0) > 0 || model.filter == s {
                            chip(statusLabel(s), count: model.total == nil ? nil : model.counts[s] ?? 0,
                                 active: model.filter == s, dot: statusTone(s)) {
                                Task { await model.pick(s) }
                            }
                        }
                    }
                }
                .padding(.vertical, theme.space(1))
            }
            if !model.agentNames.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: theme.space(1.5)) {
                        ForEach(model.agentNames, id: \.self) { a in
                            chip(agentLabel(a), count: model.total == nil ? nil : model.agentCounts[a] ?? 0,
                                 active: model.agents.contains(a)) {
                                Task { await model.toggle(agent: a) }
                            }
                        }
                        if !model.agents.isEmpty {
                            Button {
                                Task { await model.clearAgents() }
                            } label: {
                                ListIcon(systemName: "xmark.circle.fill").foregroundStyle(Theme.secondary)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(UIText.t("agent 필터 지우기", "Clear the agent filter"))
                        }
                    }
                    .padding(.vertical, theme.space(1))
                }
            }
        }
    }

    private func chip(_ label: String, count: Int?, active: Bool, dot: Color? = nil,
                      action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: theme.space(1.25)) {
                if let dot { Circle().fill(dot).frame(width: 6, height: 6) }
                Text(label).themeText(.badge)
                if let count {
                    Text("\(count)").themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary)
                } else {
                    SkeletonText(role: .meta, design: .monospaced).frame(width: theme.space(3))
                }
            }
            .padding(.horizontal, theme.space(2.75))
            .padding(.vertical, theme.space(1.5))
            .background(active ? Theme.accent.opacity(0.14) : Color.clear, in: RoundedRectangle(cornerRadius: theme.value("radiusPill")))
            .foregroundStyle(active ? Theme.accent : Color.primary)
        }
        .buttonStyle(.plain)
    }
}

private struct InsightStatusPill: View {
    @Environment(\.appearanceTokens) private var theme
    let status: String

    var body: some View {
        Text(statusLabel(status))
            .themeText(.badge, design: .monospaced)
            .padding(.horizontal, theme.value("badgePaddingX"))
            .padding(.vertical, theme.value("badgePaddingY"))
            .background(statusTone(status).opacity(0.14), in: RoundedRectangle(cornerRadius: theme.value("radiusPill")))
            .foregroundStyle(statusTone(status))
    }
}

private struct InsightCard: View {
    @Environment(\.appearanceTokens) private var theme
    let row: InsightRow
    @ObservedObject var model: InsightsModel

    private var open: Bool { model.opened.contains(row.id) }
    private var busy: Bool { model.busy.contains(row.id) }

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space(2.5)) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { model.toggleOpen(row.id) }
            } label: {
                headline
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("insights.row.\(row.id)")
            if open { details }
        }
        .glassRow()
        .task(id: open) { if open { await model.loadImage(row) } }
    }

    private var headline: some View {
        HStack(alignment: .firstTextBaseline, spacing: theme.value("rowGap")) {
            IslandMark(key: row.island)
            VStack(alignment: .leading, spacing: theme.value("rowTextGap")) {
                Text(row.text.isEmpty ? UIText.t("[이미지] 추출 대기 중…", "[image] awaiting extraction…") : row.text)
                    .themeText(.title)
                    .foregroundStyle(row.text.isEmpty ? Theme.secondary : Color.primary)
                    .lineLimit(open ? nil : 2)
                    .multilineTextAlignment(.leading)
                Text(row.meta).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if row.status != "suggested" { InsightStatusPill(status: row.status) }
            ListIcon(systemName: "chevron.right")
                .foregroundStyle(Theme.secondary)
                .rotationEffect(.degrees(open ? 90 : 0))
                .padding(.top, theme.space(1))
        }
        .contentShape(Rectangle())
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: theme.space(2)) {
            if row.hasImage {
                HeldImage(url: model.images[row.id], height: 200, failed: model.failedImages.contains(row.id))
            }
            if let source = row.source {
                if let link = row.sourceUrl {
                    Link("— " + source, destination: link)
                        .themeText(.meta, design: .monospaced)
                        .foregroundStyle(Theme.link)
                } else {
                    Text("— " + source).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary)
                }
            }
            if let interpretation = row.interpretation {
                RichText(source: interpretation, style: .meta)
            }
            if let evaluation = row.evaluation {
                RichText(source: evaluation, style: .meta).foregroundStyle(Theme.secondary)
            }
            if !row.tags.isEmpty {
                FlowLayout(spacing: theme.space(1)) {
                    ForEach(row.tags, id: \.self) { tag in
                        Text(tag)
                            .themeText(.meta, design: .monospaced)
                            .padding(.horizontal, theme.space(1.5))
                            .padding(.vertical, theme.space(0.5))
                            .background(Theme.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: theme.value("radiusPill")))
                            .foregroundStyle(Theme.secondary)
                    }
                }
            }
            verdict
            Button(role: .destructive) {
                Task { await model.remove(row) }
            } label: {
                Text(UIText.t("삭제", "Delete")).themeText(.meta, design: .monospaced)
            }
            .buttonStyle(.borderless)
            .disabled(busy)
        }
        .padding(.leading, theme.space(4.5))
    }

    private var placedLabel: String {
        UIText.t("넣음", "Placed") + (row.pageName.map { " → \($0)" } ?? "")
    }

    @ViewBuilder
    private var verdict: some View {
        switch row.status {
        case "error":
            HStack(alignment: .firstTextBaseline, spacing: theme.space(2)) {
                Text(row.error ?? UIText.t("오류", "Error"))
                    .themeText(.meta, design: .monospaced)
                    .foregroundStyle(Theme.failure)
                Spacer(minLength: theme.space(1))
                Button(UIText.t("다시 시도", "Retry")) {
                    Task { await model.setStatus(row, "new") }
                }
                .buttonStyle(ThemeActionStyle())
                .controlSize(.small)
                .disabled(busy)
            }
        case "suggested":
            if let place = row.place {
                SuggestionDiff(suggestion: place, busy: busy) {
                    Task { openNotionPage(await model.place(row)) }
                } onReject: {
                    Task { await model.setStatus(row, "dismissed") }
                }
                if let page = row.pageUrl {
                    Button {
                        openNotionPage(page)
                    } label: {
                        HStack(spacing: theme.space(1)) {
                            Image("connector-notion").resizable().scaledToFit().frame(width: theme.value("iconSymbolSize") * theme.scale, height: theme.value("iconSymbolSize") * theme.scale)
                                .accessibilityLabel("Notion")
                            Text(UIText.t("출력 페이지 열기", "Open output page")).underline()
                        }
                        .themeText(.meta)
                        .foregroundStyle(Theme.link)
                    }
                    .buttonStyle(.borderless)
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: theme.space(2)) {
                    Text(UIText.t("맞는 출력 페이지가 없어요", "No fitting output page") + (row.reason.map { ": \($0)" } ?? ""))
                        .themeText(.meta)
                        .foregroundStyle(Theme.secondary)
                    Spacer(minLength: theme.space(1))
                    Button(UIText.t("닫기", "Dismiss")) {
                        Task { await model.setStatus(row, "dismissed") }
                    }
                    .buttonStyle(ThemeActionStyle())
                    .tint(Theme.failure)
                    .controlSize(.small)
                    .disabled(busy)
                }
            }
        case "placed":
            if let page = row.pageUrl {
                Button {
                    openNotionPage(page)
                } label: {
                    Label(placedLabel, systemImage: "checkmark")
                        .themeText(.meta, design: .monospaced)
                        .foregroundStyle(Theme.success)
                }
                .buttonStyle(.borderless)
            } else {
                Label(placedLabel, systemImage: "checkmark")
                    .themeText(.meta, design: .monospaced)
                    .foregroundStyle(Theme.success)
            }
        default:
            EmptyView()
        }
    }


}

private struct InsightComposer: View {
    @Environment(\.appearanceTokens) private var theme
    let onAdded: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var picks: [PhotosPickerItem] = []
    @State private var shots: [UIImage] = []
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool

    private var empty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && shots.isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $text).accessibilityIdentifier("insights.composer.text")
                        .frame(minHeight: 140)
                        .focused($focused)
                } header: {
                    Text(UIText.t("인용 / 인사이트", "Quote / insight"))
                } footer: {
                    Text(UIText.t("빈 줄로 나누면 여러 개가 돼요.", "A blank line separates multiple."))
                }
                Section {
                    if !shots.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: theme.space(2.5)) {
                                ForEach(shots.indices, id: \.self) { i in thumb(i) }
                            }
                            .padding(.vertical, theme.space(1))
                        }
                    }
                    PhotosPicker(selection: $picks, matching: .images) {
                        Label(UIText.t("스크린샷 추가", "Add screenshots"), systemImage: "photo.on.rectangle")
                    }
                } footer: {
                    Text(UIText.t("스크린샷 한 장이 인사이트 하나가 돼요.", "Each screenshot becomes one insight."))
                }
                if let error {
                    Section { LoadFailure(message: error) }
                }
            }
            .navigationTitle(UIText.t("인사이트 추가", "Add insight"))
            .liquidSurface().inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(UIText.t("취소", "Cancel")) { dismiss() }.accessibilityIdentifier("insights.composer.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button(UIText.t("추가", "Add")) { Task { await submit() } }
                            .disabled(empty)
                    }
                }
            }
            .interactiveDismissDisabled(busy)
            .onChange(of: picks) { _, items in
                guard !items.isEmpty else { return }
                Task { await attach(items) }
            }
            .task { focused = true }
        }
    }

    private func thumb(_ i: Int) -> some View {
        Image(uiImage: shots[i])
            .resizable()
            .scaledToFill()
            .frame(width: 64, height: 64)
            .clipShape(RoundedRectangle(cornerRadius: theme.value("radiusControl"), style: .continuous))
            .overlay(alignment: .topTrailing) {
                Button {
                    if shots.indices.contains(i) { shots.remove(at: i) }
                } label: {
                    ListIcon(systemName: "xmark.circle.fill").foregroundStyle(Color.white, Color.black.opacity(0.6))
                }
                .buttonStyle(.borderless)
                .padding(theme.space(0.5))
                .accessibilityLabel(UIText.t("빼기", "Remove"))
            }
    }

    private func attach(_ items: [PhotosPickerItem]) async {
        picks = []
        for item in items {
            if let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) {
                shots.append(image)
            }
        }
    }

    private func submit() async {
        busy = true
        defer { busy = false }
        var texts = 0
        var uploaded = 0
        do {
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                let value = try await ConvexHTTP.mutation("insights:add", args: ["raw": text]) as? [String: Any]
                texts = (value?["added"] as? NSNumber)?.intValue ?? 0
                text = ""
            }
            while let shot = shots.first {
                try await upload(shot)
                shots.removeFirst()
                uploaded += 1
            }
            onAdded(summary(texts + uploaded, uploaded))
            dismiss()
        } catch {
            self.error = UIText.t("추가하지 못했어요: ", "Add failed: ") + error.localizedDescription
            if texts + uploaded > 0 { onAdded(summary(texts + uploaded, uploaded)) }
        }
    }

    private func summary(_ added: Int, _ pictures: Int) -> String {
        pictures > 0
            ? UIText.t("\(added)개 추가했어요 (\(pictures)개는 추출 대기)", "Added \(added) (\(pictures) awaiting extraction)")
            : UIText.t("\(added)개 추가했어요", "Added \(added)")
    }

    private func upload(_ image: UIImage) async throws {
        guard let jpeg = image.jpegData(compressionQuality: 0.9),
              let link = try await ConvexHTTP.mutation("insights:generateUploadUrl") as? String,
              let url = URL(string: link) else { throw ConvexError.shape }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        let (data, _) = try await URLSession.shared.upload(for: request, from: jpeg)
        guard let stored = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["storageId"] as? String
        else { throw ConvexError.shape }
        try await ConvexHTTP.mutation("insights:addImage", args: ["imageId": stored])
    }
}
