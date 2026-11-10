import SwiftUI

@MainActor
final class JobDetailModel: ObservableObject {
    @Published var job: [String: Any]?
    @Published var summaries: [[String: Any]] = []
    @Published var images: [String] = []
    @Published var suggestions: [[String: Any]] = []
    @Published var outputs: [String] = []
    @Published var loading = true
    @Published var error: String?
    @Published var busy = false

    func load(jobId: String) async {
        guard !jobId.isEmpty else { return }
        loading = true
        defer { loading = false }
        do {
            async let job = ConvexHTTP.job(id: jobId)
            async let summaries = ConvexHTTP.summaries(jobId: jobId)
            async let images = ConvexHTTP.imageUrls(jobId: jobId)
            async let suggestions = ConvexHTTP.suggestions(jobId: jobId)
            self.job = try await job
            self.summaries = try await summaries
            self.images = try await images
            self.suggestions = try await suggestions
            self.outputs = self.suggestions.isEmpty ? [] : ["notion"]
            error = nil
        } catch { self.error = error.localizedDescription }

    }

    @Published var suggestionError: String?

    func approve(id: String, jobId: String) async {
        let page = (suggestions.first { $0["_id"] as? String == id }?["pageUrl"] as? String).flatMap(URL.init(string:))
        await decide(jobId: jobId, ids: [id], status: "executed") {
            let result = try await ConvexHTTP.approveSuggestion(id: id)
            openNotionPage(result ?? page)
        }
    }

    func approveAll(jobId: String) async {
        await decide(jobId: jobId, ids: pendingIds, status: "approved") {
            try await ConvexHTTP.approveAllSuggestions(jobId: jobId)
        }
        if suggestionError == nil, suggestions.contains(where: { $0["status"] as? String == "approved" }) {
            suggestionError = UIText.t("일부 제안을 적용하지 못했어요. 다시 시도하세요.", "Some suggestions could not be applied. Try again.")
        }
    }

    func reject(id: String, jobId: String) async {
        await decide(jobId: jobId, ids: [id], status: "rejected") {
            try await ConvexHTTP.rejectSuggestion(id: id)
        }
    }

    func rejectAll(jobId: String) async {
        await decide(jobId: jobId, ids: pendingIds, status: "rejected") {
            try await ConvexHTTP.rejectAllSuggestions(jobId: jobId)
        }
    }

    private var pendingIds: Set<String> {
        Set(suggestions.filter { ($0["status"] as? String ?? "pending") == "pending" }.compactMap { $0["_id"] as? String })
    }

    private func decide(jobId: String, ids: Set<String>, status: String, action: () async throws -> Void) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            try await action()
            for i in suggestions.indices where ids.contains(suggestions[i]["_id"] as? String ?? "") {
                suggestions[i]["status"] = status
            }
            suggestions = try await ConvexHTTP.suggestions(jobId: jobId)
            suggestionError = nil
        } catch { suggestionError = error.localizedDescription }
    }

    var pendingCount: Int {
        suggestions.filter { ($0["status"] as? String ?? "pending") == "pending" }.count
    }
}

