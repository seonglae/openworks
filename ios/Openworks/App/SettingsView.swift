import SwiftUI

// The connection, and nothing else. The deployment URL and the owner service
// key are baked in at build time from Secrets.xcconfig; anything entered here
// overrides on this device only and never leaves it.
struct SettingsView: View {
    @EnvironmentObject var state: AppState
    @State private var url = Convex.cloudURL
    @State private var key = Convex.serviceKey
    @State private var msg: String?
    @State private var reached: Int?
    @State private var checking = false
    @StateObject private var push = Push.shared

    var body: some View {
        NavigationStack {
            Form {
                Section("Deployment") {
                    if let reached {
                        LabeledContent("Status") {
                            Text("Reachable").foregroundStyle(Theme.sage)
                        }
                        LabeledContent("Newsletters", value: "\(reached)")
                    } else {
                        Text(Convex.configured ? "Not checked yet." : "No deployment configured.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Button {
                        Task { await check() }
                    } label: { Text(checking ? "Checking…" : "Test connection") }
                    .disabled(checking || !Convex.configured)
                }

                Section {
                    TextField("Deployment URL", text: $url)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    SecureField("Service key", text: $key)
                    Button("Save") {
                        Convex.setURL(url.trimmingCharacters(in: .whitespacesAndNewlines))
                        Convex.setServiceKey(key.trimmingCharacters(in: .whitespacesAndNewlines))
                        msg = String(localized: "Saved")
                        state.reloadAll()
                        Task { await check() }
                    }
                } header: {
                    Text("Connection")
                } footer: {
                    Text("Ends in .convex.cloud. The key is OPENWORKS_SERVICE_KEY on that deployment; it is stored on this device and sent nowhere else.")
                }

                Section {
                    switch push.state {
                    case .registered:
                        LabeledContent("Notifications") { Text("On").foregroundStyle(Theme.sage) }
                    case .asking:
                        Text("Asking…").font(.caption).foregroundStyle(.secondary)
                    case .denied:
                        // Once iOS has a denial it will not ask again, so the
                        // only way back is Settings, and saying so beats a
                        // button that silently does nothing.
                        Text("Denied. Turn them back on in iOS Settings → Openworks → Notifications.")
                            .font(.caption).foregroundStyle(.secondary)
                    case let .failed(reason):
                        Text(reason).font(.caption).foregroundStyle(Theme.rust)
                    case .off, .unknown:
                        Button("Turn on notifications") { Task { await push.enable() } }
                            .disabled(!Convex.configured)
                    }
                } header: {
                    Text("Notifications")
                } footer: {
                    Text("A push when a summary lands. The phone registers with this deployment, which needs an APNs key configured on it.")
                }

                if let msg {
                    Section { Text(msg).font(.caption).foregroundStyle(.secondary) }
                }

                Section("About") {
                    LabeledContent("Version", value: versionLabel)
                    Link("openworksai.app", destination: URL(string: "https://openworksai.app")!)
                }
            }
            .navigationTitle("Settings")
            .task { await check() }
        }
    }

    var versionLabel: String {
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "\(short) (\(build))"
    }

    func check() async {
        guard Convex.configured else { return }
        checking = true
        defer { checking = false }
        do {
            reached = try await Convex.reachable()
            msg = nil
        } catch {
            reached = nil
            msg = error.localizedDescription
        }
    }
}
