import SwiftUI

@MainActor
final class JobsModel: ObservableObject {
    @Published var jobs: [[String: Any]] = []
    @Published var loading = true
    @Published var archived = false
    @Published var total: Int?
    @Published var error: String?
    @Published var countError = false
    @Published var searchText = ""
    @Published var searching = false
    let type: String
    var band: ClosedRange<Double>?
    private let pageSize = 30
    private var reachedEnd = false
    private var offset = 0
    private var revealing = false
    private var generation = 0

    init(type: String) { self.type = type }

    func runSearch() async { await reload() }
    func clearSearch() async { searchText = ""; searching = false; await reload() }

    func reload(forReveal: Bool = false) async {
        guard !revealing || forReveal else { return }
        generation += 1
        let current = generation
        loading = true
        total = nil
        countError = false
        error = nil
        defer { if current == generation { loading = false } }
        async let tally: Void = refreshTotal()
        do {
            let text = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
            let isSearch = searching && !text.isEmpty
            let page: [[String: Any]]
            if isSearch { page = try await ConvexHTTP.search(type: type, archived: archived, query: text) }
            else {
                let result = try await fetchPage(from: 0)
                guard current == generation, !Task.isCancelled else { return }
                page = result.rows
                offset = result.offset
                reachedEnd = result.done
            }
            guard current == generation, !Task.isCancelled else { return }
            jobs = page
            if isSearch { reachedEnd = true }
        } catch {
            if current == generation, !Task.isCancelled { self.error = error.localizedDescription }
        }
        await tally
    }

    func loadMoreIfNeeded(currentIndex: Int, forReveal: Bool = false) async {
        guard (!revealing || forReveal), !searching, !reachedEnd, !loading, currentIndex >= jobs.count - 5 else { return }
        let current = generation
        loading = true
        defer { if current == generation { loading = false } }
        do {
            let result = try await fetchPage(from: offset)
            let page = result.rows
            guard current == generation, !Task.isCancelled else { return }
            let existing = Set(jobs.compactMap { $0["_id"] as? String })
            jobs += page.filter { !existing.contains($0["_id"] as? String ?? "") }
            reachedEnd = result.done
            offset = result.offset
        } catch { if current == generation, !Task.isCancelled { self.error = error.localizedDescription } }
    }

    private func fetchPage(from start: Int) async throws -> (rows: [[String: Any]], offset: Int, done: Bool) {
        let selectedBand = band
        let archived = self.archived
        var offset = start
        var rows: [[String: Any]] = []
        var done = false
        repeat {
            try Task.checkCancellation()
            let page = try await ConvexHTTP.listJobs(type: type, archived: archived, skip: offset, limit: pageSize)
            offset += page.count
            done = page.count < pageSize
            rows += page.filter { jobMatchesScoreBand($0, band: selectedBand) }
        } while rows.count < pageSize && !done
        return (rows, offset, done)
    }

    func reveal(_ target: Shell.ListTarget) async -> Bool {
        revealing = true
        defer { revealing = false }
        archived = target.archived
        band = nil
        searchText = ""
        searching = false
        await reload(forReveal: true)
        while !jobs.contains(where: { $0["_id"] as? String == target.id }), !reachedEnd, error == nil, !Task.isCancelled {
            let before = jobs.count
            await loadMoreIfNeeded(currentIndex: max(0, jobs.count - 1), forReveal: true)
            if jobs.count == before { break }
        }
        return jobs.contains { $0["_id"] as? String == target.id }
    }

    func toggleArchived() async { archived.toggle(); jobs = []; await reload() }

    private func refreshTotal() async {
        let current = generation
        do {
            guard let value = try await ConvexHTTP.query("jobs:count", args: ["type": type, "archived": archived]) as? NSNumber else { throw ConvexError.shape }
            if current == generation, !Task.isCancelled { total = value.intValue }
        } catch { if current == generation { countError = true } }
    }

    func archive(id: String) async { await update(id: id, path: "jobs:archive") }
    func unarchive(id: String) async { await update(id: id, path: "jobs:unarchive") }
    func promote(id: String, to type: String) async { await update(id: id, path: "jobs:updateType", extra: ["type": type]) }
    private func update(id: String, path: String, extra: [String: Any] = [:]) async {
        do {
            try await ConvexHTTP.mutation(path, args: extra.merging(["jobId": id]) { _, new in new })
            jobs.removeAll { $0["_id"] as? String == id }
            await refreshTotal()
        } catch { self.error = error.localizedDescription }
    }
}

private let promotableTypes = ["article", "paper", "newsletter"]