struct JobDetailView: View {
    @Environment(\.appearanceTokens) private var theme
    let jobId: String
    @StateObject private var model = JobDetailModel()
    @EnvironmentObject private var shell: Shell
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            LiquidRefreshHeader()
            if let error = model.error {
                LoadFailure(message: error) { Task { await model.load(jobId: jobId) } }.glassRow().glassRowLayout()
            } else if !model.loading && model.job == nil {
                Text(UIText.t("항목을 찾을 수 없어요.", "Item not found.")).glassRow().glassRowLayout()
            }
            if model.pendingCount > 0 {
                suggestionSection
                sourceSection
                summarySection
            } else {
                sourceSection
                summarySection
                suggestionSection
            }
        }
        .liquidList()
        .accessibilityIdentifier("job.detail.scroll")
        .liquidRefreshable { await model.load(jobId: jobId) }
        .navigationTitle(UIText.t("요약", "Summary"))
        .inlineNavigationTitle()
        .task(id: jobId) {
            await model.load(jobId: jobId)
        }
    }

    private var sourceSection: some View {
        Section {
            if let job = model.job { header(job) }
            else if model.loading {
                VStack(alignment: .leading, spacing: theme.space(1.5)) {
                    SkeletonText(lines: 2, width: 0.8)
                    SkeletonText(role: .badge, width: 0.3)
                    SkeletonText(role: .meta, lines: 2, width: 0.6)
                }.glassRow().glassRowLayout()
            }
            let storedImages = (model.job?["imageIds"] as? [String])?.count ?? (model.job?["imageId"] is String ? 1 : 0)
            ForEach(0..<max(storedImages, model.images.count), id: \.self) { index in
                let url = model.images.indices.contains(index) ? URL(string: model.images[index]) : nil
                HeldImage(url: url, height: 420, failed: !model.loading && url == nil)
                    .glassRow()
                    .glassRowLayout()
            }
        } header: { sectionHeader(UIText.t("원본", "Source")) }
    }

    private var summarySection: some View {
        Section {
            if model.summaries.isEmpty && model.error == nil {
                if model.loading {
                    VStack(alignment: .leading, spacing: theme.space(2)) {
                        SkeletonText(width: 0.8)
                        SkeletonText(role: .meta, width: 0.4)
                        SkeletonText(role: .body, lines: 3, width: 0.9)
                        SkeletonText(role: .body, lines: 4, width: 0.7)
                    }.glassRow().glassRowLayout()
                } else {
                    emptyNote(UIText.t("아직 요약이 없어요.", "No summary yet."))
                }
            } else {
                ForEach(model.summaries.indices, id: \.self) { i in
                    summaryCard(model.summaries[i], index: i)
                        .glassRow()
                        .glassRowLayout()
                }
            }
        } header: { sectionHeader(UIText.t("요약", "Summary")) }
    }

    private var suggestionEmpty: String {
        let push = model.job?["notionPush"] as? String
        if model.job?["type"] as? String == "pr-fix" { return UIText.t("PR 작업에는 제안이 없어요.", "No suggestions for PR jobs.") }
        if push == "failed" { return UIText.t("제안을 만드는 중 오류가 발생했어요.", "Suggestion run failed.") }
        return push == "none" ? UIText.t("이 항목에 맞는 페이지가 없어요.", "No page fits this one.") : UIText.t("아직 제안이 없어요.", "No suggestions yet.")
    }

    private var suggestionSection: some View {
        Section {
            if model.job?["notionPush"] as? String == "failed" {
                if let note = model.job?["notionPushNote"] as? String {
                    Text(note).themeText(.meta).foregroundStyle(Theme.failure).glassRow().glassRowLayout()
                }
            }
            if let error = model.suggestionError {
                LoadFailure(message: error).glassRow().glassRowLayout()
            }
            if model.suggestions.isEmpty && model.error == nil {
                if model.loading {
                    VStack(alignment: .leading, spacing: theme.space(1.5)) {
                        OutputMark(type: "notion")
                        SuggestionDiff(suggestion: SuggestionDiff.placeholder, busy: false, onApply: {}, onReject: {})
                    }.loadingPlaceholder().glassRow().glassRowLayout()
                } else {
                    emptyNote(suggestionEmpty)
                }
            } else {
                ForEach(model.suggestions.indices, id: \.self) { i in
                    suggestionCard(model.suggestions[i])
                        .glassRow()
                        .glassRowLayout()
                }
            }
        } header: {
            VStack(alignment: .leading, spacing: theme.space(1.5)) {
                FlowLayout(spacing: theme.space(1.5)) {
                    sectionHeader(UIText.t("제안", "Suggestion"))
                    ForEach(model.outputs, id: \.self) { OutputMark(type: $0) }
                }
                if model.pendingCount > 0 {
                    FlowLayout(spacing: theme.space(2)) {
                        Button(UIText.t("모두 승인", "Approve all")) { Task { await model.approveAll(jobId: jobId) } }
                        Button(UIText.t("모두 거절", "Reject all")) { Task { await model.rejectAll(jobId: jobId) } }
                            .foregroundStyle(Theme.secondary)
                    }
                    .themeText(.meta)
                    .buttonStyle(.plain)
                }
            }
            .textCase(nil)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func sectionHeader(_ text: String) -> some View {
        Text(text).themeText(.meta).foregroundStyle(Theme.secondary).textCase(nil)
    }

    private func emptyNote(_ text: String) -> some View {
        Text(text)
            .themeText(.meta)
            .foregroundStyle(Theme.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassRow()
            .glassRowLayout()
    }

    private func header(_ job: [String: Any]) -> some View {
        VStack(alignment: .leading, spacing: theme.space(1.5)) {
            Text(jobHeadline(job)).themeText(.title)
            HStack(spacing: theme.space(2)) {
                StatusBadge(status: (job["status"] as? String) ?? "")
                if let provider = job["provider"] as? String, !provider.isEmpty {
                    Text(provider).themeText(.meta).foregroundStyle(Theme.secondary)
                }
            }
            if let link = jobLink(job) {
                LinkRow(url: link)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassRow()
        .glassRowLayout()
    }

    private func summaryCard(_ s: [String: Any], index: Int) -> some View {
        VStack(alignment: .leading, spacing: theme.space(2)) {
            Text((s["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? UIText.t("항목 \(index + 1)", "Item \(index + 1)"))
                .themeText(.title)
            if let category = s["category"] as? String, !category.isEmpty {
                Text(category).themeText(.meta).foregroundStyle(Theme.accent)
            }

            if let scores = s["scores"] as? [String: Any] {
                ScoreGrid(scores: scores, extra: s["researchLevel"] as? String)
            } else if let scores = s["articleScores"] as? [String: Any] {
                ScoreGrid(scores: scores, extra: scores["verdict"] as? String)
            }

            if let tldr = s["tldr"] as? [String], !tldr.isEmpty {
                VStack(alignment: .leading, spacing: theme.space(0.75)) {
                    ForEach(tldr.indices, id: \.self) { i in
                        HStack(alignment: .firstTextBaseline, spacing: theme.space(1.5)) {
                            Text("•").themeText(.body).foregroundStyle(Theme.accent)
                                .accessibilityHidden(true)
                            RichText(source: tldr[i])
                        }
                    }
                }
            }

            if let summary = s["summary"] as? String, !summary.isEmpty {
                RichText(source: summary)
            }

            if let keywords = s["keywords"] as? [String], !keywords.isEmpty {
                KeywordRow(keywords: keywords)
            }

            if let priorWork = s["priorWork"] as? [[String: Any]], !priorWork.isEmpty {
                VStack(alignment: .leading, spacing: theme.space(0.75)) {
                    Text(UIText.t("선행 연구", "Prior work")).themeText(.meta).foregroundStyle(Theme.secondary)
                    ForEach(priorWork.indices, id: \.self) { i in
                        Text("\((priorWork[i]["citation"] as? String) ?? "") — \((priorWork[i]["relation"] as? String) ?? "")")
                            .themeText(.meta)
                            .foregroundStyle(Theme.secondary)
                    }
                }
            }

            if let url = s["url"] as? String, !url.isEmpty, let link = URL(string: url) {
                LinkRow(url: link)
            }
        }
    }

    private func suggestionCard(_ s: [String: Any]) -> some View {
        let id = (s["_id"] as? String) ?? ""
        return VStack(alignment: .leading, spacing: theme.space(1.5)) {
            OutputMark(type: (s["output"] as? String) ?? "notion")
            SuggestionDiff(suggestion: s, busy: model.busy) {
                Task { await model.approve(id: id, jobId: jobId) }
            } onReject: {
                Task { await model.reject(id: id, jobId: jobId) }
            }
            if s["status"] as? String != "executed",
               let pageUrl = s["pageUrl"] as? String, let link = URL(string: pageUrl) {
                Link(destination: link) { Text(UIText.t("페이지 열기", "Open page")).underline() }
                    .themeText(.meta)
                    .foregroundStyle(Theme.link)
            }
        }
    }
}

struct OutputMark: View {
    @Environment(\.appearanceTokens) private var theme
    let type: String

    private var asset: (name: String, tint: Color?)? {
        switch type {
        case "notion": ("connector-notion", nil)
        case "obsidian": ("connector-obsidian", Color(hex: "#7C3AED"))
        case "gmail": ("connector-gmail", Color(hex: "#EA4335"))
        case "github": ("connector-github", nil)
        default: nil
        }
    }

    var body: some View {
        if let asset {
            Image(asset.name).resizable().scaledToFit().frame(width: theme.value("iconSymbolSize") * theme.scale, height: theme.value("iconSymbolSize") * theme.scale)
                .foregroundStyle(asset.tint ?? Theme.ink)
                .accessibilityLabel(type)
        } else {
            ListIcon(systemName: "link").foregroundStyle(Theme.secondary)
        }
    }
}

private struct KeywordRow: View {
    @Environment(\.appearanceTokens) private var theme
    let keywords: [String]
    var body: some View {
        FlowLayout(spacing: theme.space(1)) {
            ForEach(keywords.prefix(12), id: \.self) { word in
                Text(word)
                    .themeText(.meta)
                    .padding(.horizontal, theme.space(1.5))
                    .padding(.vertical, theme.space(0.5))
                    .background(Theme.accent.opacity(0.10), in: RoundedRectangle(cornerRadius: theme.value("radiusPill")))
                    .foregroundStyle(Theme.secondary)
            }
        }
    }
}

struct LinkRow: View {
    @Environment(\.appearanceTokens) private var theme
    let url: URL

    private var host: String {
        (url.host ?? url.absoluteString).replacingOccurrences(of: "www.", with: "")
    }

    private var trailing: String? {
        var rest = url.path
        if let query = url.query, !query.isEmpty { rest += "?" + query }
        return rest.isEmpty || rest == "/" ? nil : rest
    }

    var body: some View {
        Link(destination: url) {
            VStack(alignment: .leading, spacing: theme.space(0.25)) {
                Text(host).themeText(.meta).underline()
                if let trailing {
                    Text(trailing).themeText(.meta).lineLimit(2).truncationMode(.middle)
                }
            }
        }
        .foregroundStyle(Theme.link)
    }
}
