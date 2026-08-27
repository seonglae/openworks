import SwiftUI

// Peer-review scores (papers) and critique scores (articles) share a scale and
// a layout, so one view reads whichever the row carries. `overall` leads
// because it is what the list badge shows.
struct ScoreGrid: View {
    let scores: [String: Any]
    let extra: String?

    private static let paperOrder = [
        "soundness", "originality", "experiments", "clarity", "impact", "significance", "confidence",
    ]
    private static let articleOrder = ["evidence", "logic", "objectivity", "novelty", "clarity", "impact"]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if let overall = number("overall") {
                    Text(format(overall))
                        .font(.title3.weight(.bold).monospacedDigit())
                        .foregroundStyle(Theme.slate)
                    Text("overall")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let extra, !extra.isEmpty {
                    Text(extra)
                        .font(.caption.weight(.medium))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Theme.slate.opacity(0.12), in: Capsule())
                }
            }
            let keys = ordered()
            if !keys.isEmpty {
                // A fixed two-column grid keeps the criteria aligned down the
                // card whichever set of them this row happens to carry.
                LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading),
                                    GridItem(.flexible(), alignment: .leading)],
                          alignment: .leading, spacing: 4) {
                    ForEach(keys, id: \.self) { key in
                        if let value = number(key) {
                            HStack(spacing: 6) {
                                Text(key).font(.caption2).foregroundStyle(.secondary)
                                Spacer(minLength: 2)
                                Text(format(value)).font(.caption2.monospacedDigit())
                            }
                        }
                    }
                }
            }
        }
    }

    private func ordered() -> [String] {
        let known = scores.keys.contains("evidence") ? Self.articleOrder : Self.paperOrder
        return known.filter { scores[$0] != nil }
    }

    private func number(_ key: String) -> Double? {
        if let d = scores[key] as? Double { return d }
        if let i = scores[key] as? Int { return Double(i) }
        return nil
    }

    private func format(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(format: "%.1f", value)
    }
}


