import Combine
import SwiftUI
import UIKit

enum ThemeText: String {
    case title = "Title", meta = "Meta", badge = "Badge", action = "Action"
    case body = "Body", heading = "Heading", display = "Display"
}

struct AppearanceEditorSpec: Decodable {
    struct Group: Decodable {
        let label: String
        let tokens: [String]
    }
    struct Limits: Decodable {
        var name: String?
        var suffix: String?
        let min: Double
        let max: Double
        let step: Double

        func contains(_ value: Double) -> Bool {
            value.isFinite && value >= min && value <= max
                && abs((value - min) / step - ((value - min) / step).rounded()) <= 1e-8
        }
    }
    let groups: [Group]
    let rules: [Limits]
    let defaultLimits: Limits
    let icons: [String: String]
    let text: [String: [String: String]]

    static let shared: AppearanceEditorSpec = {
        guard let url = Bundle.main.url(forResource: "appearanceEditor", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let spec = try? JSONDecoder().decode(Self.self, from: data) else {
            preconditionFailure("Missing bundled appearance editor")
        }
        return spec
    }()

    func limits(_ key: String) -> Limits {
        rules.first { $0.name == key || ($0.suffix.map { key.hasSuffix($0) } ?? false) } ?? defaultLimits
    }
}

struct AppearanceTokens {
    private(set) var values: [String: Any]
    var scale: CGFloat = 1

    static let defaults: [String: Any] = {
        guard let url = Bundle.main.url(forResource: "appearanceDefaults", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let values = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            preconditionFailure("Missing bundled appearance defaults")
        }
        return values
    }()

    init(_ overrides: [String: Any] = [:]) {
        values = Self.defaults
        for (key, fallback) in Self.defaults {
            if fallback is String, let value = overrides[key] as? String, Self.symbols[value] != nil {
                values[key] = value
            } else if fallback is NSNumber, let value = overrides[key] as? NSNumber,
                      CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite,
                      value.doubleValue >= 0, value.doubleValue <= 999 {
                values[key] = value
            }
        }
    }

    func value(_ key: String) -> CGFloat {
        guard let number = values[key] as? NSNumber else { preconditionFailure("Unknown appearance token: \(key)") }
        return CGFloat(number.doubleValue)
    }

    func space(_ units: CGFloat) -> CGFloat { value("spaceUnit") * units }
    func font(_ role: ThemeText, design: Font.Design = .default) -> Font {
        let size = value("text\(role.rawValue)Size") * scale
        if design == .monospaced { return .system(size: size, weight: weight("text\(role.rawValue)Weight"), design: design) }
        return .custom(fontName(value("text\(role.rawValue)Weight")), fixedSize: size)
    }
    func lineSpacing(_ role: ThemeText) -> CGFloat { value("text\(role.rawValue)LineSpacing") * scale }
    func weight(_ key: String) -> Font.Weight {
        fontWeight(value(key))
    }
    var iconBaselineOffset: CGFloat {
        (UIFont(name: fontName(value("textTitleWeight")), size: value("textTitleSize") * scale) ?? UIFont.systemFont(ofSize: value("textTitleSize") * scale)).capHeight / 2
    }
    var iconFont: Font {
        let baseStroke = (Self.defaults["iconStrokeWidth"] as! NSNumber).doubleValue
        let weight = value("iconWeight") * value("iconStrokeWidth") / baseStroke
        return .system(size: min(value("iconSymbolSize"), value("iconBox")) * scale, weight: fontWeight(weight))
    }
    func fontName(_ weight: CGFloat) -> String {
        let names = ["Thin", "ExtraLight", "Light", "Regular", "Medium", "SemiBold", "Bold", "ExtraBold", "Black"]
        let index = min(max(Int((weight / 100).rounded()) - 1, 0), names.count - 1)
        return "Pretendard-" + names[index]
    }

