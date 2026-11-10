import SwiftUI

@MainActor
final class Shell: ObservableObject {
    static let shared = Shell()
    @Published var tab = DemoMode.initialTab
    @Published var reloadID = UUID()
    @Published var pendingJob: String?
    struct ListTarget {
        let request = UUID()
        let id: String
        let type: String
        let archived: Bool
    }
    @Published var listTarget: ListTarget?

    @discardableResult
    func reveal(job: [String: Any]) -> Bool {
        guard let id = job["_id"] as? String, let type = job["type"] as? String,
              ["article", "paper", "newsletter"].contains(type),
              job["status"] as? String != "awaiting" else { return false }
        bands.removeValue(forKey: type)
        hiddenTabs.remove(type)
        listTarget = ListTarget(id: id, type: type, archived: job["archived"] as? Bool ?? false)
        tab = type
        return true
    }
    @Published var hiddenTabs: Set<String> = []
    @Published private(set) var bands: [String: ClosedRange<Double>] = [:]

    func band(_ kind: String) -> ClosedRange<Double>? { bands[kind] }

    func apply(kind: String, band: ClosedRange<Double>?) {
        if let band { bands[kind] = band } else { bands.removeValue(forKey: kind) }
        tab = kind
    }

    func clear(_ kind: String) { bands.removeValue(forKey: kind) }
}

func bandLabel(_ band: ClosedRange<Double>) -> String {
    let lo = String(format: "%.1f", band.lowerBound)
    let hi = String(format: "%.1f", band.upperBound)
    return lo == hi ? lo : "\(lo)–\(hi)"
}

private struct TabNavigationHostedKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var tabNavigationHosted: Bool {
        get { self[TabNavigationHostedKey.self] }
        set { self[TabNavigationHostedKey.self] = newValue }
    }
}

struct TabNavigationStack<Content: View>: View {
    @Environment(\.tabNavigationHosted) private var hosted
    private let content: Content
    init(@ViewBuilder content: () -> Content) { self.content = content() }
    var body: some View {
        if hosted {
            content.liquidSurface().inlineNavigationTitle()
        } else {
            NavigationStack { content.liquidSurface().inlineNavigationTitle() }
        }
    }
}

func calendarDay(_ date: Date = Date()) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: date)
}
