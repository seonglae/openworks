import SwiftUI

@MainActor
final class NewsletterStatsModel: ObservableObject {
    @Published var byDate: [(date: String, letters: Int, elements: Int)] = []
    @Published var bySource: [(source: String, letters: Int)] = []
    @Published var count = 0
    @Published var done = 0
    @Published var elements = 0
    @Published var loading = true
    @Published var error: String?
    private var initialized = false

    func load(archived: Bool) async {
        loading = !initialized
        defer { loading = false; initialized = true }
        let raw: [String: Any]
        do { raw = try await ConvexHTTP.newsletterStats(archived: archived); error = nil }
        catch { self.error = error.localizedDescription; return }
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
    @Environment(\.appearanceTokens) private var theme
    let archived: Bool
    @StateObject private var model = NewsletterStatsModel()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                LiquidRefreshHeader()
                if let error = model.error {
                    LoadFailure(message: error) { Task { await model.load(archived: archived) } }.padding()
                } else if model.loading {
                        VStack(spacing: theme.space(3.5)) {
                            VStack(alignment: .leading, spacing: theme.space(2.5)) {
                                SkeletonText(width: 0.45)
                                HStack(spacing: theme.space(3.5)) {
                                    ForEach(0..<4, id: \.self) { _ in
                                        VStack(alignment: .leading, spacing: theme.space(0.25)) {
                                            SkeletonText(width: 0.4)
                                            SkeletonText(role: .meta, width: 0.8)
                                        }
                                    }
                                }
                                SkeletonChart(height: theme.space(27.5), bars: 30)
                                HStack {
                                    SkeletonText(role: .meta, width: 0.5)
                                    SkeletonText(role: .meta, width: 0.5, alignment: .trailing)
                                }
                                SkeletonText(role: .meta, width: 0.85)
                            }
                            .glassRow().padding(.horizontal, theme.space(4))
                            VStack(alignment: .leading, spacing: theme.space(2.5)) {
                                SkeletonText(width: 0.6)
                                ForEach(0..<4, id: \.self) { _ in
                                    VStack(alignment: .leading, spacing: theme.space(0.75)) {
                                        HStack {
                                            SkeletonText(role: .meta, width: 0.7)
                                            SkeletonText(role: .meta, width: 0.3, alignment: .trailing)
                                        }
                                        Skeleton().frame(height: theme.space(1.25))
                                    }
                                }
                            }
                            .glassRow().padding(.horizontal, theme.space(4))
                        }
                        .padding(.vertical, theme.space(3.5))
                        .loadingAccessibility("stats.loading", label: UIText.t("통계 불러오는 중", "Loading statistics"))
                } else if model.count == 0 {
                    ContentUnavailableView(UIText.t("아직 없어요", "Nothing yet"), systemImage: "newspaper")
                } else {
                        VStack(spacing: theme.space(3.5)) {
                            arrivals.accessibilityIdentifier("stats.loaded").glassRow().padding(.horizontal, theme.space(4))
                            sources.glassRow().padding(.horizontal, theme.space(4))
                        }
                        .padding(.vertical, theme.space(3.5))
                }
            }
            .navigationTitle(UIText.t("뉴스레터", "Newsletters"))
            .inlineNavigationTitle()
            .accessibilityIdentifier("stats.screen")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(UIText.t("완료", "Done")) { dismiss() }.accessibilityIdentifier("stats.close") } }
            .liquidRefreshable { await model.load(archived: archived) }
            .task { await model.load(archived: archived) }
        }
    }

    private var arrivals: some View {
        let peak = max(model.byDate.map(\.elements).max() ?? 1, 1)
        let recent = Array(model.byDate.suffix(45))
        return VStack(alignment: .leading, spacing: theme.space(2.5)) {
            Text(UIText.t("수신 현황", "Arrivals")).themeText(.title)
            HStack(spacing: theme.space(3.5)) {
                figure("\(model.count)", UIText.t("뉴스레터", "letters"))
                figure("\(model.elements)", UIText.t("항목", "items"))
                figure("\(model.done)", UIText.t("처리 완료", "settled"))
                figure("\(recent.count)", UIText.t("일", "days"))
            }
            GeometryReader { geo in
                let gap: CGFloat = 2
                let slotWidth = max((geo.size.width - gap * CGFloat(max(recent.count - 1, 0)))
                                    / CGFloat(max(recent.count, 1)), 1)
                HStack(alignment: .bottom, spacing: gap) {
                    ForEach(recent, id: \.date) { day in
                        RoundedRectangle(cornerRadius: theme.value("radiusSmall"), style: .continuous)
                            .fill(Theme.accent.opacity(0.30 + 0.55 * Double(day.elements) / Double(peak)))
                            .frame(width: min(slotWidth, 24),
                                   height: max(geo.size.height * CGFloat(day.elements) / CGFloat(peak), 1))
                            .frame(width: slotWidth)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
            }
            .frame(height: 110)
            if let first = recent.first?.date, let last = recent.last?.date {
                HStack {
                    Text(first).themeText(.meta).monospacedDigit().foregroundStyle(Theme.secondary)
                    Spacer()
                    Text(last).themeText(.meta).monospacedDigit().foregroundStyle(Theme.secondary)
                }
            }
            Text(UIText.t("발행일별로 요약된 항목 수예요.", "Items summarised per issue date.")).themeText(.meta).foregroundStyle(Theme.secondary)
        }
    }

    private var sources: some View {
        let total = max(model.bySource.reduce(0) { $0 + $1.letters }, 1)
        return VStack(alignment: .leading, spacing: theme.space(2.5)) {
            Text(UIText.t("수신 출처", "Where they come from")).themeText(.title)
            ForEach(model.bySource, id: \.source) { row in
                VStack(alignment: .leading, spacing: theme.space(0.75)) {
                    HStack {
                        Text(row.source).themeText(.meta)
                        Spacer()
                        Text("\(row.letters)").themeText(.meta).monospacedDigit().foregroundStyle(Theme.secondary)
                        Text(String(format: "%.0f%%", 100 * Double(row.letters) / Double(total)))
                            .themeText(.meta).monospacedDigit()
                            .foregroundStyle(Theme.secondary)
                            .frame(width: 34, alignment: .trailing)
                    }
                    GeometryReader { geo in
                        RoundedRectangle(cornerRadius: theme.value("radiusSmall"), style: .continuous)
                            .fill(Theme.accent.opacity(0.45))
                            .frame(width: max(geo.size.width * Double(row.letters) / Double(total), 2))
                    }
                    .frame(height: 5)
                }
            }
        }
    }

    private func figure(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: theme.space(0.25)) {
            Text(value).themeText(.title).monospacedDigit()
            Text(label).themeText(.meta).foregroundStyle(Theme.secondary)
        }
    }
}
