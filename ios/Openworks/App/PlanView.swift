import SwiftUI

// The plan, from today forward. Past days are behind a toggle rather than
// deleted: a day that did not happen is still a record of what was intended.
// Tapping a todo toggles it, which is the write this screen exists for.
struct PlanView: View {
    @EnvironmentObject var state: AppState
    @State private var days: [PlanDay] = []
    @State private var items: [PlanItem] = []
    @State private var error: String?
    @State private var loading = false
    @State private var showPast = false

    private var today: String { todayISO() }

    private var visibleDays: [PlanDay] {
        let sorted = days.sorted { $0.date < $1.date }
        if showPast { return sorted }
        return sorted.filter { $0.date >= today }
    }

    var body: some View {
        NavigationStack {
            LoadState(configured: Convex.configured,
                      error: error,
                      empty: visibleDays.isEmpty,
                      emptyTitle: "No plan",
                      emptyHint: "Days appear once a plan has been synced.",
                      loading: loading) {
                List {
                    ForEach(visibleDays) { day in
                        let rows = items
                            .filter { $0.planSlug == day.planSlug && $0.date == day.date }
                            .sorted { $0.order < $1.order }
                        if !rows.isEmpty {
                            Section {
                                ForEach(rows) { item in
                                    PlanRow(item: item) { Task { await toggle(item) } }
                                }
                            } header: {
                                Text(planDayLabel(day.date))
                            } footer: {
                                if let summary = day.summary, !summary.isEmpty {
                                    Text(summary)
                                }
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
            }
            .navigationTitle("Plan")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showPast.toggle() } label: {
                        Text(showPast ? "All" : "Ahead").font(.caption.bold())
                    }
                    .buttonStyle(.bordered)
                }
            }
            .refreshable { await load() }
            .task { await load() }
            .onChange(of: state.reloadNonce) { _, _ in Task { await load() } }
            .overlay { if loading && days.isEmpty { ProgressView() } }
        }
    }

    func load() async {
        guard Convex.configured else { return }
        loading = true
        defer { loading = false }
        do {
            let plan = try await Convex.plan()
            days = plan.days
            items = plan.items
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    // Flipped locally first: the row answers the tap now, and the reload only
    // corrects it if the backend disagreed.
    func toggle(_ item: PlanItem) async {
        do {
            try await Convex.toggleDone(itemId: item.id)
            let plan = try await Convex.plan()
            days = plan.days
            items = plan.items
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct PlanRow: View {
    let item: PlanItem
    let onToggle: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Button(action: onToggle) {
                Image(systemName: item.done ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(item.done ? Theme.sage : .secondary)
                    .font(.title3)
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 3) {
                Text(item.title)
                    .font(.subheadline)
                    .strikethrough(item.done, color: .secondary)
                    .foregroundStyle(item.done ? .secondary : .primary)
                HStack(spacing: 6) {
                    if let clock = item.clock, !clock.isEmpty {
                        Text(clock).font(.caption2.monospacedDigit())
                    }
                    if let location = item.location, !location.isEmpty {
                        Text(location).font(.caption2)
                    }
                    if item.isEvent { Pill(text: String(localized: "event"), color: Theme.slate) }
                    ForEach(item.tags.prefix(3), id: \.self) { tag in Pill(text: tag, color: .secondary) }
                }
                .foregroundStyle(.secondary)
                if let notes = item.notes, !notes.isEmpty {
                    Text(notes).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                }
            }
        }
        .padding(.vertical, 2)
    }
}
