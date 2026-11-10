import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var shell: Shell
    @AppStorage(ThemeChoice.storageKey) private var appearance = ThemeChoice.system.rawValue
    @AppStorage(UIText.storageKey) private var language = UIText.lang
    @StateObject private var push = Push.shared
    @State private var agentLanguage = "en"
    @State private var loaded = false
    @State private var error: String?
    @State private var onboarding = false

    var body: some View {
        TabNavigationStack {
            Form {
                LiquidRefreshHeader()
                Section(UIText.t("화면", "Appearance")) {
                    NavigationLink(UIText.settings("Appearance")) { AppearanceSettingsView() }
                        .accessibilityIdentifier("settings.appearance")
                    SegmentedButtons(title: UIText.t("화면 언어", "Display language"), selection: $language, options: [
                        .init(id: "settings.language.ko", value: "ko", title: "한국어"),
                        .init(id: "settings.language.en", value: "en", title: "English")
                    ])
                    .onChange(of: language) { _, value in Task { await UIText.push(value) } }
                    SegmentedButtons(title: UIText.t("테마", "Theme"), selection: $appearance, options:
                        ThemeChoice.allCases.map { .init(id: "settings.theme.\($0.rawValue)", value: $0.rawValue, title: $0.label) })
                }
                Section(UIText.t("연결", "Connections")) {
                    NavigationLink(UIText.t("서버 연결", "Server connection")) { ServiceConnectionView() }
                        .accessibilityIdentifier("settings.connection")
                    NavigationLink(UIText.t("들어오고 나가는 곳", "Where content comes in and goes")) { ConnectionsView() }
                        .accessibilityIdentifier("settings.connections")
                    Button(UIText.t("온보딩 다시 보기", "Run onboarding again")) { onboarding = true }
                        .accessibilityIdentifier("settings.onboarding")
                }
                Section(UIText.t("Agent", "Agents")) {
                    SegmentedButtons(title: UIText.t("Agent가 쓰는 언어", "Agents write in"), selection: $agentLanguage,
                                     options: [("en", "English"), ("ko", "한국어"), ("ja", "日本語"), ("zh", "中文")].map {
                        .init(id: "settings.agent.\($0.0)", value: $0.0, title: $0.1)
                    }).loadingPlaceholder(!loaded)
                    .onChange(of: agentLanguage) { _, value in
                        guard loaded else { return }
                        Task { await save("settings:setLanguage", args: ["language": value]) }
                    }
                }
                Section(UIText.t("탭", "Tabs")) {
                    ForEach(AppTabsCatalog.modes, id: \.self) { key in
                        Toggle(UIText.tab(key), isOn: Binding(get: { !shell.hiddenTabs.contains(key) }, set: { enabled in
                            if enabled { shell.hiddenTabs.remove(key) } else { shell.hiddenTabs.insert(key) }
                            let tabs = AppTabsCatalog.modes.map { ["key": $0, "enabled": !shell.hiddenTabs.contains($0)] as [String: Any] }
                            Task { await save("settings:setTabs", args: ["tabs": tabs]) }
                        })).tint(Theme.ink).loadingPlaceholder(!loaded)
                    }
                }
                Section(UIText.t("알림", "Notifications")) {
                    switch push.state {
                    case .registered: Label(UIText.t("켜짐", "On"), systemImage: "bell.badge")
                    case .asking: ProgressView(UIText.t("요청 중…", "Requesting…"))
                    case .denied:
                        Text(UIText.t("iOS 설정에서 Openworks 알림을 켤 수 있어요.", "Enable Openworks notifications in iOS Settings."))
                    case .failed(let message): Text(message).foregroundStyle(Theme.failure)
                    default: Button(UIText.t("알림 켜기", "Turn on notifications")) { Task { await push.enable() } }
                    }
                }
                if let error { Section { LoadFailure(message: error) { Task { await load() } } } }
                Section(UIText.t("정보", "About")) {
                    LabeledContent(UIText.t("버전", "Version"), value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0")
                }
            }
            .liquidSurface().inlineNavigationTitle()
            .navigationTitle(UIText.t("설정", "Settings"))
            .accessibilityIdentifier("settings.scroll")
            .task { await load() }
            .liquidRefreshable { await load() }
            .fullScreenCover(isPresented: $onboarding) { OnboardingView { onboarding = false } }
        }
    }

    private func load() async {
        do {
            guard let settings = try await ConvexHTTP.query("settings:get") as? [String: Any] else { throw ConvexError.shape }
            agentLanguage = settings["language"] as? String ?? "en"
            shell.hiddenTabs = Set((settings["tabs"] as? [[String: Any]] ?? []).filter { $0["enabled"] as? Bool == false }.compactMap { $0["key"] as? String })
            error = nil
        } catch { self.error = error.localizedDescription }
        loaded = true
    }

    private func save(_ path: String, args: [String: Any]) async {
        do { try await ConvexHTTP.mutation(path, args: args); error = nil }
        catch { self.error = error.localizedDescription }
    }
}

struct ServiceConnectionView: View {
    @State private var url = DemoMode.isEnabled ? "" : ConvexHTTP.cloudURL
    @State private var key = DemoMode.isEnabled ? "" : ConvexHTTP.serviceKey
    @State private var checking = false
    @State private var count: Int?
    @State private var error: String?

    var body: some View {
        Form {
            Section(UIText.t("서버 연결", "Server connection")) {
                TextField(UIText.t("서버 주소", "Server URL"), text: $url)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityIdentifier("connection.url")
                SecureField(UIText.t("서비스 키", "Service key"), text: $key)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                Button(UIText.t("저장하고 연결 확인", "Save and test connection")) {
                    if !DemoMode.isEnabled {
                        ConvexHTTP.setURL(url.trimmingCharacters(in: .whitespacesAndNewlines))
                        ConvexHTTP.setServiceKey(key.trimmingCharacters(in: .whitespacesAndNewlines))
                    }
                    Task { await check() }
                }.disabled(checking || (!DemoMode.isEnabled && (url.isEmpty || key.isEmpty)))
            }
            Section {
                Text(UIText.t("서비스 키는 이 기기에 저장되며 지정한 서버로만 전송돼요.", "The service key is saved on this device and sent only to the server you configure."))
                    .themeText(.meta).foregroundStyle(Theme.secondary)
                if checking {
                    SkeletonText(role: .meta, width: 0.5)
                } else if let count {
                    Label(UIText.t("연결됨 · 뉴스레터 \(count)개", "Connected · \(count) newsletters"), systemImage: "checkmark.circle")
                }
                if let error { LoadFailure(message: error) { Task { await check() } } }
            }
        }
        .liquidSurface().inlineNavigationTitle()
        .navigationTitle(UIText.t("서버 연결", "Server connection"))
        .accessibilityIdentifier("connection.scroll")
    }

    private func check() async {
        checking = true
        defer { checking = false }
        do {
            guard let n = try await ConvexHTTP.query("jobs:count", args: ["type": "newsletter", "archived": false]) as? NSNumber else { throw ConvexError.shape }
            count = n.intValue
            error = nil
        } catch { count = nil; self.error = error.localizedDescription }
    }
}