    private func fontWeight(_ value: CGFloat) -> Font.Weight {
        switch value {
        case ..<200: .ultraLight
        case ..<300: .thin
        case ..<400: .light
        case ..<500: .regular
        case ..<600: .medium
        case ..<700: .semibold
        case ..<800: .bold
        case ..<900: .heavy
        default: .black
        }
    }
    func icon(_ group: String, _ key: String) -> String {
        let token = "\(group)\(key.prefix(1).uppercased())\(key.dropFirst())Icon"
        let fallback = values["kindOtherIcon"] as? String
        return ((values[token] as? String) ?? fallback).flatMap { Self.symbols[$0] } ?? "circle"
    }
    static let symbols = AppearanceEditorSpec.shared.icons
}

private struct AppearanceKey: EnvironmentKey {
    static let defaultValue = AppearanceTokens()
}

extension EnvironmentValues {
    var appearanceTokens: AppearanceTokens {
        get { self[AppearanceKey.self] }
        set { self[AppearanceKey.self] = newValue }
    }
}

@MainActor
final class AppearanceStore: ObservableObject {
    static let shared = AppearanceStore()
    private static let cacheKey = "openworks.appearanceTokens"
    @Published private(set) var tokens: AppearanceTokens
    @Published private(set) var overrides: [String: Any] = [:]

    private init() {
        let saved = (DemoMode.isEnabled ? nil : UserDefaults.standard.data(forKey: Self.cacheKey))
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        tokens = AppearanceTokens(saved ?? [:])
        overrides = saved ?? [:]
    }

    func load() async throws {}

    func refresh() async {}

    func save(_ patch: [String: Any]) async throws {
        var next = overrides
        for (key, value) in patch {
            if value is NSNull { next.removeValue(forKey: key) }
            else { next[key] = value }
        }
        let data = try JSONSerialization.data(withJSONObject: next)
        if !DemoMode.isEnabled { UserDefaults.standard.set(data, forKey: Self.cacheKey) }
        overrides = next
        tokens = AppearanceTokens(next)
    }

}

struct AppearanceRoot: ViewModifier {
    @ObservedObject private var store = AppearanceStore.shared
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1
    func body(content: Content) -> some View {
        var tokens = store.tokens
        tokens.scale = scale
        return content.environment(\.appearanceTokens, tokens)
            .font(tokens.font(.body)).lineSpacing(tokens.lineSpacing(.body))
            .labelStyle(ThemeLabelStyle())
    }
}

private struct ThemeTextStyle: ViewModifier {
    @Environment(\.appearanceTokens) private var theme
    let role: ThemeText
    var design: Font.Design
    func body(content: Content) -> some View {
        content.font(theme.font(role, design: design)).lineSpacing(theme.lineSpacing(role))
    }
}

struct ListIcon: View {
    @Environment(\.appearanceTokens) private var theme
    var systemName: String? = nil
    var island: String? = nil
    var kind: String? = nil
    var body: some View {
        Image(systemName: island.map { theme.icon("island", $0) } ?? kind.map { theme.icon("kind", $0) } ?? systemName ?? "circle")
            .font(theme.iconFont)
            .imageScale(.medium)
            .frame(width: theme.value("iconBox") * theme.scale, height: theme.value("iconBox") * theme.scale)
            .alignmentGuide(.firstTextBaseline) { $0.height / 2 + theme.iconBaselineOffset }
            .accessibilityHidden(systemName == nil)
    }
}

private struct ThemeLabelStyle: LabelStyle {
    @Environment(\.appearanceTokens) private var theme
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: theme.value("rowGap")) {
            configuration.icon
                .font(theme.iconFont)
                .imageScale(.medium)
                .frame(width: theme.value("iconBox") * theme.scale, height: theme.value("iconBox") * theme.scale)
                .alignmentGuide(.firstTextBaseline) { $0.height / 2 + theme.iconBaselineOffset }
            configuration.title
        }
    }
}

extension View {
    func themeText(_ role: ThemeText, design: Font.Design = .default) -> some View {
        modifier(ThemeTextStyle(role: role, design: design))
    }
}

