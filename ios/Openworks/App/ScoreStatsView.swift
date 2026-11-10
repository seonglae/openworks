import SwiftUI

struct Distribution {
    let kind: String
    let count: Int
    let mean: Double
    let min: Double
    let max: Double
    let buckets: [(score: Double, count: Int)]
    let curve: [(x: Double, y: Double)]
    let quartiles: (p25: Double, p50: Double, p75: Double)
}

@MainActor
final class ScoreStatsModel: ObservableObject {
    @Published var distributions: [Distribution] = []
    @Published var loading = true
    @Published var error: String?
    private var initialized = false

    func load(archived: Bool) async {
        loading = !initialized
        defer { loading = false; initialized = true }
        let all: [String: Any]
        do { all = try await ConvexHTTP.scoreStats(archived: archived); error = nil }
        catch { self.error = error.localizedDescription; return }
        distributions = ["paper", "article"].compactMap { kind in
            guard let slot = all[kind] as? [String: Any] else { return nil }
            return Self.build(kind: kind, slot: slot)
        }
    }

    static func build(kind: String, slot: [String: Any]) -> Distribution? {
        let count = (slot["count"] as? Int) ?? 0
        guard count > 0 else { return nil }
        let sum = number(slot["sum"]) ?? 0
        let buckets = ((slot["buckets"] as? [String: Any]) ?? [:])
            .compactMap { key, value -> (Double, Int)? in
                guard let score = Double(key), let n = value as? Int else { return nil }
                return (score, n)
            }
            .sorted { $0.0 < $1.0 }
        guard !buckets.isEmpty else { return nil }
        let lo = max(0, (number(slot["min"]) ?? buckets.first!.0).rounded(.down) - 0.5)
        let hi = min(10, (number(slot["max"]) ?? buckets.last!.0).rounded(.up) + 0.5)

        var points: [Double] = []
        for (score, n) in buckets { points.append(contentsOf: Array(repeating: score + 0.25, count: n)) }
        let span = max(hi - lo, 0.001)
        let bandwidth = 0.35
        let steps = 80
        var curve: [(x: Double, y: Double)] = []
        for i in 0...steps {
            let x = lo + (Double(i) / Double(steps)) * span
            var density = 0.0
            for p in points {
                let z = (x - p) / bandwidth
                density += exp(-0.5 * z * z)
            }
            density /= Double(points.count) * bandwidth * (2 * Double.pi).squareRoot()
            curve.append((x, density))
        }
        return Distribution(
            kind: kind,
            count: count,
            mean: sum / Double(count),
            min: number(slot["min"]) ?? buckets.first!.0,
            max: number(slot["max"]) ?? buckets.last!.0,
            buckets: buckets.map { (score: $0.0, count: $0.1) },
            curve: curve,
            quartiles: areaQuartiles(curve)
        )
    }

    private static func areaQuartiles(_ curve: [(x: Double, y: Double)]) -> (Double, Double, Double) {
        guard curve.count > 1 else { return (0, 0, 0) }
        var cumulative: [Double] = [0]
        var total = 0.0
        for i in 1..<curve.count {
            let width = curve[i].x - curve[i - 1].x
            total += (curve[i].y + curve[i - 1].y) / 2 * width
            cumulative.append(total)
        }
        guard total > 0 else { return (curve[0].x, curve[0].x, curve[0].x) }
        func at(_ fraction: Double) -> Double {
            let target = fraction * total
            for i in 1..<cumulative.count where cumulative[i] >= target {
                let span = cumulative[i] - cumulative[i - 1]
                let t = span > 0 ? (target - cumulative[i - 1]) / span : 0
                return curve[i - 1].x + (curve[i].x - curve[i - 1].x) * t
            }
            return curve.last!.x
        }
        return (at(0.25), at(0.5), at(0.75))
    }

    private static func number(_ value: Any?) -> Double? {
        if let d = value as? Double { return d.isFinite ? d : nil }
        if let i = value as? Int { return Double(i) }
        return nil
    }
}

