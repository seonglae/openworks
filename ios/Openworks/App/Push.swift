import SwiftUI
import UIKit
import UserNotifications

@MainActor
final class Push: NSObject, ObservableObject {
    static let shared = Push()

    enum State: Equatable {
        case unknown
        case off
        case asking
        case registered(String)
        case denied
        case failed(String)
    }

    @Published private(set) var state: State = .unknown

    private var environment: String {
        #if DEBUG
            return "sandbox"
        #else
            return apsEnvironmentFromEntitlements() ?? "production"
        #endif
    }

    private var bundleId: String { Bundle.main.bundleIdentifier ?? "dev.openworks.ios" }

    func refreshState() async {
        guard !DemoMode.isEnabled else { return }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            if case .registered = state {} else { state = .off }
            UIApplication.shared.registerForRemoteNotifications()
        case .denied:
            state = .denied
        default:
            state = .off
        }
    }

    func enable() async {
        guard !DemoMode.isEnabled else { return }
        state = .asking
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            guard granted else {
                state = .denied
                return
            }
            UIApplication.shared.registerForRemoteNotifications()
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    func received(deviceToken: Data) {
        guard !DemoMode.isEnabled else { return }
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task {
            do {
                _ = try await ConvexHTTP.mutation(
                    "push:registerDevice",
                    args: [
                        "token": hex,
                        "environment": environment,
                        "bundleId": bundleId,
                        "label": UIDevice.current.name,
                    ]
                )
                state = .registered(hex)
            } catch {
                state = .failed(error.localizedDescription)
            }
        }
    }

    func failed(_ error: Error) {
        state = .failed(error.localizedDescription)
    }
}

private func apsEnvironmentFromEntitlements() -> String? {
    guard let path = Bundle.main.path(forResource: "embedded", ofType: "mobileprovision") else {
        return "production"
    }
    guard let raw = try? Data(contentsOf: URL(fileURLWithPath: path)),
          let text = String(data: raw, encoding: .isoLatin1),
          let start = text.range(of: "<?xml"),
          let end = text.range(of: "</plist>")
    else { return nil }
    let plist = String(text[start.lowerBound..<end.upperBound])
    guard let data = plist.data(using: .isoLatin1),
          let parsed = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
          let entitlements = parsed["Entitlements"] as? [String: Any],
          let aps = entitlements["aps-environment"] as? String
    else { return nil }
    return aps == "development" ? "sandbox" : "production"
}

final class PushDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _: UIApplication,
        didFinishLaunchingWithOptions _: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
        Task { @MainActor in Push.shared.received(deviceToken: token) }
    }

    func application(_: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in Push.shared.failed(error) }
    }

    func userNotificationCenter(
        _: UNUserNotificationCenter,
        willPresent _: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    func userNotificationCenter(
        _: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let payload = response.notification.request.content.userInfo
        let destination = pushDestination(payload)
        await MainActor.run {
            if let id = destination.item { Shell.shared.pendingJob = id }
            else { Shell.shared.tab = destination.tab ?? "newsletter" }
        }
    }
}

func pushDestination(_ payload: [AnyHashable: Any]) -> (item: String?, tab: String?) {
    let query = URLComponents(string: payload["url"] as? String ?? "")?.queryItems ?? []
    let values = Dictionary(query.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { first, _ in first })
    let item = (payload["jobId"] as? String ?? values["item"]).flatMap { $0.isEmpty ? nil : $0 }
    let tab = values["tab"].flatMap { (AppTabsCatalog.modes + ["search", "settings", "authors", "mailbox", "drawings", "dashboard"]).contains($0) ? $0 : nil }
    return (item, tab)
}