struct JobsTabView: View {
    @Environment(\.appearanceTokens) private var theme
    @StateObject private var model: JobsModel
    @State private var opened: String?
    @State private var revealedRequest: UUID?
    @State private var adding = false
    @State private var showingStats = false
    @State private var showingAuthors = false
    @FocusState private var searchFocused: Bool
    @EnvironmentObject private var shell: Shell
    let title: String

    init(type: String, title: String) {
        _model = StateObject(wrappedValue: JobsModel(type: type))
        self.title = title
    }

    @ViewBuilder
    private var filterBanner: some View {
        let band = shell.band(model.type)
        if band != nil {
            HStack(spacing: theme.space(2)) {
                if let band {
                    Text(UIText.t("점수 \(bandLabel(band))", "Score \(bandLabel(band))")).themeText(.meta)
                }
                Spacer()
                Button(UIText.t("해제", "Clear")) {
                    shell.clear(model.type)
                    Task { await model.reload() }
                }
                .themeText(.meta)
            }
            .padding(.horizontal, theme.space(4))
            .padding(.vertical, theme.space(1.75))
            .background(.ultraThinMaterial)
        }
    }

    var body: some View {
        TabNavigationStack {
            ScrollViewReader { proxy in
                List {
                    LiquidRefreshHeader()
                    if model.loading && model.jobs.isEmpty {
                        ForEach((0..<6).map { "skeleton-\($0)" }, id: \.self) { _ in
                            ContentRowSkeleton(badge: true, chevron: true).glassRow().glassRowLayout()
                                .loadingAccessibility("jobs.loading", label: UIText.t("목록 불러오는 중", "Loading list"))
                        }
                    }
                    if let error = model.error {
                        LoadFailure(message: error) { Task { await model.reload() } }.glassRow().glassRowLayout()
                    } else if !model.loading && model.jobs.isEmpty {
                        LoadEmpty(message: UIText.t("아직 항목이 없어요.", "No items yet.")).glassRow().glassRowLayout()
                    }
                    ForEach(model.jobs.indices, id: \.self) { i in
                        let job = model.jobs[i]
                        let id = job["_id"] as? String ?? ""
                        Button {
                            opened = id
                        } label: {
                            HStack(alignment: .firstTextBaseline, spacing: theme.value("rowGap")) {
                                JobSourceMark(source: job)
                                VStack(alignment: .leading, spacing: theme.value("rowTextGap")) {
                                    Text(jobHeadline(job)).themeText(.title)
                                        .lineLimit(2)
                                    if let subtitle = jobSubtitle(job) {
                                        Text(subtitle).themeText(.meta).foregroundStyle(Theme.secondary).lineLimit(1)
                                    }
                                }
                                Spacer(minLength: theme.space(2))
                                StatusBadge(status: (job["status"] as? String) ?? "")
                                ListIcon(systemName: "chevron.right")
                                    .foregroundStyle(Theme.secondary)
                            }
                            .glassRow()
                        }
                        .buttonStyle(.plain)
                        .glassRowLayout()
                        .id(id)
                        .accessibilityIdentifier("jobs.row.\(id)")
                        .task { await model.loadMoreIfNeeded(currentIndex: i) }
                        .swipeActions(edge: .trailing) {
                            if model.archived {
                                Button {
                                    Task { await model.unarchive(id: id) }
                                } label: { Label(UIText.t("보관 해제", "Unarchive"), systemImage: "tray.and.arrow.up") }
                                .tint(.indigo)
                            } else {
                                Button(role: .destructive) {
                                    Task { await model.archive(id: id) }
                                } label: { Label(UIText.t("보관", "Archive"), systemImage: "archivebox") }
                            }
                        }
                        .contextMenu {
                            ForEach(promotableTypes.filter { $0 != model.type }, id: \.self) { t in
                                Button {
                                    Task { await model.promote(id: id, to: t) }
                                } label: { Label(UIText.t("\(UIText.tab(t))(으)로 이동", "Move to \(t.capitalized)"), systemImage: "arrow.right.circle") }
                            }
                        }
                    }
                }
                .accessibilityIdentifier("jobs.scroll")
                .safeAreaInset(edge: .top) {
                    VStack(spacing: theme.space(0)) {
                        if model.searching {
                            HStack(alignment: .firstTextBaseline, spacing: theme.value("rowGap")) {
                                ListIcon(systemName: "magnifyingglass")
                                    .foregroundStyle(Theme.secondary)
                                TextField(UIText.t("\(title) 검색", "Search \(title.lowercased())"), text: $model.searchText)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                    .submitLabel(.search)
                                    .focused($searchFocused)
                                    .onSubmit { Task { await model.runSearch() } }
                                if !model.searchText.isEmpty {
                                    Button {
                                        model.searchText = ""
                                        Task { await model.reload() }
                                    } label: { ListIcon(systemName: "xmark.circle.fill") }
                                        .buttonStyle(.plain)
                                        .foregroundStyle(Theme.secondary)
                                }
                            }
                            .themeText(.body)
                            .padding(.horizontal, theme.space(4))
                            .padding(.vertical, theme.space(2))
                            .background(.ultraThinMaterial)
                        }
                        totalHeader
                        filterBanner
                    }
                }
                .onChange(of: model.searching) { _, on in searchFocused = on }
                .liquidList()
                .navigationDestination(item: $opened) { JobDetailView(jobId: $0) }
                .navigationTitle(model.archived ? UIText.t("\(title) · 보관함", "\(title) · Archive") : title)
                .inlineNavigationTitle()
                .toolbar {
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        Button {
                            adding = true
                        } label: { ListIcon(systemName: "plus") }
                        .accessibilityLabel(UIText.t("추가", "Add"))
                        .accessibilityIdentifier("jobs.add")
                        Menu {
                            Button {
                                model.searching.toggle()
                                if !model.searching { Task { await model.clearSearch() } }
                            } label: {
                                Label(model.searching ? UIText.t("검색 닫기", "Close search") : UIText.t("검색", "Search"),
                                      systemImage: "magnifyingglass")
                            }
                            .accessibilityIdentifier("jobs.search")
                            Button {
                                Task { await model.toggleArchived() }
                            } label: {
                                Label(model.archived ? UIText.t("현재 목록", "Current list") : UIText.t("보관함", "Archive"),
                                      systemImage: model.archived ? "tray" : "archivebox")
                            }
                            .accessibilityIdentifier("jobs.archive")
                            if model.type == "paper" {
                                Button { showingAuthors = true } label: {
                                    Label(UIText.t("저자", "Authors"), systemImage: "person.text.rectangle")
                                }.accessibilityIdentifier("jobs.authors")
                            }
                            Button { showingStats = true } label: {
                                Label(UIText.t("통계", "Statistics"), systemImage: "chart.bar")
                            }
                            .accessibilityIdentifier("jobs.stats")
                        } label: {
                            ListIcon(systemName: "ellipsis")
                        }
                        .accessibilityLabel(UIText.t("더 보기", "More"))
                        .accessibilityIdentifier("jobs.more")
                    }
                }
                .sheet(isPresented: $adding) {
                    AddJobView(type: model.type) { Task { await model.reload() } }
                }
                .sheet(isPresented: $showingStats) {
                    if model.type == "newsletter" {
                        NewsletterStatsView(archived: model.archived)
                    } else {
                        ScoreStatsView(archived: model.archived).environmentObject(shell)
                    }
                }
                .sheet(isPresented: $showingAuthors) {
                    AuthorsView(showsClose: true).environment(\.tabNavigationHosted, false)
                }
                .onChange(of: shell.band(model.type)) { _, band in
                    model.band = band
                    Task { await model.reload() }
                }
                .liquidRefreshable { await model.reload() }
                .task(id: shell.listTarget?.request) {
                    if let target = shell.listTarget, target.type == model.type, target.request != revealedRequest {
                        revealedRequest = target.request
                        opened = nil
                        if await model.reveal(target), !Task.isCancelled {
                            try? await Task.sleep(for: .milliseconds(100))
                            guard !Task.isCancelled, shell.tab == model.type,
                                  shell.listTarget?.request == target.request else { return }
                            proxy.scrollTo(target.id, anchor: .center)
                            opened = target.id
                        }
                    } else if model.jobs.isEmpty { await model.reload() }
                }
            }
        }
    }

    private var totalHeader: some View {
        Group {
            if let total = model.total {
                let number = total.formatted(.number.locale(UIText.locale))
                Text(model.archived
                     ? UIText.t("보관함 · \(number)", "Archived · \(number)")
                     : UIText.t("전체 · \(number)", "Total · \(number)"))
            } else if model.countError {
                Text(UIText.t("개수를 불러오지 못했어요", "Count failed to load"))
            } else {
                HStack(spacing: theme.space(1)) {
                    Text(model.archived ? UIText.t("보관함 ·", "Archived ·") : UIText.t("전체 ·", "Total ·"))
                    SkeletonText(role: .meta).frame(width: theme.space(5))
                        .loadingAccessibility("jobs.total.loading", label: UIText.t("개수 불러오는 중", "Loading count"))
                }
                .accessibilityElement(children: .contain)
            }
        }
        .themeText(.meta)
        .foregroundStyle(Theme.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, theme.space(4))
        .padding(.vertical, theme.space(1.75))
        .background(.ultraThinMaterial)
        .accessibilityIdentifier("jobs.total")
    }
}
