import SwiftUI
import UIKit

private struct LiquidRefreshConfiguration {
    let identifier: String
    let action: @MainActor () async -> Void
}

private struct LiquidRefreshKey: EnvironmentKey {
    static let defaultValue: LiquidRefreshConfiguration? = nil
}

private extension EnvironmentValues {
    var liquidRefresh: LiquidRefreshConfiguration? {
        get { self[LiquidRefreshKey.self] }
        set { self[LiquidRefreshKey.self] = newValue }
    }
}

struct LiquidRefreshHeader: View {
    @Environment(\.liquidRefresh) private var configuration

    var body: some View {
        RefreshAnchor(configuration: configuration)
            .frame(height: 0)
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .environment(\.defaultMinListRowHeight, 0)
    }
}

private struct RefreshAnchor: UIViewRepresentable {
    let configuration: LiquidRefreshConfiguration?

    func makeUIView(context: Context) -> AnchorView {
        AnchorView(configuration: configuration)
    }

    func updateUIView(_ view: AnchorView, context: Context) {
        view.configuration = configuration
        view.attach()
    }

    static func dismantleUIView(_ view: AnchorView, coordinator: ()) {
        view.detach()
    }

    final class AnchorView: UIView {
        var configuration: LiquidRefreshConfiguration?
        private weak var scroll: UIScrollView?
        private let spinner = SpinnerView()
        private var observation: NSKeyValueObservation?
        private var work: Task<Void, Never>?
        private var refreshing = false
        private var addedInset: CGFloat = 0
        private var acceptsPull = false
        private let threshold: CGFloat = 72
        private let minimumVisibleDuration: Duration = .milliseconds(600)
        private let restingGap: CGFloat = 56

        init(configuration: LiquidRefreshConfiguration?) {
            self.configuration = configuration
            super.init(frame: .zero)
            backgroundColor = .clear
            spinner.refresh = { [weak self] in self?.beginRefresh() }
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window == nil { detach() } else { attach() }
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            attach()
            placeSpinner()
        }

        func attach() {
            guard window != nil, configuration != nil else { return }
            var ancestor = superview
            while let view = ancestor, !(view is UIScrollView) { ancestor = view.superview }
            guard let found = ancestor as? UIScrollView else { return }
            guard scroll !== found else { return }
            detach()
            scroll = found
            found.alwaysBounceVertical = true
            found.addSubview(spinner)
            found.panGestureRecognizer.addTarget(self, action: #selector(panChanged))
            observation = found.observe(\.contentOffset, options: [.new]) { [weak self] _, _ in
                self?.placeSpinner()
            }
            placeSpinner()
        }

        func detach() {
            observation = nil
            work?.cancel()
            work = nil
            if let scroll {
                scroll.panGestureRecognizer.removeTarget(self, action: #selector(panChanged))
                scroll.contentInset.top -= addedInset
            }
            addedInset = 0
            refreshing = false
            acceptsPull = false
            spinner.stopAnimating()
            spinner.removeFromSuperview()
            scroll = nil
        }

        private var distance: CGFloat {
            guard let scroll else { return 0 }
            return max(0, -(scroll.contentOffset.y + scroll.adjustedContentInset.top - addedInset))
        }

        private func placeSpinner() {
            guard let scroll else { return }
            let gap = max(distance, refreshing ? restingGap : 0)
            let origin = convert(CGPoint.zero, to: scroll)
            var y = origin.y - gap / 2 - 16
            if refreshing {
                y = max(y, scroll.contentOffset.y + scroll.safeAreaInsets.top + 8)
            }
            spinner.frame = CGRect(x: scroll.bounds.midX - 16, y: y, width: 32, height: 32)
            spinner.alpha = refreshing ? 1 : min(1, gap / 24)
            spinner.isAccessibilityElement = false
            isAccessibilityElement = refreshing || gap >= 24
            accessibilityIdentifier = configuration?.identifier
            accessibilityLabel = UIText.t("새로고침", "Refresh")
            accessibilityValue = refreshing ? "refreshing" : (gap >= threshold ? "armed" : "pulling")
            accessibilityFrame = UIAccessibility.convertToScreenCoordinates(spinner.bounds, in: spinner)
            if !refreshing { spinner.turn(distance / threshold * .pi * 2) }
            scroll.bringSubviewToFront(spinner)
        }

        @objc private func panChanged(_ pan: UIPanGestureRecognizer) {
            switch pan.state {
            case .began:
                acceptsPull = !refreshing
            case .ended, .cancelled, .failed:
                let shouldRefresh = acceptsPull && pan.state == .ended && distance >= threshold
                let shouldReturn = acceptsPull && distance > 0
                acceptsPull = false
                DispatchQueue.main.async { [weak self] in
                    guard let self, let scroll = self.scroll, !scroll.isDragging else { return }
                    if shouldRefresh { self.beginRefresh() }
                    else if shouldReturn && !self.refreshing { self.springToTop() }
                }
            default:
                break
            }
        }

        private func beginRefresh() {
            guard !refreshing, let scroll, let configuration else { return }
            refreshing = true
            acceptsPull = false
            addedInset = restingGap
            scroll.contentInset.top += addedInset
            spinner.startAnimating()
            let minimumVisibleUntil = ContinuousClock.now.advanced(by: minimumVisibleDuration)
            springToTop()
            work = Task { @MainActor [weak self] in
                await configuration.action()
                try? await Task.sleep(until: minimumVisibleUntil, clock: .continuous)
                guard !Task.isCancelled, let self else { return }
                self.finishRefresh()
            }
        }

        private func springToTop() {
            guard let scroll else { return }
            scroll.setContentOffset(scroll.contentOffset, animated: false)
            spring {
                scroll.contentOffset.y = -scroll.adjustedContentInset.top
                self.placeSpinner()
            }
        }

        private func finishRefresh() {
            guard let scroll else { return }
            let atTop = scroll.contentOffset.y <= -scroll.adjustedContentInset.top + addedInset
            refreshing = false
            spinner.stopAnimating()
            let inset = addedInset
            addedInset = 0
            spring {
                scroll.contentInset.top -= inset
                if atTop && !scroll.isDragging {
                    scroll.contentOffset.y = -scroll.adjustedContentInset.top
                }
                self.placeSpinner()
            }
            work = nil
        }

        private func spring(_ changes: @escaping () -> Void) {
            UIView.animate(withDuration: UIAccessibility.isReduceMotionEnabled ? 0.16 : 0.48,
                           delay: 0, usingSpringWithDamping: UIAccessibility.isReduceMotionEnabled ? 1 : 0.72,
                           initialSpringVelocity: 0,
                           options: [.beginFromCurrentState, .allowUserInteraction], animations: changes)
        }
    }
}

private final class SpinnerView: UIView {
    private let wheel = CALayer()
    private var spokes: [CAShapeLayer] = []
    var refresh: (() -> Void)?

