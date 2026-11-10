import SwiftUI

private let STEPS = ["language", "input", "output", "connect", "hobby"]
private let HOBBY_TABS: [(key: String, ko: String, en: String, icon: String)] = [
    ("article", "아티클", "Articles", "doc.richtext"),
    ("vocab", "단어", "Vocab", "character.book.closed"),
    ("diet", "식단", "Diet", "fork.knife"),
]
private let AGENT_LANGUAGES = [("en", "English"), ("ko", "한국어"), ("ja", "日本語"), ("zh", "中文")]

struct OnboardingView: View {
    @Environment(\.appearanceTokens) private var theme
    let onDone: () -> Void
    @StateObject private var connections = ConnectionsModel()
    @AppStorage(UIText.storageKey) private var uiLanguage = "ko"
    @State private var step = "language"
    @State private var inputs: [String] = ["links"]
    @State private var outputs: [String] = []
    @State private var agentLanguage = "en"
    @State private var tabs: [[String: Any]] = []
    @State private var finishing = false
    @State private var error: String?

    private func t(_ ko: String, _ en: String) -> String { uiLanguage == "en" ? en : ko }
    private var index: Int { STEPS.firstIndex(of: step) ?? 0 }

    private var title: (String, String) {
        switch step {
        case "language": (t("언어", "Language"), t("앱 화면과 agent가 쓰는 글의 언어", "For the app, and for what agents write"))
        case "input": (t("무엇이 들어오나요?", "What comes in?"), t("Input · 읽고 모으는 곳을 고르세요", "Pick where you read and collect from"))
        case "output": (t("어디로 내보내나요?", "Where does it go?"), t("Output · 정리한 것이 쌓일 곳을 고르세요", "Pick where what you work through should land"))
        case "connect": (t("연결하기", "Connect"), t("고른 곳마다 한 번씩 연결합니다. 나중에 설정에서 해도 됩니다", "Once for each place you picked. Settings can do it later too"))
        case "hobby": (t("취미", "Hobbies"), t("취미 섬에 둘 것을 고르세요", "What to keep on the hobby island"))
        default: (t("시작하기", "Get started"), "")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space(0)) {
            HStack(spacing: theme.space(1.25)) {
                ForEach(STEPS.indices, id: \.self) { i in
                    RoundedRectangle(cornerRadius: theme.value("radiusPill")).fill(i <= index ? Theme.ink : Theme.ink.opacity(0.12)).frame(height: 4)
                }
            }
            .padding(.bottom, theme.space(5.5))
            Text(title.0).themeText(.heading, design: .serif)
                .accessibilityIdentifier("onboarding.\(step)")
            Text(title.1).themeText(.title).foregroundStyle(Theme.secondary).padding(.top, theme.space(1)).padding(.bottom, theme.space(4.5))
            ScrollView {
                VStack(alignment: .leading, spacing: theme.space(2.5)) {
                    if let error = error ?? connections.error { LoadFailure(message: error) { Task { await seed() } } }
                    content
                }
                    .padding(.bottom, theme.space(3))
            }
            HStack {
                if index > 0 {
                    Button { go(STEPS[index - 1]) } label: { Label(t("이전", "Back"), systemImage: "arrow.left") }
                        .foregroundStyle(Theme.secondary)
                }
                Spacer()
                Button {
                    if step == "hobby" { finish() } else { go(STEPS[index + 1]) }
                } label: {
                    Label(step == "hobby" ? t("시작하기", "Start") : t("다음", "Next"),
                          systemImage: step == "hobby" ? "checkmark" : "arrow.right")
                        .padding(.horizontal, theme.space(1.5)).padding(.vertical, theme.space(1))
                }
                .buttonStyle(ThemeActionStyle(prominent: true))
                .tint(Theme.ink)
                .foregroundStyle(Theme.paper)
                .disabled(finishing)
                .accessibilityIdentifier("onboarding.\(step).next")
            }
            .padding(.top, theme.space(2))
        }
        .padding(theme.space(5))
        .background(Theme.paper.ignoresSafeArea())
        .task { await seed() }
    }

