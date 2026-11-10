import SwiftUI

struct ConnectorType: Identifiable {
    let key: String
    let label: String
    let directions: [String]
    let auth: [String]
    let connectOnly: Bool
    let blurb: (ko: String, en: String)
    var id: String { key }

    init?(_ json: [String: Any]) {
        guard let key = json["key"] as? String, let label = json["label"] as? String else { return nil }
        self.key = key
        self.label = label
        directions = json["directions"] as? [String] ?? []
        auth = json["auth"] as? [String] ?? []
        connectOnly = json["connectOnly"] as? Bool ?? false
        let blurb = json["blurb"] as? [String: String] ?? [:]
        self.blurb = (blurb["ko"] ?? "", blurb["en"] ?? "")
    }
}

@MainActor
final class ConnectionsModel: ObservableObject {
    @Published var types: [ConnectorType] = []
    @Published var rows: [[String: Any]] = []
    @Published var settings: [String: Any] = [:]
    @Published var checks: [String: [String: Any]] = [:]
    @Published var loaded = false
    @Published var error: String?

    func load() async {
        types = ConnectorCatalog.types
        do {
            async let rows = ConvexHTTP.query("connectors:list")
            async let settings = ConvexHTTP.query("settings:get")
            async let gh = ConvexHTTP.query("setup:latestByKind", args: ["kind": "verify_gh"])
            async let gws = ConvexHTTP.query("setup:latestByKind", args: ["kind": "verify_gws"])
            async let oauth = ConvexHTTP.query("setup:latestByKind", args: ["kind": "oauth_gh"])
            guard let loadedRows = try await rows as? [[String: Any]],
                  let loadedSettings = try await settings as? [String: Any] else { throw ConvexError.shape }
            self.rows = loadedRows
            self.settings = loadedSettings
            let githubChecks = try await [gh, oauth].compactMap { $0 as? [String: Any] }
            checks["gh"] = githubChecks.max { ($0["createdAt"] as? Double ?? 0) < ($1["createdAt"] as? Double ?? 0) }
            checks["gws"] = try await gws as? [String: Any]
            error = nil
        } catch { self.error = error.localizedDescription }
        loaded = true
    }

    func of(_ key: String) -> [[String: Any]] { rows.filter { ($0["type"] as? String) == key } }

    func state(_ type: ConnectorType) -> (label: String, color: Color) {
        let on = Theme.success, off = Theme.secondary
        if type.auth.contains("none") { return (UIText.t("항상 켜짐", "Always on"), on) }
        if type.key == "iphone" { return (UIText.t("이 기기 연결됨", "This phone"), on) }
        if type.key == "gmail" || type.key == "github" {
            let cli = settings[type.key == "gmail" ? "google" : "github"] as? [String: Any]
            return (cli?["loggedIn"] as? Bool) == true ? (UIText.t("연결됨", "Connected"), on) : (UIText.t("연결 안 됨", "Not connected"), off)
        }
        let statuses = of(type.key).compactMap { $0["status"] as? String }
        if statuses.contains("connected") {
            return (UIText.t("연결됨", "Connected"), on)
        }
        if statuses.contains("checking") { return (UIText.t("확인 중", "Checking"), Theme.link) }
        if statuses.contains("error") { return (UIText.t("확인 실패", "Check failed"), Theme.failure) }
        return (UIText.t("연결 안 됨", "Not connected"), off)
    }
}

struct ConnectorBadge: View {
    @Environment(\.appearanceTokens) private var theme
    let type: String

    private var mark: (asset: String, tint: Color?)? {
        switch type {
        case "notion": ("connector-notion", nil)
        case "obsidian": ("connector-obsidian", Color(hex: "#7C3AED"))
        case "gmail": ("connector-gmail", Color(hex: "#EA4335"))
        case "github": ("connector-github", nil)
        case "iphone": ("connector-apple", nil)
        default: nil
        }
    }

    var body: some View {
        Group {
            if let mark {
                Image(mark.asset).resizable().scaledToFit().frame(width: theme.value("iconSymbolSize") * theme.scale, height: theme.value("iconSymbolSize") * theme.scale)
                    .foregroundStyle(mark.tint ?? Theme.ink)
            } else {
                ListIcon(systemName: "link").foregroundStyle(Theme.ink)
            }
        }
        .frame(width: theme.value("iconBox") * theme.scale, height: theme.value("iconBox") * theme.scale)
        .alignmentGuide(.firstTextBaseline) { $0.height / 2 + theme.iconBaselineOffset }
        .background(Theme.paper, in: RoundedRectangle(cornerRadius: theme.value("radiusControl"), style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: theme.value("radiusControl"), style: .continuous).stroke(Color.primary.opacity(0.1)))
    }
}

