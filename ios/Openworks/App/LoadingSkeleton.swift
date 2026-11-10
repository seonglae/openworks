import SwiftUI

struct SkeletonText: View {
    @Environment(\.appearanceTokens) private var theme
    var role: ThemeText = .title
    var design: Font.Design = .default
    var lines = 1
    var width: CGFloat = 1
    var alignment: Alignment = .leading

    var body: some View {
        Text(verbatim: String(repeating: "\n", count: max(0, lines - 1)) + " ")
            .themeText(role, design: design)
            .hidden()
            .frame(maxWidth: .infinity, alignment: alignment)
            .overlay {
                GeometryReader { geo in
                    let gap = theme.lineSpacing(role)
                    let height = max(0, (geo.size.height - gap * CGFloat(lines - 1)) / CGFloat(max(1, lines)))
                    VStack(alignment: .leading, spacing: gap) {
                        ForEach(0..<lines, id: \.self) { line in
                            RoundedRectangle(cornerRadius: theme.value("radiusSmall"))
                                .fill(Theme.ink.opacity(0.08))
                                .frame(width: geo.size.width * (line == lines - 1 ? width : 1), height: height * 0.65)
                                .frame(height: height)
                                .frame(maxWidth: .infinity, alignment: alignment)
                        }
                    }
                }
            }
            .accessibilityHidden(true)
    }
}

struct SkeletonIcon: View {
    @Environment(\.appearanceTokens) private var theme
    var round = false
    var imageBaseline = false

    var body: some View {
        ListIcon()
            .hidden()
            .overlay {
                RoundedRectangle(cornerRadius: theme.value(round ? "radiusPill" : "radiusControl"))
                    .fill(Theme.ink.opacity(0.08))
            }
            .alignmentGuide(.firstTextBaseline) { $0.height / 2 + (imageBaseline ? 0 : theme.iconBaselineOffset) }
            .accessibilityHidden(true)
    }
}

extension View {
    func loadingAccessibility(_ identifier: String, label: String) -> some View {
        accessibilityElement(children: .ignore)
            .accessibilityHidden(false)
            .accessibilityLabel(label)
            .accessibilityIdentifier(identifier)
    }

    func loadingPlaceholder(_ loading: Bool = true) -> some View {
        redacted(reason: loading ? .placeholder : [])
            .saturation(loading ? 0 : 1)
            .allowsHitTesting(!loading)
            .accessibilityHidden(loading)
    }
}

struct ContentRowSkeleton: View {
    @Environment(\.appearanceTokens) private var theme
    var titleLines = 2
    var badge = false
    var badgePill = true
    var chevron = false
    var roundIcon = false
    var imageIcon = false
    var spacerUnits: CGFloat? = 2
    var chevronTopUnits: CGFloat = 0

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: theme.value("rowGap")) {
            SkeletonIcon(round: roundIcon, imageBaseline: imageIcon)
            VStack(alignment: .leading, spacing: theme.value("rowTextGap")) {
                SkeletonText(lines: titleLines, width: 0.8)
                SkeletonText(role: .meta, width: 0.65)
            }
            if let spacerUnits { Spacer(minLength: theme.space(spacerUnits)) }
            if badge {
                SkeletonText(role: .badge)
                    .frame(width: theme.value("textBadgeSize") * theme.scale * 4)
                    .padding(.horizontal, badgePill ? theme.value("badgePaddingX") : 0)
                    .padding(.vertical, badgePill ? theme.value("badgePaddingY") : 0)
                    .background(Theme.ink.opacity(badgePill ? 0.04 : 0), in: RoundedRectangle(cornerRadius: theme.value("radiusPill")))
            }
            if chevron {
                ListIcon(systemName: "chevron.right").foregroundStyle(Theme.ink.opacity(0.08))
                    .padding(.top, theme.space(chevronTopUnits))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityHidden(true)
    }
}

struct SkeletonChart: View {
    @Environment(\.appearanceTokens) private var theme
    let height: CGFloat
    var bars = 14

    var body: some View {
        HStack(alignment: .bottom, spacing: theme.space(1)) {
            ForEach(0..<bars, id: \.self) { index in
                RoundedRectangle(cornerRadius: theme.value("radiusSmall"))
                    .fill(Theme.ink.opacity(0.08))
                    .frame(height: height * (0.3 + CGFloat(index % 4) * 0.15))
                    .frame(maxWidth: .infinity)
            }
        }
        .frame(height: height, alignment: .bottom)
        .accessibilityHidden(true)
    }
}

struct LoadEmpty: View {
    let message: String

    var body: some View {
        Text(message)
            .themeText(.title).foregroundStyle(Theme.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("load.empty")
    }
}

struct LoadFailure: View {
    let message: String
    var retry: (() -> Void)?
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(UIText.t("불러오기에 실패했어요", "Load failed"), systemImage: "exclamationmark.triangle")
                .themeText(.title).foregroundStyle(Theme.failure)
            Text(message).themeText(.meta).foregroundStyle(Theme.secondary)
            if let retry {
                Button(UIText.t("다시 시도", "Retry"), action: retry)
                    .buttonStyle(ThemeActionStyle())
                    .accessibilityIdentifier("load.retry")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("load.failed")
    }
}