struct ScoreStatsView: View {
    @Environment(\.appearanceTokens) private var theme
    let archived: Bool
    @EnvironmentObject private var shell: Shell
    @StateObject private var model = ScoreStatsModel()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                LiquidRefreshHeader()
                if let error = model.error {
                    LoadFailure(message: error) { Task { await model.load(archived: archived) } }.padding()
                } else if model.loading {
                        VStack(spacing: theme.space(3.5)) {
                            ForEach(0..<2, id: \.self) { _ in
                                VStack(alignment: .leading, spacing: theme.space(2.5)) {
                                    SkeletonText(width: 0.4)
                                    HStack(spacing: theme.space(3.5)) {
                                        ForEach(0..<4, id: \.self) { _ in
                                            VStack(alignment: .leading, spacing: theme.space(0.25)) {
                                                SkeletonText(width: 0.5)
                                                SkeletonText(role: .meta, width: 0.7)
                                            }
                                        }
                                    }
                                    SkeletonChart(height: theme.space(24), bars: 20)
                                    HStack(spacing: theme.space(1.25)) {
                                        ForEach(0..<6, id: \.self) { _ in
                                            VStack(spacing: theme.space(0.25)) {
                                                SkeletonText(role: .meta)
                                                SkeletonText(role: .meta)
                                            }
                                            .padding(.horizontal, theme.space(1.75))
                                            .padding(.vertical, theme.space(1))
                                            .background(Theme.ink.opacity(0.04), in: RoundedRectangle(cornerRadius: theme.value("radiusControl")))
                                        }
                                    }.padding(.vertical, theme.space(0.25))
                                }
                                .glassRow().padding(.horizontal, theme.space(4))
                            }
                        }.padding(.vertical, theme.space(3.5))
                        .loadingAccessibility("stats.loading", label: UIText.t("통계 불러오는 중", "Loading statistics"))
                } else if model.distributions.isEmpty {
                    ContentUnavailableView(UIText.t("아직 점수가 없어요", "No scores yet"), systemImage: "chart.bar",
                                           description: Text(UIText.t("요약이 끝나면 점수가 표시돼요.", "Scores appear once items finish summarising.")))
                } else {
                        VStack(spacing: theme.space(3.5)) {
                            ForEach(model.distributions, id: \.kind) { d in
                                DistributionCard(distribution: d, selected: shell.band(d.kind)) { band in
                                    shell.apply(kind: d.kind, band: band)
                                    dismiss()
                                }
                                .glassRow()
                                .padding(.horizontal, theme.space(4))
                            }
                            Text(UIText.t("종합 점수를 0.5점 단위로 나눴어요. 구간을 누르면 해당 목록을 좁혀 볼 수 있어요.", "Overall score, half-point buckets. Tap a bucket to filter that tab."))
                                .themeText(.meta)
                                .foregroundStyle(Theme.secondary)
                                .padding(.horizontal, theme.space(5))
                                .padding(.top, theme.space(0.5))
                                .accessibilityIdentifier("stats.loaded")
                        }
                        .padding(.vertical, theme.space(3.5))
                }
            }
            .navigationTitle(UIText.t("점수 분포", "Score distribution"))
            .inlineNavigationTitle()
            .accessibilityIdentifier("stats.screen")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button(UIText.t("완료", "Done")) { dismiss() }.accessibilityIdentifier("stats.close") }
            }
            .liquidRefreshable { await model.load(archived: archived) }
            .task { await model.load(archived: archived) }
        }
    }
}

private struct DistributionCard: View {
    @Environment(\.appearanceTokens) private var theme
    let distribution: Distribution
    let selected: ClosedRange<Double>?
    let onPick: (ClosedRange<Double>?) -> Void

