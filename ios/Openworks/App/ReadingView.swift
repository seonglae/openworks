import SwiftUI

// The queue: newsletters, papers, articles. The tldr the summarising agent
// wrote sits on the row, so the list is readable without opening anything.
// Swipe archives, which is the only write this screen makes.
private let JOB_TYPES = ["newsletter", "paper", "article"]
private let PAGE_SIZE = 30

struct ReadingView: View {
    @EnvironmentObject var state: AppState
    @State private var type = "newsletter"
    @State private var archived = false
    @State private var jobs: [Job] = []
    @State private var cursor: String?
    @State private var done = true
    @State private var total = 0
    @State private var error: String?
    @State private var loading = false

    var body: some View {
        NavigationStack {
            LoadState(configured: Convex.configured,
                      error: error,
                      empty: jobs.isEmpty,
                      emptyTitle: "Nothing here",
                      emptyHint: "Items land here once a worker has fetched and summarised them.",
                      loading: loading) {
                List {
                    Section {
                        ForEach(jobs) { job in
                            NavigationLink { JobDetail(job: job) } label: { JobRow(job: job) }
                                .swipeActions(edge: .trailing) {
                                    Button(archived ? "Restore" : "Archive") {
                                        Task { await setArchived(job) }
                                    }
                                    .tint(Theme.slate)
                                }
                        }
                        if !done {
                            HStack {
                                Spacer()
                                ProgressView().onAppear { Task { await loadMore() } }
                                Spacer()
                            }
                        }
                    } footer: {
                        Text(String(format: String(localized: "%d shown of %d"), jobs.count, total))
                    }
                }
                .listStyle(.plain)
            }
            .navigationTitle("Reading")
            .safeAreaInset(edge: .top) {
                Picker("Type", selection: $type) {
                    ForEach(JOB_TYPES, id: \.self) { t in Text(label(t)).tag(t) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.bottom, 6)
                .background(.bar)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { archived.toggle() } label: {
                        Image(systemName: archived ? "archivebox.fill" : "archivebox")
                    }
                }
            }
            .refreshable { await reload() }
            .task { await reload() }
            .onChange(of: type) { _, _ in Task { await reload() } }
            .onChange(of: archived) { _, _ in Task { await reload() } }
            .onChange(of: state.reloadNonce) { _, _ in Task { await reload() } }
            .overlay { if loading && jobs.isEmpty { ProgressView() } }
        }
    }

    func label(_ t: String) -> LocalizedStringKey {
        switch t {
        case "paper": return "Papers"
        case "article": return "Articles"
        default: return "Newsletters"
        }
    }

    func reload() async {
        guard Convex.configured else { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await Convex.jobs(type: type, archived: archived, numItems: PAGE_SIZE, cursor: nil)
            jobs = page.items
            cursor = page.cursor
            done = page.done
            total = try await Convex.jobCount(type: type, archived: archived)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func loadMore() async {
        guard !done, !loading, let cursor else { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await Convex.jobs(type: type, archived: archived, numItems: PAGE_SIZE, cursor: cursor)
            jobs.append(contentsOf: page.items)
            self.cursor = page.cursor
            done = page.done
        } catch {
            self.error = error.localizedDescription
        }
    }

    func setArchived(_ job: Job) async {
        do {
            if archived { try await Convex.unarchive(jobId: job.id) } else { try await Convex.archive(jobId: job.id) }
            jobs.removeAll { $0.id == job.id }
            total = max(0, total - 1)
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct JobRow: View {
    let job: Job

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(job.title).font(.subheadline.weight(.medium)).lineLimit(2)
            if !job.tldr.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(job.tldr.prefix(3).enumerated()), id: \.offset) { _, line in
                        Text(line).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
            } else if job.tldrPending {
                Text("Summarising…").font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 6) {
                if let source = job.source, !source.isEmpty {
                    Text(source).font(.caption2)
                } else if !job.host.isEmpty {
                    Text(job.host).font(.caption2)
                }
                Text(relAge(job.createdAt)).font(.caption2)
                Spacer()
                if !job.isDone { Pill(text: job.status, color: Theme.statusColor(job.status)) }
            }
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 3)
    }
}

struct JobDetail: View {
    let job: Job
    @State private var summaries: [Summary] = []
    @State private var error: String?
    @State private var loading = false

    var body: some View {
        List {
            Section {
                Text(job.title).font(.headline)
                if let url = URL(string: job.url) { Link(job.host.isEmpty ? job.url : job.host, destination: url) }
                if let err = job.error, !err.isEmpty {
                    Text(err).font(.caption).foregroundStyle(.red)
                }
            }
            if !job.tldr.isEmpty {
                Section("TLDR") {
                    ForEach(Array(job.tldr.enumerated()), id: \.offset) { _, line in
                        Text(line).font(.subheadline)
                    }
                }
            }
            ForEach(summaries) { s in
                Section {
                    Text(s.summary).font(.subheadline)
                    if !s.keywords.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                ForEach(s.keywords, id: \.self) { k in Pill(text: k, color: Theme.slate) }
                            }
                        }
                    }
                } header: {
                    HStack {
                        Text(s.title).textCase(nil)
                        Spacer()
                        if let overall = s.overall {
                            Text(String(format: "%.1f", overall)).font(.caption.monospacedDigit())
                        }
                    }
                }
            }
            if let error { Section { Text(error).font(.caption).foregroundStyle(.red) } }
        }
        .navigationTitle(job.type.capitalized)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .overlay { if loading && summaries.isEmpty { ProgressView() } }
    }

    func load() async {
        loading = true
        defer { loading = false }
        do {
            summaries = try await Convex.summaries(jobId: job.id).sorted { $0.index < $1.index }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
