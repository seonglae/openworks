import SwiftUI
import UIKit

struct TabSwipeNavigation: UIViewControllerRepresentable {
    let destinations: [String: String]
    let select: (String) -> Void

    func makeUIViewController(context: Context) -> Controller { Controller() }

    func updateUIViewController(_ controller: Controller, context: Context) {
        controller.destinations = destinations
        controller.select = select
        DispatchQueue.main.async { controller.install() }
    }

    final class Controller: UIViewController, UIGestureRecognizerDelegate {
        var destinations: [String: String] = [:]
        var select: ((String) -> Void)?
        private weak var tabs: UITabBarController?
        private lazy var pan: UIPanGestureRecognizer = {
            let gesture = UIPanGestureRecognizer(target: self, action: #selector(swiped(_:)))
            gesture.delegate = self
            gesture.cancelsTouchesInView = false
            gesture.maximumNumberOfTouches = 1
            return gesture
        }()

        override func loadView() {
            view = UIView()
            view.isUserInteractionEnabled = false
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            install()
        }

        private func tabController(in controller: UIViewController) -> UITabBarController? {
            if let tabs = controller as? UITabBarController { return tabs }
            return controller.children.lazy.compactMap { self.tabController(in: $0) }.first
        }

        func install() {
            guard let root = view.window?.rootViewController, let found = tabController(in: root), tabs !== found else { return }
            pan.view?.removeGestureRecognizer(pan)
            tabs = found
            found.view.addGestureRecognizer(pan)
        }

        private func isAwayFromRoot(_ controller: UIViewController) -> Bool {
            if controller.presentedViewController != nil { return true }
            if let navigation = controller as? UINavigationController, navigation.viewControllers.count > 1 { return true }
            return controller.children.contains { isAwayFromRoot($0) }
        }

        private func isNavigationPopGesture(_ gesture: UIGestureRecognizer, on view: UIView) -> Bool {
            var responder: UIResponder? = view
            while let current = responder {
                if let navigation = current as? UINavigationController {
                    if gesture === navigation.interactivePopGestureRecognizer { return true }
                    if #available(iOS 26.0, *) {
                        return gesture === navigation.interactiveContentPopGestureRecognizer
                    }
                    return false
                }
                responder = current.next
            }
            return false
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            guard let tabs, let selected = tabs.selectedViewController,
                  tabs.presentedViewController == nil, !isAwayFromRoot(selected) else { return false }
            let point = touch.location(in: tabs.view)
            guard point.x > 28, point.x < tabs.view.bounds.width - 28 else { return false }
            var hit = touch.view
            while let view = hit, view !== tabs.view {
                if view is UITableViewCell || view is UICollectionViewCell || view is UIControl { return false }
                if let scroll = view as? UIScrollView,
                   scroll.alwaysBounceHorizontal || scroll.contentSize.width > scroll.bounds.width + 1 { return false }
                if view.gestureRecognizers?.contains(where: {
                    $0 !== pan && $0 is UIPanGestureRecognizer && !(view is UIScrollView)
                        && !isNavigationPopGesture($0, on: view)
                }) == true { return false }
                hit = view.superview
            }
            return true
        }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let tabs else { return false }
            let velocity = pan.velocity(in: tabs.view)
            return abs(velocity.x) > abs(velocity.y) * 1.5
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            guard let scroll = other.view as? UIScrollView else { return false }
            return !scroll.alwaysBounceHorizontal && scroll.contentSize.width <= scroll.bounds.width + 1
        }

        @objc private func swiped(_ gesture: UIPanGestureRecognizer) {
            guard gesture.state == .ended, let tabs,
                  abs(gesture.translation(in: tabs.view).x) > 70,
                  let items = tabs.tabBar.items,
                  let selected = tabs.tabBar.selectedItem,
                  let index = items.firstIndex(of: selected) else { return }
            let translation = gesture.translation(in: tabs.view)
            guard abs(translation.x) > abs(translation.y) * 1.5 else { return }
            let next = index + (translation.x < 0 ? 1 : -1)
            guard items.indices.contains(next), let title = items[next].title,
                  let destination = destinations[title] else { return }
            select?(destination)
        }
    }
}
