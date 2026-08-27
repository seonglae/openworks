import SwiftUI

// The newsletter tab has no scores to distribute, so its two questions are
// different ones: how much arrived on each issue date, and where it came
// from. Both read jobs:newsletterStats, the query the browser's figures use.
@MainActor
final class NewsletterStatsModel: ObservableObject {
    @Published var byDate: [(date: String, letters: Int, elements: Int)] = []
    @Published var bySource: [(source: String, letters: Int)] = []
    @Published var count = 0
    @Published var done = 0
    @Published var elements = 0
    @Published var loading = true

    func load(archived: Bool) async {
        loading = true
        defer { loading = false }
        guard let raw = try? await Convex.newsletterStats(archived: archived) else { return }
        count = (raw["count"] as? Int) ?? 0
        done = (raw["done"] as? Int) ?? 0
        elements = (raw["elements"] as? Int) ?? 0
        byDate = ((raw["byDate"] as? [[String: Any]]) ?? []).map {
            (date: ($0["date"] as? String) ?? "",
             letters: ($0["total"] as? Int) ?? 0,
             elements: ($0["elements"] as? Int) ?? 0)
        }
        bySource = ((raw["bySource"] as? [String: Any]) ?? [:])
            .compactMap { key, value in (value as? Int).map { (source: key, letters: $0) } }
            .sorted { $0.letters > $1.letters }
    }
}

struct NewsletterStatsView: View {
    let archived: Bool
    @StateObject private var model = NewsletterStatsModel()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if model.loading {
                    ProgressView()
                } else if model.count == 0 {
                    ContentUnavailableView("Nothing yet", systemImage: "newspaper")
                } else {
                    ScrollView {
                        VStack(spacing: 14) {
                            arrivals.cardSurface().padding(.horizontal, 16)
                            sources.cardSurface().padding(.horizontal, 16)
                        }
                        .padding(.vertical, 14)
                    }
                }
            }
            .navigationTitle("Newsletters")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await model.load(archived: archived) }
        }
    }

    // Items per issue date. Letters and items are different questions: two
    // letters can carry twenty items or two, and the second number is what
    // says how much there is to read.
    private var arrivals: some View {
        let peak = max(model.byDate.map(\.elements).max() ?? 1, 1)
        // A phone cannot show two years of dates, and the recent end is the
        // one being asked about.
        let recent = Array(model.byDate.suffix(45))
        return VStack(alignment: .leading, spacing: 10) {
            Text("Arrivals").font(.headline)
            HStack(spacing: 14) {
                figure("\(model.count)", "letters")
                figure("\(model.elements)", "items")
                figure("\(model.done)", "settled")
                figure("\(recent.count)", "days")
            }
            GeometryReader { geo in
                let gap: CGFloat = 2
                let width = max((geo.size.width - gap * CGFloat(max(recent.count - 1, 0)))
                                / CGFloat(max(recent.count, 1)), 1)
                HStack(alignment: .bottom, spacing: gap) {
                    ForEach(recent, id: \.date) { day in
                        RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                            .fill(Theme.slate.opacity(0.30 + 0.55 * Double(day.elements) / Double(peak)))
                            .frame(width: width,
                                   height: max(geo.size.height * CGFloat(day.elements) / CGFloat(peak), 1))
                    }
                }
                .frame(maxHeight: .infinity, alignment: .bottom)
            }
            .frame(height: 110)
            if let first = recent.first?.date, let last = recent.last?.date {
                HStack {
                    Text(first).font(.system(size: 9).monospacedDigit()).foregroundStyle(.secondary)
                    Spacer()
                    Text(last).font(.system(size: 9).monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            Text("Items summarised per issue date.").font(.caption2).foregroundStyle(.secondary)
        }
    }

    private var sources: some View {
        let total = max(model.bySource.reduce(0) { $0 + $1.letters }, 1)
        return VStack(alignment: .leading, spacing: 10) {
            Text("Where they come from").font(.headline)
            ForEach(model.bySource, id: \.source) { row in
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(row.source).font(.caption.weight(.medium))
                        Spacer()
                        Text("\(row.letters)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        Text(String(format: "%.0f%%", 100 * Double(row.letters) / Double(total)))
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .frame(width: 34, alignment: .trailing)
                    }
                    GeometryReader { geo in
                        RoundedRectangle(cornerRadius: 2, style: .continuous)
                            .fill(Theme.slate.opacity(0.45))
                            .frame(width: max(geo.size.width * Double(row.letters) / Double(total), 2))
                    }
                    .frame(height: 5)
                }
            }
        }
    }

    private func figure(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value).font(.subheadline.weight(.semibold).monospacedDigit())
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
    }
}
