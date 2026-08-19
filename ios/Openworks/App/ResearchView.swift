import SwiftUI

// Projects by how recently they moved, and the timeline behind each one. The
// timeline is the point: openworks addresses the process, so what a project has
// done lately is more informative than what it is called.
struct ResearchView: View {
    @EnvironmentObject var state: AppState
    @State private var projects: [Project] = []
    @State private var error: String?
    @State private var loading = false

    var body: some View {
        NavigationStack {
            LoadState(configured: Convex.configured,
                      error: error,
                      empty: projects.isEmpty,
                      emptyTitle: "No projects",
                      emptyHint: "Projects registered through the CLI or the MCP server appear here.",
                      loading: loading) {
                List {
                    ForEach(projects) { p in
                        NavigationLink { TimelineView(project: p) } label: { ProjectRow(p: p) }
                    }
                }
                .listStyle(.plain)
            }
            .navigationTitle("Research")
            .refreshable { await load() }
            .task { await load() }
            .onChange(of: state.reloadNonce) { _, _ in Task { await load() } }
            .overlay { if loading && projects.isEmpty { ProgressView() } }
        }
    }

    func load() async {
        guard Convex.configured else { return }
        loading = true
        defer { loading = false }
        do {
            projects = try await Convex.projects()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct ProjectRow: View {
    let p: Project
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(p.title).font(.subheadline.weight(.medium)).lineLimit(2)
            HStack(spacing: 6) {
                Pill(text: p.phase, color: Theme.phaseColor(p.phase))
                Text(p.kind).font(.caption2)
                Spacer()
                Text(relAge(p.updatedAt)).font(.caption2)
            }
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 3)
    }
}

struct TimelineView: View {
    let project: Project
    @State private var entries: [TimelineEntry] = []
    @State private var error: String?
    @State private var loading = false

    var body: some View {
        List {
            Section {
                LabeledContent("Phase") { Pill(text: project.phase, color: Theme.phaseColor(project.phase)) }
                LabeledContent("Kind", value: project.kind)
                LabeledContent("Updated", value: relAge(project.updatedAt))
            }
            Section("Timeline") {
                ForEach(entries) { e in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(e.state).font(.subheadline.weight(.medium))
                            Spacer()
                            Text(relAge(e.at)).font(.caption2).foregroundStyle(.secondary)
                        }
                        if let note = e.note, !note.isEmpty {
                            Text(note).font(.caption).foregroundStyle(.secondary)
                        }
                        HStack(spacing: 6) {
                            if let actor = e.actor, !actor.isEmpty { Pill(text: actor, color: Theme.slate) }
                            if let ref = e.artifactRef, !ref.isEmpty {
                                Text(ref).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
            if let error { Section { Text(error).font(.caption).foregroundStyle(.red) } }
        }
        .navigationTitle(project.slug)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .overlay { if loading && entries.isEmpty { ProgressView() } }
    }

    func load() async {
        loading = true
        defer { loading = false }
        do {
            entries = try await Convex.timeline(slug: project.slug)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
