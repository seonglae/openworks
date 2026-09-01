import SwiftUI
import UIKit

// The browser's palette: rust on warm paper, with slate and sage kept for the
// things they name rather than for emphasis. Shared with quire to the hex, so a
// reader who uses both apps does not have to learn two palettes.
enum Theme {
    // Each accent is a pair, never a single constant: values picked for white
    // paper leave a dark screen with pills you cannot read. The two halves flip
    // together so both schemes stay legible.
    static let slate = pair(light: 0x3d_5a_80, dark: 0x8a_a9_d0)
    static let sage = pair(light: 0x5a_7a_5a, dark: 0x8f_b0_8f)
    static let rust = pair(light: 0xa9_3a_20, dark: 0xd9_60_3e)
    static let rustBright = pair(light: 0xcf_54_35, dark: 0xef_82_61)
    // A link should not be the system's cornflower blue, which belongs to no
    // palette here, nor slate, which already means "structure".
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

    // Job type -> its one word, and the colour the browser gives it.
    static func typeColor(_ type: String) -> Color {
        switch type {
        case "paper": return slate
        case "article": return sage
        case "newsletter": return rust
        default: return .secondary
        }
    }

    static func statusColor(_ status: String) -> Color {
        switch status {
        case "done": return .green
        case "failed", "error": return .red
        case "processing", "running": return rustBright
        default: return .secondary
        }
    }

    // Research phase. Late phases read warmer, so a stalled project is visible
    // in a list without reading a single title.
    static func phaseColor(_ phase: String) -> Color {
        switch phase {
        case "idea", "exploring": return .secondary
        case "running", "writing": return slate
        case "review", "submitted": return .orange
        case "accepted", "published", "done": return sage
        default: return .secondary
        }
    }
}

struct Pill: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(color.opacity(0.12), in: Capsule())
            .overlay(Capsule().stroke(color.opacity(0.3), lineWidth: 0.5))
            .foregroundStyle(color)
    }
}

func relAge(_ epochMs: Double) -> String {
    guard epochMs > 0 else { return String(localized: "never") }
    let d = Date().timeIntervalSince1970 - epochMs / 1000
    if d < 60 { return String(localized: "just now") }
    if d < 3600 { return String(format: String(localized: "%d min ago"), Int(d / 60)) }
    if d < 86400 { return String(format: String(localized: "%d h ago"), Int(d / 3600)) }
    return String(format: String(localized: "%d d ago"), Int(d / 86400))
}

// A yyyy-mm-dd plan date, read in the reader's own calendar.
func planDayLabel(_ iso: String) -> String {
    let parser = DateFormatter()
    parser.dateFormat = "yyyy-MM-dd"
    parser.locale = Locale(identifier: "en_US_POSIX")
    guard let date = parser.date(from: iso) else { return iso }
    let cal = Calendar.current
    let days = cal.dateComponents([.day], from: cal.startOfDay(for: Date()), to: cal.startOfDay(for: date)).day ?? 0
    let out = DateFormatter()
    out.locale = Locale.autoupdatingCurrent
    out.dateFormat = "EEE d MMM"
    let label = out.string(from: date)
    if days == 0 { return String(localized: "Today") + " · " + label }
    if days == 1 { return String(localized: "Tomorrow") + " · " + label }
    return label
}

func todayISO() -> String {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    f.locale = Locale(identifier: "en_US_POSIX")
    return f.string(from: Date())
}

// Every screen loads the same way, so it fails the same way too.
struct LoadState<Content: View>: View {
    let configured: Bool
    let error: String?
    let empty: Bool
    let emptyTitle: LocalizedStringKey
    let emptyHint: LocalizedStringKey
    let loading: Bool
    @ViewBuilder let content: () -> Content

    var body: some View {
        if !configured {
            ContentUnavailableView("Setup needed", systemImage: "gearshape",
                                   description: Text("Enter the deployment URL and service key in Settings."))
        } else if let error {
            ContentUnavailableView("Could not load", systemImage: "wifi.exclamationmark", description: Text(error))
        } else if empty && !loading {
            ContentUnavailableView(emptyTitle, systemImage: "tray", description: Text(emptyHint))
        } else {
            content()
        }
    }
}


// Light / dark / follow the phone. Stored rather than derived because the
// point of the setting is to disagree with the system when the reader wants to.
enum ThemeChoice: String, CaseIterable, Identifiable {
    case system, light, dark

    static let storageKey = "appearance"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: return "System"
        case .light: return "Light"
        case .dark: return "Dark"
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

// A link the reader can tell where it goes before tapping it, in a colour
// that belongs to this palette.
struct LinkRow: View {
    let url: URL

    private var host: String {
        (url.host ?? url.absoluteString).replacingOccurrences(of: "www.", with: "")
    }

    private var trailing: String? {
        var rest = url.path
        if let query = url.query, !query.isEmpty { rest += "?" + query }
        return rest.isEmpty || rest == "/" ? nil : rest
    }

    var body: some View {
        Link(destination: url) {
            VStack(alignment: .leading, spacing: 1) {
                Text(host).font(.caption.weight(.medium)).underline()
                if let trailing {
                    Text(trailing).font(.caption2).lineLimit(2).truncationMode(.middle)
                }
            }
        }
        .foregroundStyle(Theme.link)
    }
}


// The panel these two stats screens draw on. The rest of the app uses plain
// list sections, so this is the one place that needs a surface of its own.
struct CardSurface: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground),
                        in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

extension View {
    func cardSurface() -> some View { modifier(CardSurface()) }
}


// Air between the last row and the floating tab bar, not clearance: the
// TabView already reserves the bar (the measurement is on it). One list gap of
// it, so the bar reads as the next thing after the last row rather than a wall
// the list stops an arbitrary distance short of.
private let ROW_GAP: CGFloat = 8

extension View {
    func tabBarGap() -> some View {
        contentMargins(.bottom, ROW_GAP, for: .scrollContent)
    }
}