    @ViewBuilder
    private var content: some View {
        switch step {
        case "language":
            Text(t("앱 언어", "App language")).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary)
            ForEach([("en", "English"), ("ko", "한국어")], id: \.0) { code, label in
                choice(on: uiLanguage == code, icon: AnyView(tile("character.bubble")), title: label) {
                    uiLanguage = code
                    Task { await UIText.push(code) }
                }
            }
            Text(t("Agent가 쓰는 언어", "Agents write in")).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary).padding(.top, theme.space(2))
            ForEach(AGENT_LANGUAGES, id: \.0) { code, label in
                choice(on: agentLanguage == code, icon: AnyView(tile("character.bubble")), title: label) {
                    agentLanguage = code
                    Task {
                        do { _ = try await ConvexHTTP.mutation("settings:setLanguage", args: ["language": code]) } catch { self.error = error.localizedDescription }
                    }
                }
            }
        case "input", "output":
            let chosen = step == "input" ? inputs : outputs
            ForEach(connections.types.filter { $0.directions.contains(step) }) { type in
                let on = chosen.contains(type.key)
                choice(on: on, icon: AnyView(ConnectorBadge(type: type.key)), title: type.label,
                       detail: t(type.blurb.ko, type.blurb.en),
                       note: type.connectOnly ? t("연결까지만 · 읽기/쓰기는 준비 중", "Connects only; read and write coming") : nil) {
                    let next = on ? chosen.filter { $0 != type.key } : chosen + [type.key]
                    if step == "input" { inputs = next } else { outputs = next }
                }
                .accessibilityIdentifier("onboarding.\(step).choice.\(type.key)")
            }
        case "connect":
            let keys = Array(Set(inputs + outputs))
            let picked = connections.types.filter { keys.contains($0.key) && !$0.auth.contains("none") }
            if picked.isEmpty { Text(t("따로 연결할 것이 없습니다.", "Nothing to connect.")).foregroundStyle(Theme.secondary) }
            ForEach(picked) { type in
                ConnectorCard(type: type, model: connections, startOpen: true)
            }
        case "hobby":
            ForEach(HOBBY_TABS, id: \.key) { tab in
                let on = (tabs.first { ($0["key"] as? String) == tab.key }?["enabled"] as? Bool) ?? false
                choice(on: on, icon: AnyView(tile(tab.icon)), title: t(tab.ko, tab.en)) { toggle(tab.key) }
            }
        default: EmptyView()
        }
    }

    private func tile(_ symbol: String) -> some View {
        ListIcon(systemName: symbol).foregroundStyle(Theme.ink)
            .background(Theme.paper, in: RoundedRectangle(cornerRadius: theme.value("radiusControl"), style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: theme.value("radiusControl"), style: .continuous).stroke(Color.primary.opacity(0.1)))
    }

    private func choice(on: Bool, icon: AnyView, title: String, detail: String? = nil, note: String? = nil,
                        action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: theme.value("rowGap")) {
                icon
                VStack(alignment: .leading, spacing: theme.value("rowTextGap")) {
                    Text(title).themeText(.title)
                    if let detail { Text(detail).themeText(.meta).foregroundStyle(Theme.secondary) }
                    if let note { Text(note).themeText(.meta).foregroundStyle(Theme.secondary) }
                }
                Spacer()
                ListIcon(systemName: on ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(on ? Theme.ink : Theme.secondary.opacity(0.5))
            }
            .padding(theme.space(3))
            .background(on ? Theme.ink.opacity(0.05) : Theme.card, in: RoundedRectangle(cornerRadius: theme.value("radiusCard"), style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: theme.value("radiusCard"), style: .continuous).stroke(on ? Theme.ink.opacity(0.5) : Color.primary.opacity(0.08)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func seed() async {
        await connections.load()
        let settings = connections.settings
        if let saved = settings["onboarding"] as? [String: Any] {
            let ins = saved["inputs"] as? [String] ?? []
            if !ins.isEmpty { inputs = ins }
            outputs = saved["outputs"] as? [String] ?? []
        }
        agentLanguage = (settings["language"] as? String) ?? "en"
        tabs = settings["tabs"] as? [[String: Any]] ?? AppTabsCatalog.modes.map { ["key": $0, "enabled": true] as [String: Any] }
    }

    private func save(done: Bool = false) async throws {
        var args: [String: Any] = ["inputs": inputs, "outputs": outputs]
        if done { args["done"] = true }
        _ = try await ConvexHTTP.mutation("settings:saveOnboarding", args: args)
    }

    private func go(_ next: String) {
        step = next
        Task {
            do { try await save(); error = nil } catch { self.error = error.localizedDescription }
        }
    }

    private func toggle(_ key: String) {
        tabs = tabs.map { tab in
            guard (tab["key"] as? String) == key else { return tab }
            var copy = tab
            copy["enabled"] = !((tab["enabled"] as? Bool) ?? false)
            return copy
        }
        let payload = tabs.map { ["key": $0["key"] as? String ?? "", "enabled": $0["enabled"] as? Bool ?? false] }
        Task {
            do { _ = try await ConvexHTTP.mutation("settings:setTabs", args: ["tabs": payload]) } catch { self.error = error.localizedDescription }
        }
    }

    private func finish() {
        finishing = true
        Task {
            do { try await save(done: true); onDone() } catch { self.error = error.localizedDescription }
            finishing = false
        }
    }
}
