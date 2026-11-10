import SwiftUI
import UIKit

struct JobSourceMark: View {
    @Environment(\.appearanceTokens) private var theme
    let source: [String: Any]?

    private var emailId: String { source?["emailId"] as? String ?? "" }
    private var favicon: URL? {
        guard let raw = source?["url"] as? String,
              var url = URLComponents(string: raw),
              ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host != nil else { return nil }
        url.user = nil
        url.password = nil
        url.path = "/favicon.ico"
        url.query = nil
        url.fragment = nil
        return url.url
    }

    var inline = false

    private var box: CGFloat {
        inline ? theme.value("textMetaSize") * theme.scale * 1.2 : theme.value("iconBox") * theme.scale
    }
    private var glyph: CGFloat {
        inline ? theme.value("textMetaSize") * theme.scale : theme.value("iconSymbolSize") * theme.scale
    }
    private var capCentre: CGFloat {
        inline ? (UIFont(name: "Pretendard-Regular", size: theme.value("textMetaSize") * theme.scale) ?? UIFont.systemFont(ofSize: theme.value("textMetaSize") * theme.scale)).capHeight / 2 : theme.iconBaselineOffset
    }

    var body: some View {
        sourceMark
            .frame(width: box, height: box)
            .alignmentGuide(.firstTextBaseline) { $0.height / 2 + capCentre }
            .accessibilityHidden(false)
    }

    @ViewBuilder
    private var sourceMark: some View {
        if emailId.hasPrefix("screenshot:") {
            Group {
                if inline {
                    Image(systemName: "iphone").font(theme.font(.meta)).foregroundStyle(Theme.secondary)
                } else {
                    ListIcon(systemName: "iphone")
                }
            }
                .accessibilityLabel(UIText.t("iPhone 스크린샷", "iPhone screenshot"))
        } else if !emailId.isEmpty {
            Image("connector-gmail").resizable().scaledToFit().frame(width: glyph, height: glyph)
                .foregroundStyle(Color(hex: "#EA4335") ?? Theme.ink)
                .accessibilityLabel(UIText.t("Gmail", "Gmail"))
        } else if let favicon {
            AsyncImage(url: favicon) { phase in
                switch phase {
                case .success(let image): image.resizable().scaledToFit()
                case .failure: Image(systemName: "globe").foregroundStyle(Theme.secondary)
                default: Skeleton()
                }
            }
            .frame(width: glyph, height: glyph)
            .accessibilityLabel(favicon.host ?? "")
        } else {
            Group {
                if inline {
                    Image(systemName: "text.alignleft").font(theme.font(.meta))
                } else {
                    ListIcon(systemName: "text.alignleft")
                }
            }
            .foregroundStyle(Theme.secondary)
            .accessibilityLabel(UIText.t("텍스트", "Text"))
        }
    }
}
