import SwiftUI

struct SuggestionDiff: View {
    @Environment(\.appearanceTokens) private var theme
    let suggestion: [String: Any]
    let busy: Bool
    var maxLines: Int?
    let onApply: () -> Void
    let onReject: () -> Void

    static var placeholder: [String: Any] { [
        "pageName": UIText.t("페이지 제목", "Page title"),
        "topic": UIText.t("수정 주제", "Edit topic"), "status": "pending",
        "contextBefore": UIText.t("앞 문맥", "Preceding context"),
        "contextAfter": UIText.t("뒤 문맥", "Following context"),
        "content": Array(repeating: UIText.t("제안된 내용", "Proposed content"), count: 3).joined(separator: "\n"),
    ] }

    private var compact: Bool { maxLines != nil }
    private var status: String { (suggestion["status"] as? String) ?? "pending" }
    private var undecided: Bool { status == "pending" || status == "approved" }
    private var pageURL: URL? {
        guard let raw = suggestion["pageUrl"] as? String,
              let url = URL(string: raw),
              ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host != nil else { return nil }
        return url
    }

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space(1.5)) {
            if status == "executed" {
                heading
                appliedState
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: theme.space(2)) {
                        heading
                        Spacer(minLength: theme.space(1))
                        HStack(spacing: theme.space(2)) { verdicts }
                    }
                    VStack(alignment: .leading, spacing: theme.space(1.5)) {
                        heading
                        FlowLayout(spacing: theme.space(2)) { verdicts }
                    }
                }
            }
            VStack(alignment: .leading, spacing: theme.space(0)) {
                Context(text: lastLine(suggestion["contextBefore"] as? String), compact: compact)
                Addition(text: (suggestion["content"] as? String) ?? "", maxLines: maxLines)
                Context(text: firstLine(suggestion["contextAfter"] as? String), compact: compact)
            }
            .clipShape(RoundedRectangle(cornerRadius: theme.value("radiusControl"), style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: theme.value("radiusControl"), style: .continuous)
                    .stroke(Theme.secondary.opacity(0.2), lineWidth: 0.5)
            )
        }
    }

    private var heading: some View {
        VStack(alignment: .leading, spacing: theme.space(0.25)) {
            Text((suggestion["pageName"] as? String) ?? UIText.t("페이지", "Page"))
                .themeText(.title)
                .lineLimit(compact ? 1 : nil)
            if compact {
                Text((suggestion["topic"] as? String) ?? "")
                    .themeText(.meta).foregroundStyle(Theme.secondary).lineLimit(1, reservesSpace: true)
            } else if let topic = suggestion["topic"] as? String, !topic.isEmpty {
                Text(topic).themeText(.meta).foregroundStyle(Theme.secondary)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private var verdicts: some View {
        if busy {
            ProgressView().controlSize(.small)
        } else if undecided {
            Verdict(icon: "xmark", tint: Theme.failure, label: UIText.t("거절", "Reject"), run: onReject).accessibilityIdentifier("suggestion.reject")
            Verdict(icon: "checkmark", tint: Theme.success, label: UIText.t("적용", "Apply"), run: onApply).accessibilityIdentifier("suggestion.apply")
        } else {
            StatusBadge(status: status)
        }
    }

    private var appliedState: some View {
        VStack(alignment: .leading, spacing: theme.space(1)) {
            Label {
                Text(UIText.t("Notion에 적용됨", "Applied to Notion")).accessibilityIdentifier("suggestion.applied")
                    .themeText(.meta)
            } icon: {
                ListIcon(systemName: "checkmark.circle.fill")
            }
            .foregroundStyle(Theme.success)
            if let decidedAt = suggestion["decidedAt"] as? Double, decidedAt.isFinite {
                Text(UIText.dateTime(decidedAt))
                    .themeText(.meta)
                    .foregroundStyle(Theme.secondary)
            }
            if let pageURL {
                Link(destination: pageURL) {
                    Text(UIText.t("Notion에서 열기", "Open in Notion")).underline().accessibilityIdentifier("suggestion.link")
                }
                .themeText(.meta)
                .foregroundStyle(Theme.link)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private func lines(_ text: String?) -> [String] {
        (text ?? "").components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    private func lastLine(_ text: String?) -> String {
        guard let line = lines(text).map(readable).last(where: { !$0.isEmpty }) else { return "" }
        return line.count > 140 ? "…" + line.suffix(140) : line
    }

    private func firstLine(_ text: String?) -> String {
        guard let line = lines(text).map(readable).first(where: { !$0.isEmpty }) else { return "" }
        return line.count > 140 ? String(line.prefix(140)) + "…" : line
    }
}

private struct Verdict: View {
    @Environment(\.appearanceTokens) private var theme
    let icon: String
    let tint: Color
    let label: String
    let run: () -> Void

    var body: some View {
        Button(action: run) {
            ListIcon(systemName: icon)
                .foregroundStyle(Theme.paper)
                .frame(width: theme.value("actionBox") * theme.scale, height: theme.value("actionBox") * theme.scale)
                .background(tint, in: RoundedRectangle(cornerRadius: theme.value("radiusPill")))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

private struct Context: View {
    @Environment(\.appearanceTokens) private var theme
    let text: String
    var compact = false

    var body: some View {
        HStack(alignment: .top, spacing: theme.space(1.5)) {
            Text(" ").themeText(.meta, design: .monospaced).frame(width: 10)
            Text(text.isEmpty ? "···" : inline(text))
                .themeText(.meta)
                .foregroundStyle(Theme.secondary)
                .lineLimit(compact ? 1 : 2, reservesSpace: compact)
        }
        .padding(.vertical, theme.space(1.25))
        .padding(.horizontal, theme.space(2))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.secondary.opacity(0.06))
    }
}

private struct Addition: View {
    @Environment(\.appearanceTokens) private var theme
    let text: String
    let maxLines: Int?

    private var shown: [String] {
        let all = text.components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard let maxLines, all.count > maxLines else { return all }
        return Array(all.prefix(maxLines)) + ["…"]
    }

    private var joined: AttributedString {
        var out = AttributedString()
        for (i, line) in shown.enumerated() {
            if i > 0 { out += AttributedString("\n") }
            if line.hasPrefix("#") {
                var head = inline(line.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces))
                head.font = .footnote.weight(.semibold)
                out += head
            } else if line.hasPrefix("- ") || line.hasPrefix("* ") {
                out += inline("• " + line.dropFirst(2))
            } else if line.hasPrefix(">") {
                out += inline(line.dropFirst().trimmingCharacters(in: .whitespaces))
            } else {
                out += inline(line)
            }
        }
        return out
    }

    var body: some View {
        HStack(alignment: .top, spacing: theme.space(1.5)) {
            Text("+")
                .themeText(.meta, design: .monospaced)
                .foregroundStyle(Theme.success)
                .frame(width: 10)
            if let maxLines {
                Text(joined).themeText(.meta).lineLimit(maxLines, reservesSpace: true)
            } else {
                VStack(alignment: .leading, spacing: theme.space(0.75)) {
                    ForEach(Array(shown.enumerated()), id: \.offset) { _, line in
                        if line.hasPrefix("#") {
                            Text(inline(line.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces)))
                                .themeText(.badge)
                        } else if line.hasPrefix("- ") || line.hasPrefix("* ") {
                            Text(inline("• " + line.dropFirst(2))).themeText(.meta)
                        } else {
                            Text(inline(line)).themeText(.meta)
                        }
                    }
                }
            }
        }
        .padding(.vertical, theme.space(1.5))
        .padding(.horizontal, theme.space(2))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.green.opacity(0.12))
        .overlay(alignment: .leading) {
            Rectangle().fill(Theme.success).frame(width: 2)
        }
    }
}

private func readable(_ line: String) -> String {
    let bare = { (url: Substring) in url.replacingOccurrences(of: #"^https?://(www\.)?"#, with: "", options: .regularExpression) }
    if let source = line.range(of: #"source="[^"]+""#, options: .regularExpression) {
        return bare(line[source].dropFirst(8).dropLast())
    }
    if line.hasPrefix("[Link]("), line.hasSuffix(")") {
        return bare(line.dropFirst(7).dropLast())
    }
    return line
        .replacingOccurrences(of: #"\{color="[^"]*"\}"#, with: "", options: .regularExpression)
        .replacingOccurrences(of: #"^>\s*"#, with: "", options: .regularExpression)
        .replacingOccurrences(of: #"<[^>]*>"#, with: "", options: .regularExpression)
        .replacingOccurrences(of: #"\\([\[\]()*_#`~$|<>])"#, with: "$1", options: .regularExpression)
        .trimmingCharacters(in: .whitespaces)
}

private func inline(_ text: String) -> AttributedString {
    (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
        ?? AttributedString(text)
}

@MainActor
func openNotionPage(_ url: URL?) {
    guard !DemoMode.isEnabled, let url, ["https", "http"].contains(url.scheme?.lowercased() ?? "") else { return }
    var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    components?.scheme = "notion"
    UIApplication.shared.open(components?.url ?? url, options: [:]) { opened in
        if !opened { UIApplication.shared.open(url) }
    }
}
