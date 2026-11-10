import SwiftUI

struct UsageTab {
    let tab: String
    let visits: Int
    let activeMs: Double
}

struct UsageDay {
    let day: String
    let visits: Int
    let activeMs: Double
}

struct UsageEdge: Identifiable {
    let from: String
    let to: String
    let count: Int

    var id: String { "\(from) \(to)" }
}

private func usageNumber(_ value: Any?) -> Double { (value as? NSNumber)?.doubleValue ?? 0 }

private func usageSpan(_ ms: Double) -> String {
    if ms < 60_000 {
        let s = Int((ms / 1000).rounded())
        return UIText.t("\(s)초", "\(s)s")
    }
    let mins = Int((ms / 60_000).rounded())
    if mins < 60 { return UIText.t("\(mins)분", "\(mins)m") }
    let h = mins / 60, m = mins % 60
    if m == 0 { return UIText.t("\(h)시간", "\(h)h") }
    return UIText.t("\(h)시간 \(m)분", "\(h)h \(m)m")
}

@MainActor
final class UsageModel: ObservableObject {
    @Published var days = 30
    @Published var includeDev = false
    @Published var loaded = false
    @Published var flowLoaded = false
    @Published var error: String?
    @Published var devCount = 0
    @Published var visits = 0
    @Published var activeMs = 0.0
    @Published var tabCount = 0
    @Published var browsers = 0
    @Published var tabs: [UsageTab] = []
    @Published var perDay: [UsageDay] = []
    @Published var edges: [UsageEdge] = []
    @Published var truncated = false
    @Published var flowTruncated = false
    private var shownKey: String?
    private var shownFlowDays: Int?

    var key: String { "\(days)-\(includeDev)" }

    func load() async {
        let days = self.days
        let includeDev = self.includeDev
        if key != shownKey { loaded = false }
        if days != shownFlowDays { flowLoaded = false }
        error = nil
        async let overview: Void = loadOverview(days: days, includeDev: includeDev)
        async let flow: Void = loadFlow(days: days)
        await overview
        await flow
    }

    private func loadOverview(days: Int, includeDev: Bool) async {
        do {
            guard let o = try await ConvexHTTP.query("usage:overview", args: ["days": days, "includeDev": includeDev])
                as? [String: Any] else { throw ConvexError.shape }
            guard days == self.days, includeDev == self.includeDev else { return }
            let totals = o["totals"] as? [String: Any] ?? [:]
            visits = Int(usageNumber(totals["visits"]))
            activeMs = usageNumber(totals["activeMs"])
            tabCount = Int(usageNumber(totals["tabs"]))
            browsers = Int(usageNumber(totals["browsers"]))
            devCount = Int(usageNumber(o["devCount"]))
            truncated = o["truncated"] as? Bool ?? false
            tabs = (o["tabs"] as? [[String: Any]] ?? []).map {
                UsageTab(tab: $0["tab"] as? String ?? "", visits: Int(usageNumber($0["visits"])),
                         activeMs: usageNumber($0["activeMs"]))
            }
            perDay = (o["days"] as? [[String: Any]] ?? []).map {
                UsageDay(day: $0["day"] as? String ?? "", visits: Int(usageNumber($0["visits"])),
                         activeMs: usageNumber($0["activeMs"]))
            }
            shownKey = "\(days)-\(includeDev)"
        } catch {
            guard !Task.isCancelled, days == self.days, includeDev == self.includeDev else { return }
            self.error = error.localizedDescription
        }
        loaded = true
    }

    private func loadFlow(days: Int) async {
        do {
            guard let f = try await ConvexHTTP.query("usage:flow", args: ["days": days]) as? [String: Any]
            else { throw ConvexError.shape }
            guard days == self.days else { return }
            flowTruncated = f["truncated"] as? Bool ?? false
            edges = (f["edges"] as? [[String: Any]] ?? []).map {
                UsageEdge(from: $0["from"] as? String ?? "", to: $0["to"] as? String ?? "",
                          count: Int(usageNumber($0["count"])))
            }
            shownFlowDays = days
        } catch {
            guard !Task.isCancelled, days == self.days else { return }
            self.error = error.localizedDescription
        }
        flowLoaded = true
    }
}

struct UsageView: View {
    @Environment(\.appearanceTokens) private var theme
    @StateObject private var model = UsageModel()
    @State private var pickedDay: String?