struct ConnectionsView: View {
    @Environment(\.appearanceTokens) private var theme
    @StateObject private var model = ConnectionsModel()

    private struct Row: Identifiable {
        let direction: String
        let type: ConnectorType
        var id: String { "\(direction).\(type.key)" }
    }

    var body: some View {
        List {
                LiquidRefreshHeader()
            if let error = model.error { LoadFailure(message: error) { Task { await model.load() } }.glassRow().glassRowLayout() }
            ForEach([("input", "Input · 들어오는 것", "Input"), ("output", "Output · 나가는 것", "Output")], id: \.0) { direction, ko, en in
                Section {
                    ForEach(model.types.filter { $0.directions.contains(direction) }.map { Row(direction: direction, type: $0) }) { row in
                        ConnectorCard(type: row.type, model: model, accessibilityScope: row.direction).loadingPlaceholder(!model.loaded).glassRowLayout()
                    }
                } header: {
                    Text(UIText.t(ko, en)).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary).textCase(nil)
                }
            }
        }
        .liquidList()
        .accessibilityIdentifier("connections.scroll")
        .navigationTitle(UIText.t("연결", "Connections"))
        .inlineNavigationTitle()
        .liquidRefreshable { await model.load() }
        .task { await model.load() }
    }
}

struct ConnectorCard: View {
    @Environment(\.appearanceTokens) private var theme
    let type: ConnectorType
    @ObservedObject var model: ConnectionsModel
    var startOpen = false
    var accessibilityScope: String? = nil
    @State private var open: Bool?

    private var accessibilityKey: String {
        accessibilityScope.map { "\($0).\(type.key)" } ?? type.key
    }

