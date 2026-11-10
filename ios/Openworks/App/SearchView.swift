import SwiftUI

struct SearchView: View {
    @Environment(\.appearanceTokens) private var theme
    @State private var query = ""
    @State private var rows: [[String: Any]] = []
    @State private var loading = false
    @State private var searched = false
    @State private var error: String?
    @State private var opened: String?

    var body: some View {
        TabNavigationStack {
            List {
                LiquidRefreshHeader()
                if loading {
                    ForEach((0..<5).map { "skeleton-\($0)" }, id: \.self) { _ in ContentRowSkeleton(chevron: true).glassRow().glassRowLayout() }
                        .loadingAccessibility("search.loading", label: UIText.t("검색 중", "Searching"))
                } else if let error {
                    LoadFailure(message: error) { Task { await search() } }.glassRow().glassRowLayout()
                } else if rows.isEmpty {
                    Text(searched ? UIText.t("검색 결과가 없어요.", "No results.") : UIText.t("뉴스레터, 논문, 아티클을 검색하세요.", "Search newsletters, papers and articles."))
                        .themeText(.body).glassRow().glassRowLayout()
                }
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    Button { opened = row["_id"] as? String } label: {
                        HStack(alignment: .firstTextBaseline, spacing: theme.value("rowGap")) {
                            JobSourceMark(source: row)
                            VStack(alignment: .leading, spacing: theme.value("rowTextGap")) {
                                Text(jobHeadline(row)).themeText(.title).lineLimit(2)
                                Text(UIText.tab(row["type"] as? String ?? "article")).themeText(.meta).foregroundStyle(Theme.secondary).lineLimit(1)
                            }
                            Spacer()
                            ListIcon(systemName: "chevron.right")
                        }.glassRow()
                    }.buttonStyle(.plain).glassRowLayout()
                    .accessibilityIdentifier("search.result.\(row["_id"] as? String ?? "")")
                }
            }
            .liquidList().inlineNavigationTitle()
            .navigationTitle(UIText.t("검색", "Search"))
            .accessibilityIdentifier("search.scroll")
            .searchable(text: $query, prompt: UIText.t("제목과 내용", "Titles and content"))
            .task(id: query) {
                guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { rows = []; searched = false; loading = false; error = nil; return }
                do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
                await search()
            }
            .liquidRefreshable { await search() }
            .navigationDestination(item: $opened) { JobDetailView(jobId: $0) }
        }
    }

    private func search() async {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        loading = true
        defer { if query.trimmingCharacters(in: .whitespacesAndNewlines) == text { loading = false } }
        do {
            var found: [[String: Any]] = []
            for type in ["newsletter", "paper", "article"] {
                for archived in [false, true] {
                    found += try await ConvexHTTP.search(type: type, archived: archived, query: text)
                }
            }
            guard !Task.isCancelled, query.trimmingCharacters(in: .whitespacesAndNewlines) == text else { return }
            rows = found
            searched = true
            error = nil
        } catch {
            guard !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }
}
