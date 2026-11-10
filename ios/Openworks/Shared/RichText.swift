import SwiftUI
import SwiftMath

enum RichSpan: Equatable {
    case text(String)
    case math(String, display: Bool)
}

private let mathDelimiters: [(open: String, close: String, display: Bool)] = [
    ("$$", "$$", true),
    ("\\[", "\\]", true),
    ("\\(", "\\)", false),
    ("$", "$", false),
]

func parseRich(_ source: String) -> [RichSpan] {
    var spans: [RichSpan] = []
    var text = ""
    var rest = Substring(source)

    func flush() {
        if !text.isEmpty { spans.append(.text(text)); text = "" }
    }

    outer: while let first = rest.first {
        if first == "\\", rest.count > 1 {
            let next = rest[rest.index(after: rest.startIndex)]
            if next == "$" {
                text.append("$")
                rest = rest.dropFirst(2)
                continue
            }
        }
        for rule in mathDelimiters where rest.hasPrefix(rule.open) {
            let body = rest.dropFirst(rule.open.count)
            if let end = body.range(of: rule.close) {
                let math = String(body[body.startIndex..<end.lowerBound])
                if !math.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    flush()
                    spans.append(.math(math, display: rule.display))
                    rest = body[end.upperBound...]
                    continue outer
                }
            }
        }
        text.append(first)
        rest = rest.dropFirst()
    }
    flush()
    return spans
}

private struct MathLabel: UIViewRepresentable {
    let latex: String
    let display: Bool
    let fontSize: CGFloat
    let color: UIColor

    func makeUIView(context: Context) -> MTMathUILabel {
        let label = MTMathUILabel()
        label.contentInsets = MTEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)
        label.setContentHuggingPriority(.required, for: .horizontal)
        label.setContentHuggingPriority(.required, for: .vertical)
        return label
    }

    func updateUIView(_ label: MTMathUILabel, context: Context) {
        label.latex = latex
        label.labelMode = display ? .display : .text
        label.fontSize = fontSize
        label.textColor = color
        label.textAlignment = display ? .center : .left
        label.invalidateIntrinsicContentSize()
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: MTMathUILabel, context: Context) -> CGSize? {
        uiView.intrinsicContentSize
    }
}

struct RichText: View {
    @Environment(\.appearanceTokens) private var theme
    let source: String
    var style: ThemeText = .body
    private var size: CGFloat { theme.value("text\(style.rawValue)Size") * theme.scale }

    @Environment(\.colorScheme) private var scheme

    private var mathColor: UIColor {
        scheme == .dark ? UIColor(white: 0.95, alpha: 1) : UIColor(white: 0.10, alpha: 1)
    }

    private var paragraphs: [String] {
        source.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: theme.value("rowTextGap")) {
            ForEach(Array(paragraphs.enumerated()), id: \.offset) { _, paragraph in
                if !paragraph.isEmpty {
                    line(paragraph)
                }
            }
        }
    }

    @ViewBuilder
    private func line(_ paragraph: String) -> some View {
        let spans = parseRich(paragraph)
        if spans.allSatisfy({ if case .text = $0 { return true } else { return false } }) {
            Text(markdown(paragraph)).themeText(style)
        } else if spans.count == 1, case let .math(latex, display) = spans[0], display {
            fitted(MathLabel(latex: latex, display: true, fontSize: size, color: mathColor), centred: true)
        } else {
            FlowLayout(spacing: theme.space(0.75)) {
                ForEach(Array(tokens(spans).enumerated()), id: \.offset) { _, token in
                    switch token {
                    case let .text(word):
                        Text(markdown(word)).themeText(style)
                    case let .math(latex, display):
                        fitted(MathLabel(latex: latex, display: display, fontSize: size, color: mathColor), centred: false)
                    }
                }
            }
        }
    }

    private func fitted(_ label: MathLabel, centred: Bool) -> some View {
        ViewThatFits(in: .horizontal) {
            label.frame(maxWidth: centred ? .infinity : nil)
            ScrollView(.horizontal, showsIndicators: false) { label }
        }
    }

    private func tokens(_ spans: [RichSpan]) -> [RichSpan] {
        spans.flatMap { span -> [RichSpan] in
            guard case let .text(text) = span else { return [span] }
            return text.split(separator: " ", omittingEmptySubsequences: true).map { .text(String($0)) }
        }
    }

    private func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(s)
    }
}