enum Theme {
    static let accent = pair(light: 0x1c_1c_1e, dark: 0xf2_f2_f2)
    static let paper = pair(light: 0xf6_f5_f2, dark: 0x0e_0e_0f)
    static let card = pair(light: 0xff_ff_ff, dark: 0x1c_1c_1e)
    static let ink = pair(light: 0x1a_1a_1a, dark: 0xf2_f2_f2)
    static let secondary = pair(light: 0x595959, dark: 0xaaaaaf)
    static let success = pair(light: 0x246a3c, dark: 0x90d5a5)
    static let warning = pair(light: 0x81510d, dark: 0xf2c078)
    static let failure = pair(light: 0xa12630, dark: 0xff9da5)
    static let link = pair(light: 0x5b_4b_8a, dark: 0xb0_a0_e0)

    static func pair(light: Int, dark: Int) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? rgb(dark) : rgb(light) })
    }

    private static func rgb(_ hex: Int) -> UIColor {
        UIColor(
            red: CGFloat((hex >> 16) & 0xff) / 255,
            green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255,
            alpha: 1
        )
    }

    @MainActor
    static func configureNavigationBars() {
        let appearance = UINavigationBarAppearance()
        appearance.configureWithTransparentBackground()
        appearance.backgroundEffect = nil
        appearance.shadowColor = .clear
        appearance.titleTextAttributes = [.font: UIFont(name: "Pretendard-SemiBold", size: 17) ?? UIFont.systemFont(ofSize: 17), .foregroundColor: UIColor(ink)]
        let bar = UINavigationBar.appearance()
        bar.standardAppearance = appearance
        bar.scrollEdgeAppearance = appearance
        bar.compactAppearance = appearance
        bar.compactScrollEdgeAppearance = appearance
    }

    static func statusColor(_ status: String) -> Color {
        switch status {
        case "done": return success
        case "error", "failed": return failure
        case "pending": return secondary
        case "awaiting": return link
        default: return link
        }
    }
}

enum ThemeChoice: String, CaseIterable, Identifiable {
    case system, light, dark

    static let storageKey = "appearance"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: return UIText.t("시스템", "System")
        case .light: return UIText.t("밝게", "Light")
        case .dark: return UIText.t("어둡게", "Dark")
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

struct StatusBadge: View {
    @Environment(\.appearanceTokens) private var theme
    let status: String
    private var label: String {
        let labels = ["awaiting": "검토 대기", "pending": "대기 중", "summarizing": "요약 중",
                      "suggesting": "제안 중", "suggested": "제안 완료", "executing": "실행 중",
                      "done": "완료", "error": "오류", "failed": "실패", "running": "진행 중"]
        return UIText.t(labels[status] ?? status, status)
    }
    var body: some View {
        Text(label)
            .themeText(.badge)
            .padding(.horizontal, theme.value("badgePaddingX"))
            .padding(.vertical, theme.value("badgePaddingY"))
            .background(Theme.statusColor(status).opacity(0.15), in: RoundedRectangle(cornerRadius: theme.value("radiusPill")))
            .overlay(RoundedRectangle(cornerRadius: theme.value("radiusPill")).stroke(Theme.statusColor(status).opacity(0.35), lineWidth: 0.5))
            .foregroundStyle(Theme.statusColor(status))
    }
}

struct LiquidBackground: View {
    var body: some View {
        Theme.paper.ignoresSafeArea()
    }
}

struct GlassRow: ViewModifier {
    @Environment(\.appearanceTokens) private var theme
    private var cardShape: RoundedRectangle { RoundedRectangle(cornerRadius: theme.value("radiusCard"), style: .continuous) }
    func body(content: Content) -> some View {
        content
            .padding(.vertical, theme.value("cardPaddingY"))
            .padding(.horizontal, theme.value("cardPaddingX"))
            .background(Theme.card, in: cardShape)
            .overlay(cardShape.stroke(Color.primary.opacity(0.07), lineWidth: 0.5))
            .contentShape(cardShape)
    }
}

extension View {
    func liquidSurface() -> some View {
        modifier(LiquidSurface())
    }

