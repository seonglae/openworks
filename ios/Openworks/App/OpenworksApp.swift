import SwiftUI

// Openworks on the phone. Native SwiftUI over the same Convex backend the
// browser reads, not a window pointing at the web app: the phone gets the
// three surfaces that are worth having in a pocket, and the desktop keeps the
// ones that need a keyboard (the drawing surface, LaTeX, the tab graph).
enum Tab: Hashable { case reading, plan, research, settings }

@MainActor
final class AppState: ObservableObject {
    static let shared = AppState()
    @Published var tab: Tab = .reading
    @Published var reloadNonce = 0
    func reloadAll() { reloadNonce += 1 }
}

@main
struct OpenworksApp: App {
    @StateObject private var state = AppState.shared
    // APNs calls back on a UIApplicationDelegate and SwiftUI has none, so one
    // is adapted in for the token handoff.
    @UIApplicationDelegateAdaptor(PushDelegate.self) private var pushDelegate
    @AppStorage(ThemeChoice.storageKey) private var appearance = ThemeChoice.system.rawValue

    var body: some Scene {
        WindowGroup {
            // The bar floats over its tabs, and reserving room for it is this
            // view's job, not theirs. Measured: a plain List under a
            // NavigationStack in here reports safeAreaInsets.bottom = 83 on an
            // iPhone 17 Pro, 34 of it the home indicator and the rest the bar,
            // and the same 83 from a differently-shaped list in another app, so
            // it comes from the TabView and not from any list's own shape.
            // Nothing below has to clear the bar by hand; tabBarGap() adds air
            // on top of this, and says how much.
            TabView(selection: $state.tab) {
                ReadingView()
                    .tabItem { Label("Reading", systemImage: "text.book.closed") }
                    .tag(Tab.reading)
                PlanView()
                    .tabItem { Label("Plan", systemImage: "checklist") }
                    .tag(Tab.plan)
                ResearchView()
                    .tabItem { Label("Research", systemImage: "flask") }
                    .tag(Tab.research)
                SettingsView()
                    .tabItem { Label("Settings", systemImage: "gearshape") }
                    .tag(Tab.settings)
            }
            .tint(Theme.rust)
            .preferredColorScheme(ThemeChoice(rawValue: appearance)?.colorScheme)
            .environmentObject(state)
            .task { await Push.shared.refreshState() }
        }
    }
}