    init() {
        super.init(frame: CGRect(x: 0, y: 0, width: 32, height: 32))
        backgroundColor = .clear
        accessibilityTraits = .updatesFrequently
        layer.addSublayer(wheel)
        wheel.frame = bounds
        for index in 0..<12 {
            let spoke = CAShapeLayer()
            let path = UIBezierPath()
            path.move(to: CGPoint(x: 16, y: 3))
            path.addLine(to: CGPoint(x: 16, y: 9))
            spoke.path = path.cgPath
            spoke.lineWidth = 2.5
            spoke.lineCap = .round
            spoke.frame = bounds
            spoke.opacity = Float(index + 1) / 12
            spoke.setAffineTransform(CGAffineTransform(rotationAngle: CGFloat(index) * .pi / 6))
            wheel.addSublayer(spoke)
            spokes.append(spoke)
        }
        updateInk()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: SpinnerView, _: UITraitCollection) in
            view.updateInk()
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func updateInk() {
        let ink = UIColor(Theme.ink).resolvedColor(with: traitCollection).cgColor
        spokes.forEach { $0.strokeColor = ink }
    }

    func turn(_ radians: CGFloat) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        wheel.setAffineTransform(CGAffineTransform(rotationAngle: radians))
        CATransaction.commit()
    }

    func startAnimating() {
        guard !UIAccessibility.isReduceMotionEnabled else { return }
        let animation = CABasicAnimation(keyPath: "transform.rotation.z")
        let angle = atan2(wheel.affineTransform().b, wheel.affineTransform().a)
        animation.fromValue = angle
        animation.toValue = angle + .pi * 2
        animation.duration = 0.8
        animation.repeatCount = .infinity
        wheel.add(animation, forKey: "refresh")
    }

    func stopAnimating() { wheel.removeAnimation(forKey: "refresh") }

    override func accessibilityActivate() -> Bool {
        refresh?()
        return true
    }
}

extension View {
    func liquidRefreshable(identifier: String = "refresh.spinner",
                           _ action: @escaping @MainActor () async -> Void) -> some View {
        let refresh: @MainActor () async -> Void = {
            async let appearance: Void = AppearanceStore.shared.refresh()
            await action()
            await appearance
        }
        return environment(\.liquidRefresh, LiquidRefreshConfiguration(identifier: identifier, action: refresh))
            .environment(\.defaultMinListRowHeight, 0)
            .scrollContentBackground(.hidden)
            .scrollBounceBehavior(.always, axes: .vertical)
            .liquidSurface()
            .accessibilityAction(named: Text(UIText.t("새로고침", "Refresh"))) {
                Task { await refresh() }
            }
    }
}