    private var peak: Int { max(distribution.buckets.map(\.count).max() ?? 1, 1) }
    private var domain: (lo: Double, hi: Double) {
        (distribution.curve.first?.x ?? 0, distribution.curve.last?.x ?? 10)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space(2.5)) {
            HStack(alignment: .firstTextBaseline) {
                Text(UIText.tab(distribution.kind)).themeText(.title)
                Spacer()
                if let selected {
                    Button {
                        onPick(nil)
                    } label: {
                        Label(bandLabel(selected), systemImage: "xmark.circle.fill")
                            .themeText(.meta)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.accent)
                }
            }

            HStack(spacing: theme.space(3.5)) {
                figure("\(distribution.count)", UIText.t("개수", "n"))
                figure(String(format: "%.1f", distribution.mean), UIText.t("평균", "avg"))
                figure(String(format: "%.1f", distribution.quartiles.p50), "p50")
                figure("\(trim(distribution.min))–\(trim(distribution.max))", UIText.t("범위", "range"))
            }

            curveAndBars
            bucketRow
        }
    }

    private var curveAndBars: some View {
        GeometryReader { geo in
            let (lo, hi) = domain
            let span = max(hi - lo, 0.001)
            let maxDensity = max(distribution.curve.map(\.y).max() ?? 1, 0.0001) * 1.1
            let x = { (v: Double) in (v - lo) / span * geo.size.width }
            let y = { (d: Double) in geo.size.height - (d / maxDensity) * geo.size.height }

            ZStack(alignment: .bottomLeading) {
                ForEach(distribution.buckets, id: \.score) { bucket in
                    let inBand = selected.map { $0.contains(bucket.score) } ?? false
                    Rectangle()
                        .fill(Theme.accent.opacity(inBand ? 0.45 : 0.16))
                        .frame(width: max(x(bucket.score + 0.5) - x(bucket.score) - 1, 1),
                               height: max(geo.size.height * CGFloat(bucket.count) / CGFloat(peak), 1))
                        .offset(x: x(bucket.score))
                }

                Path { path in
                    for (i, point) in distribution.curve.enumerated() {
                        let p = CGPoint(x: x(point.x), y: y(point.y))
                        if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
                    }
                }
                .stroke(Theme.accent, lineWidth: 1.4)

                ForEach([("p25", distribution.quartiles.p25),
                         ("p50", distribution.quartiles.p50),
                         ("p75", distribution.quartiles.p75)], id: \.0) { label, value in
                    Path { path in
                        path.move(to: CGPoint(x: x(value), y: 0))
                        path.addLine(to: CGPoint(x: x(value), y: geo.size.height))
                    }
                    .stroke(style: StrokeStyle(lineWidth: 0.7, dash: [2, 3]))
                    .foregroundStyle(Theme.secondary)
                    Text(label)
                        .themeText(.meta).monospacedDigit()
                        .foregroundStyle(Theme.secondary)
                        .offset(x: x(value) + 2, y: 0)
                }
            }
        }
        .frame(height: 96)
    }

    private var bucketRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: theme.space(1.25)) {
                ForEach(distribution.buckets, id: \.score) { bucket in
                    let band = bucket.score...(bucket.score + 0.5)
                    let active = selected == band
                    Button {
                        onPick(active ? nil : band)
                    } label: {
                        VStack(spacing: theme.space(0.25)) {
                            Text(trim(bucket.score)).themeText(.meta).monospacedDigit()
                            Text("\(bucket.count)").themeText(.meta).monospacedDigit()
                                .foregroundStyle(active ? Theme.paper : .secondary)
                        }
                        .padding(.horizontal, theme.space(1.75))
                        .padding(.vertical, theme.space(1))
                        .background(active ? Theme.accent : Theme.accent.opacity(0.10),
                                    in: RoundedRectangle(cornerRadius: theme.value("radiusControl"), style: .continuous))
                        .foregroundStyle(active ? Theme.paper : Color.primary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, theme.space(0.25))
        }
    }

    private func figure(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: theme.space(0.25)) {
            Text(value).themeText(.title).monospacedDigit()
            Text(label).themeText(.meta).foregroundStyle(Theme.secondary)
        }
    }

    private func trim(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(format: "%.1f", value)
    }
}
