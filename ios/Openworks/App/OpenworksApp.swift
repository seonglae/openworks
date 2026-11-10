import SwiftUI

@main
struct OpenworksApp: App {
    @StateObject private var shell = Shell.shared
    @UIApplicationDelegateAdaptor(PushDelegate.self) private var pushDelegate
    @AppStorage(ThemeChoice.storageKey) private var appearance = ThemeChoice.system.rawValue
    @AppStorage(UIText.storageKey) private var language = UIText.lang

    init() {
        if DemoMode.isEnabled { UserDefaults.standard.removeObject(forKey: "plans.view") }
        Theme.configureNavigationBars()
    }

    var body: some Scene {
        WindowGroup {
            AppTabs()
                .environmentObject(shell)
                .modifier(AppearanceRoot())
                .foregroundStyle(Theme.ink)
                .tint(Theme.ink)
                .preferredColorScheme(ThemeChoice(rawValue: appearance)?.colorScheme)
                .environment(\.locale, UIText.locale)
                .task { await Push.shared.refreshState() }
        }
    }
}

enum AppTabsCatalog {
    static let modes = ["newsletter", "paper", "article", "pr", "plan", "research", "diet", "vocab", "insights", "usage"]
}

private struct AppTabs: View {
    @Environment(\.appearanceTokens) private var theme
    @EnvironmentObject private var shell: Shell
    @AppStorage(UIText.storageKey) private var language = UIText.lang
    @State private var onboarding = false
    @State private var openedJob: String?
    @State private var loadingSettings = false

    private var visible: [String] { AppTabsCatalog.modes.filter { !shell.hiddenTabs.contains($0) } }
    private var primary: [String] { Array(visible.prefix(4)) }
    private var selection: Binding<String> {
        Binding(get: { primary.contains(shell.tab) ? shell.tab : "more" }, set: { tab in
            let selected = primary.contains(shell.tab) ? shell.tab : "more"
            if selected != tab { shell.tab = tab }
        })
    }
    private var moreSelection: Binding<String?> {
        let selected = shell.tab != "more" && !primary.contains(shell.tab) ? shell.tab : nil
        return Binding(get: { selected }, set: { tab in
            guard shell.tab == selected else { return }
            shell.tab = tab ?? "more"
        })
    }

    var body: some View {
        TabView(selection: selection) {
            ForEach(primary, id: \.self) { key in
                Tab(UIText.tab(key), systemImage: icon(key), value: key) {
                    // Cached tabs must not expose rows or refresh anchors from
                    // pages that are no longer on screen.
                    destination(key)
                        .accessibilityHidden(shell.tab != key)
                }
            }
            Tab(UIText.t("더 보기", "More"), systemImage: "ellipsis", value: "more") {
                more.accessibilityHidden(selection.wrappedValue != "more")
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        .liquidSurface()
        .id("\(language)-\(shell.reloadID)")
        .background(TabSwipeNavigation(destinations: swipeDestinations) { shell.tab = $0 })
        .task { await syncSettings() }
        .onChange(of: shell.pendingJob) { _, id in
            guard let id else { return }
            Task {
                if let job = try? await ConvexHTTP.job(id: id), shell.reveal(job: job) {} else { openedJob = id }
                shell.pendingJob = nil
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .openOnboarding).receive(on: RunLoop.main)) { _ in onboarding = true }
        .fullScreenCover(isPresented: $onboarding) { OnboardingView { onboarding = false } }
        .sheet(item: Binding(get: { openedJob.map(OpenItem.init) }, set: { openedJob = $0?.id })) { item in
            NavigationStack {
                JobDetailView(jobId: item.id)
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button(UIText.t("닫기", "Close")) { openedJob = nil } } }
            }
        }
    }

    private var more: some View {
        NavigationStack {
            List {
                Section(UIText.t("목록", "Lists")) {
                    ForEach(visible, id: \.self) { row($0) }
                }
                Section(UIText.t("기타", "More")) {
                    ForEach(["dashboard", "mailbox", "drawings", "search", "settings"], id: \.self) { row($0) }
                }
            }
            .liquidList()
            .navigationTitle(UIText.t("더 보기", "More"))
            .inlineNavigationTitle()
            .accessibilityIdentifier("navigation.scroll")
            .navigationDestination(item: moreSelection) { key in
                destination(key).environment(\.tabNavigationHosted, true).id(key)
            }
        }
    }

    private func row(_ key: String) -> some View {
        Button { shell.tab = key } label: {
            HStack(alignment: .firstTextBaseline, spacing: theme.value("rowGap")) {
                Label(UIText.tab(key), systemImage: icon(key)).themeText(.title)
                Spacer()
                ListIcon(systemName: "chevron.right").foregroundStyle(Theme.secondary)
            }.glassRow()
        }
        .buttonStyle(.plain).glassRowLayout().accessibilityIdentifier("navigation.\(key)")
    }

    private func icon(_ key: String) -> String {
        switch key {
        case "dashboard": return "square.grid.2x2"
        case "settings": return "gearshape"
        case "search": return "magnifyingglass"
        case "drawings": return "scribble"
        default: return theme.icon("kind", key == "insights" ? "insight" : key)
        }
    }

    private var swipeDestinations: [String: String] {
        Dictionary(uniqueKeysWithValues: primary.map { (UIText.tab($0), $0) } + [(UIText.t("더 보기", "More"), "more")])
    }

    @ViewBuilder
    private func destination(_ key: String) -> some View {
        switch key {
        case "newsletter", "paper", "article": JobsTabView(type: key, title: UIText.tab(key))
        case "pr": PRView()
        case "plan": PlansView()
        case "research": ResearchView()
        case "diet": DietView()
        case "vocab": VocabView()
        case "insights": InsightsView()
        case "usage": UsageView()
        case "dashboard": DashboardView()
        case "authors": AuthorsView()
        case "mailbox": MailboxView()
        case "drawings": DrawingsView()
        case "search": SearchView()
        case "settings": SettingsView()
        default: EmptyView()
        }
    }

    private func syncSettings() async {
        guard !loadingSettings, !DemoMode.isEnabled, ConvexHTTP.configured else { return }
        loadingSettings = true
        defer { loadingSettings = false }
        if let state = await UIText.shellState() {
            shell.hiddenTabs = state.hidden
            if AppTabsCatalog.modes.contains(shell.tab), !visible.contains(shell.tab) { shell.tab = visible.first ?? "more" }
            onboarding = state.onboarding
        }
    }
}

private struct OpenItem: Identifiable { let id: String }
extension Notification.Name { static let openOnboarding = Notification.Name("openworks.openOnboarding") }