    var body: some View {
        let state = model.state(type)
        VStack(alignment: .leading, spacing: theme.space(2.5)) {
            Button { open = !(open ?? startOpen) } label: {
                VStack(alignment: .leading, spacing: theme.value("rowTextGap")) {
                    HStack(alignment: .firstTextBaseline, spacing: theme.value("rowGap")) {
                        ConnectorBadge(type: type.key)
                        Text(type.label).themeText(.title)
                        Spacer(minLength: theme.space(2))
                        Text(state.label)
                            .themeText(.badge, design: .monospaced)
                            .lineLimit(1)
                            .padding(.horizontal, theme.value("badgePaddingX")).padding(.vertical, theme.value("badgePaddingY"))
                            .background(state.color.opacity(0.14), in: RoundedRectangle(cornerRadius: theme.value("radiusPill")))
                            .foregroundStyle(state.color)
                    }
                    Text(UIText.t(type.blurb.ko, type.blurb.en)).themeText(.meta).foregroundStyle(Theme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if type.connectOnly {
                        Text(UIText.t("읽기/쓰기는 준비 중이에요.", "Read and write support is coming."))
                            .themeText(.meta).foregroundStyle(Theme.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("connection.\(accessibilityKey)")
            .accessibilityValue((open ?? startOpen) ? UIText.t("펼침", "Expanded") : UIText.t("접힘", "Collapsed"))
            if open ?? startOpen {
                VStack(alignment: .leading, spacing: theme.space(2)) {
                    detail
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, theme.space(0.5))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("connection.details.\(accessibilityKey)")
            }
        }
        .glassRow()
    }

    @ViewBuilder
    private var detail: some View {
        switch type.key {
        case "notion": NotionConnect(model: model, state: model.state(type))
        case "obsidian": ObsidianConnect(model: model)
        case "gmail": CliConnect(cli: "gws", model: model)
        case "github": CliConnect(cli: "gh", model: model)
        case "iphone":
            Text(UIText.t("이 iPhone의 서비스 키로 연결합니다.",
                          "This iPhone connects using its service key."))
                .themeText(.meta).foregroundStyle(Theme.secondary)
        case "links":
            Text(UIText.t("읽기 목록의 + 버튼으로 링크나 글을 추가하세요. 별도 연결이 필요 없어요.",
                          "Use + in a reading list to add a link or text. No connection is needed."))
                .themeText(.meta).foregroundStyle(Theme.secondary)
        default:
            Text(UIText.t("웹 앱의 설정 → 연결에서 연결을 관리하세요.",
                          "Manage this connection in the web app under Settings → Connections."))
                .themeText(.meta).foregroundStyle(Theme.secondary)
        }
    }
}

private struct Field: View {
    @Environment(\.appearanceTokens) private var theme
    let placeholder: String
    let action: String
    var secret = false
    let submit: (String) async throws -> Void
    @State private var value = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space(1)) {
            HStack(spacing: theme.space(2)) {
                Group {
                    if secret { SecureField(placeholder, text: $value) } else { TextField(placeholder, text: $value) }
                }
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .themeText(.meta, design: .monospaced)
                .padding(.horizontal, theme.space(2.5)).padding(.vertical, theme.space(1.75))
                .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: theme.value("radiusControl")))
                Button {
                    busy = true
                    error = nil
                    Task {
                        do {
                            try await submit(value.trimmingCharacters(in: .whitespaces))
                            value = ""
                        } catch {
                            self.error = error.localizedDescription
                        }
                        busy = false
                    }
                } label: {
                    if busy { ProgressView() } else { Text(action).themeText(.meta) }
                }
                .buttonStyle(ThemeActionStyle())
                .disabled(busy || value.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if let error { LoadFailure(message: error) }
        }
    }
}

private struct NotionConnect: View {
    @Environment(\.appearanceTokens) private var theme
    @ObservedObject var model: ConnectionsModel
    let state: (label: String, color: Color)
    private var row: [String: Any]? {
        let rows = model.of("notion")
        return rows.first { $0["status"] as? String == "connected" } ?? rows.first
    }

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space(2.5)) {
            let connected = row?["status"] as? String == "connected"
            Label("Notion · \(state.label)",
                  systemImage: connected ? "checkmark.circle" : "link")
                .themeText(.meta)
                .foregroundStyle(state.color)
            Text(UIText.t("웹 앱의 설정 → 연결 → Output → Notion에서 연결하거나 설정을 관리하세요. 쓸 페이지에 Notion 연결 권한을 주고 루트 페이지를 선택한 뒤, 여기서 새로고침하세요.",
                          "To connect or manage settings, open Settings → Connections → Output → Notion in the web app. Grant access to the pages you want to use, choose a root page, then refresh here."))
                .themeText(.meta).foregroundStyle(Theme.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let row, (row["status"] as? String) == "connected" {
                HStack {
                    ListIcon(systemName: "checkmark").foregroundStyle(Theme.success)
                    Text((row["name"] as? String) ?? "Notion").themeText(.meta)
                    Text(authLabel(row["auth"] as? String)).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary)
                    Spacer()
                    if (row["auth"] as? String) != "env", let id = row["_id"] as? String {
                        Button(UIText.t("연결 해제", "Disconnect"), role: .destructive) {
                            Task {
                                do {
                                    _ = try await ConvexHTTP.mutation("connectors:remove", args: ["id": id])
                                    await model.load()
                                } catch { model.error = error.localizedDescription }
                            }
                        }
                        .themeText(.meta)
                    }
                }
                let root = (row["config"] as? [String: Any])?["rootPageId"] as? String
                Text(UIText.t("루트 페이지 ID", "Root page ID") + (root.map { " · \($0)" } ?? "")).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary)
                Field(placeholder: UIText.t("페이지 ID", "Page ID"), action: UIText.t("저장", "Save")) { value in
                    _ = try await ConvexHTTP.mutation("connectors:setNotionConfig", args: ["rootPageId": value])
                    await model.load()
                }
                if (row["auth"] as? String) == "env" {
                    DisclosureGroup(UIText.t("다른 방법으로 연결", "Connect another way")) {
                        connect.padding(.top, theme.space(1.5))
                    }
                    .themeText(.meta)
                }
            } else {
                connect
            }
        }
    }

    private var connect: some View {
        VStack(alignment: .leading, spacing: theme.space(2)) {
            Text(UIText.t("통합 토큰", "Integration token")).themeText(.meta).foregroundStyle(Theme.secondary)
            Field(placeholder: "ntn_…", action: UIText.t("연결", "Connect"), secret: true) { token in
                _ = try await ConvexHTTP.action("connectors:connectNotionToken", args: ["token": token])
                await model.load()
            }
            Text(UIText.t("Notion Developer portal에서 internal connection을 만들고, 쓸 페이지에 추가하세요",
                          "Make an internal connection in Notion's Developer portal and add it to the pages it should write to"))
                .themeText(.meta).foregroundStyle(Theme.secondary)
        }
    }

