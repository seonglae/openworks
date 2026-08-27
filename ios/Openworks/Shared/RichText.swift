import SwiftUI
import SwiftMath

// Agent summaries are markdown with TeX in them, which the phone was showing
// raw: asterisks as asterisks, `$O(n\log n)$` as dollar signs. The browser
// renders the same strings with react-markdown + KaTeX.
//
// Here the two halves are rendered by different things, so the split is
// explicit. Prose goes through AttributedString's own markdown parser, which
// costs nothing and handles emphasis, code and links. Maths goes to
// SwiftMath, which typesets it with CoreText rather than a web view, so it
// inherits the text size and does not cost a WKWebView per card.

enum RichSpan: Equatable {
    case text(String)
    case math(String, display: Bool)
}

// Delimiters, longest first so `$$` is never read as two `$`.
private let mathDelimiters: [(open: String, close: String, display: Bool)] = [
    ("$$", "$$", true),
    ("\\[", "\\]", true),
    ("\\(", "\\)", false),
    ("$", "$", false),
]

// A `$` with no partner on the same line is a dollar sign, not the start of
// maths, so an unclosed delimiter stays in the prose rather than swallowing
// the rest of the paragraph.
func parseRich(_ source: String) -> [RichSpan] {
    var spans: [RichSpan] = []
    var text = ""
    var rest = Substring(source)

    func flush() {
        if !text.isEmpty { spans.append(.text(text)); text = "" }
    }

    outer: while let first = rest.first {
        // A backslash-escaped delimiter is literal.
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

// SwiftMath is UIKit, and its intrinsic size is what makes it lay out inline
// next to words rather than claiming a whole row.
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
    let source: String
    var size: CGFloat = 15

    @Environment(\.colorScheme) private var scheme

    // The label's colour is set rather than inherited: a UIKit view inside a
    // scheme this app may be overriding cannot read `.primary`.
    private var mathColor: UIColor {
        scheme == .dark ? UIColor(white: 0.95, alpha: 1) : UIColor(white: 0.10, alpha: 1)
    }

    private var paragraphs: [String] {
        source.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
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
            // No maths in this line, so it wraps as one piece and keeps every
            // markdown span intact.
            Text(markdown(paragraph)).font(.system(size: size))
        } else if spans.count == 1, case let .math(latex, display) = spans[0], display {
            MathLabel(latex: latex, display: true, fontSize: size + 2, color: mathColor)
                .frame(maxWidth: .infinity)
        } else {
            FlowLayout(spacing: 3) {
                ForEach(Array(tokens(spans).enumerated()), id: \.offset) { _, token in
                    switch token {
                    case let .text(word):
                        Text(markdown(word)).font(.system(size: size))
                    case let .math(latex, display):
                        MathLabel(latex: latex, display: display, fontSize: size, color: mathColor)
                    }
                }
            }
        }
    }

    // Inline maths has to sit between words, so a mixed line is laid out
    // word by word. Markdown is applied per word here, which is why a line
    // without maths takes the whole-paragraph path above.
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


// Wraps its children onto as many rows as they need. Used for keyword
// pills and for a line of prose with inline maths in it.
struct FlowLayout: Layout {
    var spacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
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
            let size = view.sizeThatFits(.unspecified)
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