    var body: some View {
        TabNavigationStack {
            List {
                LiquidRefreshHeader()
                controls.glassRowLayout()
                if let error = model.error {
                    LoadFailure(message: error)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .glassRow().glassRowLayout()
                }
                if !model.loaded {
                    stats.loadingPlaceholder().glassRow().glassRowLayout()
                        .loadingAccessibility("usage.loading", label: UIText.t("사용량 불러오는 중", "Loading usage"))
                    Section {
                        tabSkeleton.glassRow().glassRowLayout()
                    } header: { header(UIText.t("탭별 시간", "Time by tab")) }
                    Section {
                        VStack(spacing: theme.space(1.5)) {
                            SkeletonChart(height: theme.space(18), bars: model.days)
                            HStack {
                                SkeletonText(role: .meta, width: 0.5)
                                SkeletonText(role: .meta, width: 0.5, alignment: .trailing)
                            }
                        }.glassRow().glassRowLayout()
                    } header: { header(UIText.t("일별", "Per day")) }
                    Section {
                        flowSkeleton.glassRow().glassRowLayout()
                    } header: { header(UIText.t("탭 사이 이동", "Moves between tabs")) }
                } else if model.visits == 0 {
                    if model.error == nil {
                        Text(UIText.t("이 기간에 기록된 사용이 아직 없어요. 사용량은 웹 앱에서 탭을 옮겨 다니는 동안 기록돼요.",
                                      "Nothing recorded in this window yet. Usage is collected in the web app as you move between tabs."))
                            .themeText(.meta).foregroundStyle(Theme.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .glassRow().glassRowLayout()
                    }
                } else {
                    stats.glassRow().glassRowLayout()
                    Section {
                        tabsCard.glassRow().glassRowLayout()
                    } header: {
                        header(UIText.t("탭별 시간", "Time by tab"))
                    }
                    Section {
                        daysCard.glassRow().glassRowLayout()
                    } header: {
                        header(UIText.t("일별", "Per day"))
                    }
                    Section {
                        flowCard.glassRow().glassRowLayout()
                    } header: {
                        header(UIText.t("탭 사이 이동", "Moves between tabs"))
                    }
                    if model.truncated || model.flowTruncated {
                        Text(UIText.t("기간별 읽기 한도에서 잘렸어요. 이 범위의 오래된 기록은 세지 않았어요.",
                                      "Capped at the per-window read limit; older rows in this range are not counted."))
                            .themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary)
                            .glassRowLayout()
                    }
                }
            }
            .liquidList()
            .accessibilityIdentifier("usage.scroll")
            .navigationTitle(UIText.t("사용량", "Usage"))
            .liquidRefreshable { await model.load() }
            .task(id: model.key) { await model.load() }
            .onChange(of: model.days) { _, _ in pickedDay = nil }
        }
    }

    private var controls: some View {
        HStack(spacing: theme.space(2.5)) {
            SegmentedButtons(title: UIText.t("기간", "Range"), selection: $model.days, options:
                [7, 30, 90].map { d in
                    .init(id: "usage.range.\(d)", value: d, title: UIText.t("\(d)일", "\(d)d"))
                })
            if model.devCount > 0 {
                Button {
                    model.includeDev.toggle()
                } label: {
                    Text(model.includeDev
                         ? UIText.t("dev 포함 (\(model.devCount))", "with dev (\(model.devCount))")
                         : UIText.t("dev 제외 (\(model.devCount))", "without dev (\(model.devCount))"))
                        .themeText(.meta, design: .monospaced)
                        .foregroundStyle(model.includeDev ? Theme.accent : Theme.secondary)
                }
                .buttonStyle(.borderless)
                .accessibilityHint(UIText.t("localhost에서 열린 세션은 대개 앱을 쓰는 게 아니라 만드는 중이에요",
                                            "Sessions served from localhost are usually you building the app, not using it"))
            }
        }
        .padding(.vertical, theme.space(1))
    }

    private var stats: some View {
        HStack(spacing: theme.space(2)) {
            figure(usageSpan(model.activeMs), UIText.t("몰입", "engaged"))
            figure("\(model.visits)", UIText.t("방문", "visits"))
            figure("\(model.tabCount)", UIText.t("쓴 탭", "tabs used"))
            figure("\(model.browsers)", UIText.t("브라우저", "browsers"))
        }
    }

    private var tabSkeleton: some View {
        VStack(spacing: theme.space(1.5)) {
            ForEach(0..<4, id: \.self) { _ in
                HStack(spacing: theme.space(2.5)) {
                    SkeletonText(width: 0.8).frame(width: theme.space(21))
                    Skeleton().frame(height: theme.space(2.5))
                    SkeletonText(role: .meta).frame(width: theme.space(14.5))
                    SkeletonText(role: .meta).frame(width: theme.space(10))
                }
            }
        }
    }

    private var flowSkeleton: some View {
        VStack(spacing: theme.space(1.5)) {
            ForEach(0..<3, id: \.self) { _ in
                HStack(spacing: theme.space(2.5)) {
                    SkeletonText(width: 0.85).frame(width: theme.space(37.5))
                    Skeleton().frame(height: theme.space(2))
                    SkeletonText(role: .meta).frame(width: theme.space(9))
                }
            }
        }
    }

