import SwiftUI
import UIKit
import UserNotifications

// Getting the phone an APNs token and handing it to the deployment.
//
// The backend already broadcasts on a summary landing; before this it could
// only reach a browser, because `convex/push.ts` is Web Push and a native app
// cannot subscribe to that. The device token is the native half of the same
// moment, and `push:registerDevice` is where it lands.
//
// Nothing here asks for permission on launch. A notification prompt on first
// open, before the app has shown anything worth being notified about, is the
// one that gets denied permanently, and iOS only asks once. Settings has a
// switch instead.
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

    // Sandbox or production is a property of how the binary was signed, not of
    // the phone, and APNs answers BadDeviceToken when a token is sent to the
    // wrong host. Xcode-to-device and TestFlight differ here, so the app reports
    // what its own entitlement says rather than letting the server guess.
    private var environment: String {
        #if DEBUG
            return "sandbox"
        #else
            return apsEnvironmentFromEntitlements() ?? "production"
        #endif
    }

    private var bundleId: String { Bundle.main.bundleIdentifier ?? "dev.openworks.ios" }

    func refreshState() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            // Authorised is not the same as registered: the token arrives from
            // APNs asynchronously and is not persisted across reinstalls.
            if case .registered = state {} else { state = .off }
            UIApplication.shared.registerForRemoteNotifications()
        case .denied:
            state = .denied
        default:
            state = .off
        }
    }

    func enable() async {
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

    // Called by the app delegate once APNs answers.
    func received(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task {
            do {
                _ = try await Convex.mutation(
                    "push:registerDevice",
                    [
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

// iOS has no API for reading your own entitlements (SecTaskCopyValueForEntitlement
// is macOS), so this reads the provisioning profile that ships inside the app
// and takes the aps-environment out of it. The profile is a CMS blob with a
// plain plist in the middle, which is why this scans for the plist rather than
// parsing the container.
//
// An App Store build has no embedded profile at all, and that absence is itself
// the answer: only App Store and TestFlight builds lack one, and both use the
// production host.
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

// UIApplicationDelegate is what APNs calls back on; SwiftUI has no equivalent,
// so the App adapts one in rather than owning the callbacks itself.
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

    // A push that lands while the app is open should still be seen: the default
    // is to swallow it, which reads as notifications being broken.
    func userNotificationCenter(
        _: UNUserNotificationCenter,
        willPresent _: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    // Tapping one opens the queue, which is what every notification this sends
    // is about.
    func userNotificationCenter(
        _: UNUserNotificationCenter,
        didReceive _: UNNotificationResponse
    ) async {
        await MainActor.run { AppState.shared.tab = .reading }
    }
}
