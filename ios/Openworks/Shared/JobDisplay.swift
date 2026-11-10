import SwiftUI

func jobHeadline(_ job: [String: Any]) -> String {
    for key in ["title", "url"] {
        if let value = (job[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
            return value
        }
    }
    if (job["emailId"] as? String)?.hasPrefix("screenshot:") == true { return UIText.t("스크린샷", "Screenshot") }
    if job["imageId"] != nil || job["imageIds"] != nil { return UIText.t("이미지", "Image") }
    return UIText.t("제목 없음", "Untitled")
}

func jobSubtitle(_ job: [String: Any]) -> String? {
    guard let url = (job["url"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !url.isEmpty else {
        return nil
    }
    return jobHeadline(job) == url ? nil : url
}

func jobLink(_ job: [String: Any]) -> URL? {
    guard let url = (job["url"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !url.isEmpty else {
        return nil
    }
    return URL(string: url)
}

struct ScoreGrid: View {
    @Environment(\.appearanceTokens) private var theme
    let scores: [String: Any]
    let extra: String?

    private static let paperOrder = [
        "soundness", "originality", "experiments", "clarity", "impact", "significance", "confidence",
    ]
    private static let articleOrder = ["evidence", "logic", "objectivity", "novelty", "clarity", "impact"]

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space(2)) {
            HStack(spacing: theme.space(2)) {
                if let overall = number("overall") {
                    Text(format(overall))
                        .themeText(.heading).monospacedDigit()
                        .foregroundStyle(Theme.accent)
                    Text(UIText.t("종합", "overall"))
                        .themeText(.meta)
                        .foregroundStyle(Theme.secondary)
                }
                if let extra, !extra.isEmpty {
                    Text(extra)
                        .themeText(.meta)
                        .padding(.horizontal, theme.space(1.75))
                        .padding(.vertical, theme.space(0.5))
                        .background(Theme.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: theme.value("radiusPill")))
                }
            }
            let keys = ordered()
            if !keys.isEmpty {
                LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading),
                                    GridItem(.flexible(), alignment: .leading)],
                          alignment: .leading, spacing: theme.space(1)) {
                    ForEach(keys, id: \.self) { key in
                        if let value = number(key) {
                            HStack(spacing: theme.space(1.5)) {
                                Text(scoreLabel(key)).themeText(.meta).foregroundStyle(Theme.secondary)
                                Spacer(minLength: theme.space(0.5))
                                Text(format(value)).themeText(.meta).monospacedDigit()
                            }
                        }
                    }
                }
            }
        }
    }

    private func scoreLabel(_ key: String) -> String {
        let labels = ["soundness": "타당성", "originality": "독창성", "experiments": "실험",
                      "clarity": "명확성", "impact": "영향력", "significance": "의의", "confidence": "확신도",
                      "evidence": "근거", "logic": "논리", "objectivity": "객관성", "novelty": "참신성"]
        return UIText.t(labels[key] ?? key, key)
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

struct FlowLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(ProposedViewSize(width: proposal.width, height: nil))
            if x > 0, x + size.width > width {
                x = 0
                y += lineHeight + spacing
                lineHeight = 0
            }
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
        return CGSize(width: proposal.width ?? x, height: y + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, lineHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += lineHeight + spacing
                lineHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
    }
}

func jobMatchesScoreBand(_ job: [String: Any], band: ClosedRange<Double>?) -> Bool {
    guard let band else { return true }
    return (job["summaryScores"] as? [NSNumber] ?? []).contains { score in
        let value = score.doubleValue
        return value >= band.lowerBound && (value < band.upperBound || (band.upperBound >= 10 && value == 10))
    }
}