    private func figure(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: theme.space(1)) {
            Text(value).themeText(.heading, design: .serif).lineLimit(1).minimumScaleFactor(0.6)
            Text(label).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var tabsCard: some View {
        let peak = max(model.tabs.map(\.activeMs).max() ?? 1, 1)
        return Grid(alignment: .leading, horizontalSpacing: theme.space(2.5), verticalSpacing: theme.space(1.5)) {
            ForEach(model.tabs, id: \.tab) { t in
                GridRow {
                    Text(UIText.tab(t.tab)).themeText(.title).lineLimit(1)
                        .accessibilityIdentifier("usage.tab.\(t.tab)")
                        .frame(width: 84, alignment: .leading)
                    UsageBar(fraction: t.activeMs / peak, tint: Theme.accent.opacity(0.7), height: 10)
                    Text(usageSpan(t.activeMs)).themeText(.meta).monospacedDigit().foregroundStyle(Theme.secondary)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                        .gridColumnAlignment(.trailing)
                    Text(UIText.t("\(t.visits)회", "\(t.visits)v")).themeText(.meta).monospacedDigit()
                        .foregroundStyle(Theme.secondary)
                        .frame(width: 40, alignment: .trailing)
                }
            }
        }
    }

    private var daysCard: some View {
        let days = model.perDay
        let peak = max(days.map(\.activeMs).max() ?? 1, 1)
        let picked = days.first { $0.day == pickedDay }
        return VStack(alignment: .leading, spacing: theme.space(1.5)) {
            GeometryReader { geo in
                let n = max(days.count, 1)
                let gap: CGFloat = days.count > 40 ? 1 : 3
                let slotWidth = max((geo.size.width - gap * CGFloat(n - 1)) / CGFloat(n), 1)
                HStack(alignment: .bottom, spacing: gap) {
                    ForEach(days, id: \.day) { d in
                        RoundedRectangle(cornerRadius: theme.value("radiusSmall"), style: .continuous)
                            .fill(Theme.accent.opacity(d.day == pickedDay ? 0.9 : 0.6))
                            .frame(width: min(slotWidth, 24), height: max(geo.size.height * CGFloat(d.activeMs / peak), 2))
                            .frame(width: slotWidth)
                            .accessibilityLabel(d.day)
                            .accessibilityValue("\(d.visits) · \(usageSpan(d.activeMs))")
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                .contentShape(Rectangle())
                .gesture(SpatialTapGesture().onEnded { tap in
                    guard !days.isEmpty else { return }
                    let i = min(max(Int(tap.location.x / (slotWidth + gap)), 0), days.count - 1)
                    pickedDay = pickedDay == days[i].day ? nil : days[i].day
                })
            }
            .frame(height: 72)
            HStack {
                Text(days.first?.day ?? "")
                Spacer()
                Text(days.last?.day ?? "")
            }
            .themeText(.meta).monospacedDigit().foregroundStyle(Theme.secondary)
            if let picked {
                Text(UIText.t("\(picked.day): 방문 \(picked.visits)회, \(usageSpan(picked.activeMs))",
                              "\(picked.day): \(usageSpan(picked.activeMs)) over \(picked.visits) visit\(picked.visits == 1 ? "" : "s")"))
                    .themeText(.meta).monospacedDigit()
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(UIText.t("일별 사용량", "Daily usage"))
        .accessibilityValue(UIText.t("\(days.count)일", "\(days.count) days"))
        .accessibilityIdentifier("usage.days")
    }

    @ViewBuilder
    private var flowCard: some View {
        if !model.flowLoaded {
            flowSkeleton
        } else if model.edges.isEmpty {
            Text(UIText.t("아직 이동이 없어요. 한 화면에 열어 둔 탭 하나는 갈 곳이 없어요.",
                          "No moves yet. A single tab open on one view has nowhere to go."))
                .themeText(.meta).foregroundStyle(Theme.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            let shown = Array(model.edges.prefix(12))
            let peak = Double(max(shown.map(\.count).max() ?? 1, 1))
            VStack(spacing: theme.space(1.5)) {
                ForEach(shown) { e in
                    HStack(spacing: theme.space(2.5)) {
                        HStack(spacing: theme.space(1)) {
                            Text(UIText.tab(e.from))
                            Text("→").foregroundStyle(Theme.secondary)
                            Text(UIText.tab(e.to))
                        }
                        .themeText(.title).lineLimit(1).minimumScaleFactor(0.7)
                        .frame(width: 150, alignment: .leading)
                        UsageBar(fraction: Double(e.count) / peak, tint: Theme.secondary.opacity(0.5), height: 8)
                        Text("\(e.count)").themeText(.meta).monospacedDigit().foregroundStyle(Theme.secondary)
                            .frame(width: 36, alignment: .trailing)
                    }
                }
            }
        }
    }

    private func header(_ text: String) -> some View {
        Text(text).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary).textCase(nil)
    }
}

private struct UsageBar: View {
    @Environment(\.appearanceTokens) private var theme
    let fraction: Double
    let tint: Color
    let height: CGFloat

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: theme.value("radiusSmall"), style: .continuous).fill(Color.primary.opacity(0.06))
                RoundedRectangle(cornerRadius: theme.value("radiusSmall"), style: .continuous).fill(tint)
                    .frame(width: geo.size.width * CGFloat(min(max(fraction, 0), 1)))
            }
        }
        .frame(height: height)
    }
}