    func inlineNavigationTitle() -> some View {
        modifier(InlineNavigationTitle())
    }

    func glassRow() -> some View { modifier(GlassRow()) }

    func glassRowLayout() -> some View {
        modifier(GlassRowLayout())
    }

    func liquidList() -> some View {
        modifier(LiquidList())
    }
}

private struct GlassRowLayout: ViewModifier {
    @Environment(\.appearanceTokens) private var theme
    func body(content: Content) -> some View {
        content.listRowInsets(EdgeInsets(top: 0, leading: theme.value("pagePadding"), bottom: 0, trailing: theme.value("pagePadding")))
            .listRowBackground(Color.clear).listRowSeparator(.hidden)
    }
}

private struct LiquidList: ViewModifier {
    @Environment(\.appearanceTokens) private var theme
    func body(content: Content) -> some View {
        content.listStyle(.plain).listRowSpacing(theme.value("cardGap"))
            .contentMargins(.bottom, theme.value("cardGap"), for: .scrollContent)
            .scrollContentBackground(.hidden).liquidSurface()
    }
}

struct ThemeActionStyle: ButtonStyle {
    @Environment(\.appearanceTokens) private var theme
    @Environment(\.isEnabled) private var enabled
    var prominent = false
    func makeBody(configuration: Configuration) -> some View {
        let tint = configuration.role == .destructive ? AnyShapeStyle(Theme.failure) : AnyShapeStyle(.tint)
        return configuration.label.themeText(.action)
            .padding(theme.value("actionPadding"))
            .frame(minHeight: theme.value("actionBox") * theme.scale)
            .background(tint.opacity(prominent ? 1 : 0.08), in: RoundedRectangle(cornerRadius: theme.value("radiusControl")))
            .foregroundStyle(prominent ? AnyShapeStyle(Theme.paper) : tint)
            .opacity(!enabled ? 0.45 : configuration.isPressed ? 0.6 : 1)
    }
}

private struct InlineNavigationTitle: ViewModifier {
    @Environment(\.self) private var environment

    func body(content: Content) -> some View {
        content
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color(Theme.paper.resolve(in: environment)), for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
    }
}

private struct LiquidSurface: ViewModifier {
    func body(content: Content) -> some View {
        surface(content)
            .scrollContentBackground(.hidden)
            .background(LiquidBackground())
    }

    @ViewBuilder
    private func surface(_ content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.scrollEdgeEffectHidden(true, for: .all)
        } else {
            content
        }
    }
}

struct LocalOrRemoteImage<Content: View>: View {
    let url: URL?
    @ViewBuilder var content: (AsyncImagePhase) -> Content

    var body: some View {
        if let url, url.isFileURL {
            if let image = UIImage(contentsOfFile: url.path) {
                content(.success(Image(uiImage: image)))
            } else {
                content(.failure(CocoaError(.fileReadCorruptFile)))
            }
        } else {
            AsyncImage(url: url, content: content)
        }
    }
}

struct HeldImage: View {
    @Environment(\.appearanceTokens) private var theme
    let url: URL?
    let height: CGFloat
    var top = false
    var failed = false

    var body: some View {
        LocalOrRemoteImage(url: url) { phase in
            if let image = phase.image {
                if top {
                    image.resizable().scaledToFill()
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                        .clipped()
                } else {
                    image.resizable().scaledToFit()
                }
            } else if failed || phase.error != nil {
                Image(systemName: "photo.badge.exclamationmark").foregroundStyle(Theme.secondary)
                    .accessibilityLabel(UIText.t("이미지를 불러오지 못했어요", "Image failed to load"))
            } else {
                Skeleton()
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .background(Color.primary.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: theme.value("radiusCard"), style: .continuous))
    }
}

struct Skeleton: View {
    @State private var lit = false

    var body: some View {
        Color.primary.opacity(lit ? 0.09 : 0.04)
            .animation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: lit)
            .onAppear { lit = true }
    }
}
