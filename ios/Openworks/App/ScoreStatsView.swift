import SwiftUI

// Both distributions at once, from the one summaries:scoreStats the browser's
// figures also read, so the phone and the dashboard cannot disagree about the
// shape. Papers and articles are scored on the same 1-10 scale by different
// criteria, and the interesting question is usually how they compare, which a
// single chart cannot answer.
//
// The curve is the same kernel density estimate the browser draws, over the
// same half-point buckets, with markers at the quartiles of the rendered
// curve. Tapping a bucket filters that kind's tab to the jobs inside it.

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

    func load(archived: Bool) async {
        loading = true
        defer { loading = false }
        guard let all = try? await Convex.scoreStats(archived: archived) else { return }
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

        // Bucket centres, weighted by how many landed in each, smoothed with
        // the same 0.35 bandwidth the browser uses.
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

    // Where the area under the rendered curve is split into quarters, which is
    // what makes the markers describe the picture rather than the raw sample.
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
    let archived: Bool
    @StateObject private var model = ScoreStatsModel()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if model.loading {
                    ProgressView()
                } else if model.distributions.isEmpty {
                    ContentUnavailableView("No scores yet", systemImage: "chart.bar",
                                           description: Text("Scores appear once items finish summarising."))
                } else {
                    ScrollView {
                        VStack(spacing: 14) {
                            ForEach(model.distributions, id: \.kind) { d in
                                DistributionCard(distribution: d)
                                                                .cardSurface()
                                .padding(.horizontal, 16)
                            }
                            Text("Overall score, half-point buckets.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 20)
                                .padding(.top, 2)
                        }
                        .padding(.vertical, 14)
                    }
                }
            }
            .navigationTitle("Score distribution")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .task { await model.load(archived: archived) }
        }
    }
}

private struct DistributionCard: View {
    let distribution: Distribution
    private let selected: ClosedRange<Double>? = nil

    private var peak: Int { max(distribution.buckets.map(\.count).max() ?? 1, 1) }
    private var domain: (lo: Double, hi: Double) {
        (distribution.curve.first?.x ?? 0, distribution.curve.last?.x ?? 10)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(distribution.kind.capitalized).font(.headline)
                Spacer()
            }

            HStack(spacing: 14) {
                figure("\(distribution.count)", "n")
                figure(String(format: "%.1f", distribution.mean), "avg")
                figure(String(format: "%.1f", distribution.quartiles.p50), "p50")
                figure("\(trim(distribution.min))–\(trim(distribution.max))", "range")
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
                // Bars first: the buckets are the data, the curve is the read.
                ForEach(distribution.buckets, id: \.score) { bucket in
                    let inBand = selected.map { $0.contains(bucket.score) } ?? false
                    Rectangle()
                        .fill(Theme.slate.opacity(inBand ? 0.45 : 0.16))
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
                .stroke(Theme.slate, lineWidth: 1.4)

                ForEach([("p25", distribution.quartiles.p25),
                         ("p50", distribution.quartiles.p50),
                         ("p75", distribution.quartiles.p75)], id: \.0) { label, value in
                    Path { path in
                        path.move(to: CGPoint(x: x(value), y: 0))
                        path.addLine(to: CGPoint(x: x(value), y: geo.size.height))
                    }
                    .stroke(style: StrokeStyle(lineWidth: 0.7, dash: [2, 3]))
                    .foregroundStyle(.secondary)
                    Text(label)
                        .font(.system(size: 8).monospacedDigit())
                        .foregroundStyle(.secondary)
                        .offset(x: x(value) + 2, y: 0)
                }
            }
        }
        .frame(height: 96)
    }

    // The tap target. A bar two points wide is not one, and the numbers under
    // the axis are worth reading anyway.
    private var bucketRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 5) {
                ForEach(distribution.buckets, id: \.score) { bucket in
                    let active = false
                    VStack(spacing: 1) {
                        Text(trim(bucket.score)).font(.system(size: 10).monospacedDigit())
                        Text("\(bucket.count)").font(.system(size: 9).monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 7)
                    .padding(.vertical, 4)
                    .background(Theme.slate.opacity(active ? 0.3 : 0.10),
                                in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                }
            }
            .padding(.vertical, 1)
        }
    }

    private func figure(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value).font(.subheadline.weight(.semibold).monospacedDigit())
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func trim(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(format: "%.1f", value)
    }
}
