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
