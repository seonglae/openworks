import SwiftUI

// The browser's palette: ink on paper, slate as the one accent, sage for done.
// Monochrome on purpose, so the only colour on a screen means something.
enum Theme {
    static let slate = Color(red: 0x3d / 255, green: 0x5a / 255, blue: 0x80 / 255)
    static let sage = Color(red: 0x5a / 255, green: 0x7a / 255, blue: 0x5a / 255)
    static let rust = Color(red: 0x33 / 255, green: 0x33 / 255, blue: 0x33 / 255)

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
        case "done": return sage
        case "failed", "error": return .red
        case "processing", "running": return slate
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
