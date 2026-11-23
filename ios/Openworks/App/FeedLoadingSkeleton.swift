import SwiftUI

struct FeedLoadingSkeleton: View {
    @Environment(\.appearanceTokens) private var theme

    var body: some View {
        ReelPageLayout {
            VStack(spacing: theme.space(2.5)) {
                SkeletonText(role: .meta, width: 0.5, alignment: .center)
                SkeletonText(role: .heading, design: .serif, lines: 2, width: 0.8, alignment: .center)
            }
            Skeleton()
                .frame(height: theme.value("feedImageHeight"))
                .clipShape(RoundedRectangle(cornerRadius: theme.value("radiusCard")))
            SkeletonText(role: .body, lines: 3, width: 0.7)
            HStack(spacing: theme.value("actionGap")) {
                ForEach(0..<3, id: \.self) { _ in
                    VStack(spacing: theme.value("actionGap")) {
                        RoundedRectangle(cornerRadius: theme.value("radiusPill"))
                            .fill(Theme.ink.opacity(0.08))
                            .frame(width: theme.value("actionBox") * theme.scale, height: theme.value("actionBox") * theme.scale)
                        SkeletonText(role: .action)
                            .frame(width: theme.value("actionBox") * theme.scale)
                    }
                    .padding(theme.value("actionPadding"))
                }
            }
            .padding(.top, theme.space(0.5))
            SkeletonText(role: .meta, width: 0.3, alignment: .center)
        }
        .ignoresSafeArea(edges: .bottom)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(UIText.t("피드 불러오는 중", "Loading feed"))
        .accessibilityIdentifier("feed.loading")
    }
}