    private func authLabel(_ auth: String?) -> String {
        switch auth {
        case "oauth": "OAuth"
        default: UIText.t("통합 토큰", "Integration token")
        }
    }

}

private struct ObsidianConnect: View {
    @Environment(\.appearanceTokens) private var theme
    @ObservedObject var model: ConnectionsModel

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space(2)) {
            ForEach(Array(model.of("obsidian").enumerated()), id: \.offset) { _, vault in
                HStack(spacing: theme.space(2)) {
                    switch vault["status"] as? String {
                    case "connected": ListIcon(systemName: "checkmark").foregroundStyle(Theme.success)
                    case "checking": ProgressView()
                    default: ListIcon(systemName: "exclamationmark.triangle").foregroundStyle(Theme.failure)
                    }
                    VStack(alignment: .leading, spacing: theme.space(0.25)) {
                        Text(((vault["config"] as? [String: Any])?["vaultPath"] as? String) ?? "").themeText(.meta, design: .monospaced).lineLimit(1)
                        if let error = vault["error"] as? String { LoadFailure(message: error) }
                    }
                    Spacer()
                    if let id = vault["_id"] as? String {
                        Button(role: .destructive) {
                            Task {
                                do {
                                    _ = try await ConvexHTTP.mutation("connectors:remove", args: ["id": id])
                                    await model.load()
                                } catch { model.error = error.localizedDescription }
                            }
                        } label: { ListIcon(systemName: "trash") }
                        .buttonStyle(.plain)
                    }
                }
            }
            Text(UIText.t("보관함 폴더", "Vault folder")).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary)
            Field(placeholder: "~/Documents/Vault", action: UIText.t("연결", "Connect")) { path in
                _ = try await ConvexHTTP.mutation("connectors:addObsidian", args: ["vaultPath": path])
                await model.load()
            }
            Text(UIText.t("Openworks가 컴퓨터에서 vault 폴더를 확인합니다", "Openworks checks the vault folder on your computer"))
                .themeText(.meta).foregroundStyle(Theme.secondary)
        }
    }
}

private struct CliConnect: View {
    @Environment(\.appearanceTokens) private var theme
    let cli: String
    @ObservedObject var model: ConnectionsModel
    @State private var requesting = false

    private var latest: [String: Any]? { model.checks[cli] }
    private var running: Bool { ["pending", "running"].contains((latest?["status"] as? String) ?? "") }

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space(2)) {
            HStack(spacing: theme.space(2)) {
                Button { request(cli == "gh" ? "verify_gh" : "verify_gws") } label: {
                    if running { ProgressView() } else { Label(UIText.t("확인", "Check"), systemImage: "arrow.clockwise") }
                }
                if cli == "gh" {
                    Button(UIText.t("GitHub 로그인", "Sign in to GitHub")) { request("oauth_gh") }
                }
            }
            .buttonStyle(ThemeActionStyle())
            .themeText(.meta)
            .disabled(running || requesting)
            if let device = deviceCode {
                Text(UIText.t("\(device.uri)에서 이 코드를 넣으세요", "Enter this code at \(device.uri)")).themeText(.meta)
                Text(device.code).themeText(.heading, design: .monospaced).textSelection(.enabled)
            }
            if latest?["status"] as? String == "error" {
                LoadFailure(message: latest?["error"] as? String ?? UIText.t("연결 확인에 실패했어요.", "Connection check failed."))
            }
        }
        .task(id: running) {
            while running && !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                await model.load()
            }
        }
    }

    private var deviceCode: (code: String, uri: String)? {
        guard let raw = latest?["result"] as? String, let data = raw.data(using: .utf8),
              let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (result["stage"] as? String) == "device_code",
              let code = result["userCode"] as? String, let uri = result["verificationUri"] as? String else { return nil }
        return (code, uri)
    }

    private func request(_ kind: String) {
        requesting = true
        Task {
            defer { requesting = false }
            do {
                try await ConvexHTTP.mutation("setup:request", args: ["kind": kind])
                await model.load()
            } catch { model.error = error.localizedDescription }
        }
    }
}
