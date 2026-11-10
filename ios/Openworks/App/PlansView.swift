import SwiftUI

private struct PlanTrip: Identifiable {
    let slug: String
    let title: String
    let firstDate: String?
    let lastDate: String?
    let location: String?
    let theme: String?
    var id: String { slug }

    init?(_ r: [String: Any]) {
        guard let slug = r["slug"] as? String, let title = r["title"] as? String else { return nil }
        self.slug = slug
        self.title = title
        firstDate = r["firstDate"] as? String
        lastDate = r["lastDate"] as? String
        location = r["location"] as? String
        theme = r["theme"] as? String
    }
}

private struct PlanDay: Identifiable {
    let id: String
    let planSlug: String
    let date: String
    let dayLabel: String?
    let summary: String?

    init?(_ r: [String: Any]) {
        guard let id = r["_id"] as? String, let planSlug = r["planSlug"] as? String,
              let date = r["date"] as? String else { return nil }
        self.id = id
        self.planSlug = planSlug
        self.date = date
        dayLabel = planText(r["dayLabel"])
        summary = planText(r["summary"])
    }
}

private struct PlanEntry: Identifiable {
    let id: String
    let planSlug: String
    let date: String
    let kind: String
    let order: Double
    let title: String
    let notes: String?
    let time: String?
    let timeStart: String?
    let timeEnd: String?
    let tier: Int?
    let location: String?
    let tags: [String]
    var done: Bool

    init?(_ r: [String: Any]) {
        guard let id = r["_id"] as? String, let planSlug = r["planSlug"] as? String,
              let date = r["date"] as? String, let title = r["title"] as? String else { return nil }
        self.id = id
        self.planSlug = planSlug
        self.date = date
        self.title = title
        kind = r["kind"] as? String ?? "event"
        order = (r["order"] as? NSNumber)?.doubleValue ?? 0
        notes = planText(r["notes"])
        time = planText(r["time"])
        timeStart = planText(r["timeStart"])
        timeEnd = planText(r["timeEnd"])
        tier = (r["tier"] as? NSNumber)?.intValue
        location = planText(r["location"])
        tags = r["tags"] as? [String] ?? []
        done = r["done"] as? Bool ?? false
    }

    var lowTags: [String] { tags.map { $0.lowercased() } }
    var archived: Bool { lowTags.contains("archived") }
    var isFlight: Bool { lowTags.contains("flight") }

    var programDetail: Bool {
        if lowTags.contains(where: { $0.hasPrefix("poster session") || planProgramTags.contains($0) }) { return true }
        let low = title.lowercased()
        guard low.hasPrefix("buffer") else { return false }
        guard let next = low.dropFirst(6).first else { return true }
        return !(next.isLetter || next.isNumber || next == "_")
    }

    var calendarWorthy: Bool { !programDetail && !archived }

    var emoji: String? {
        for t in lowTags { if let e = planKindEmoji[t] { return e } }
        return nil
    }

    var strong: Bool { ["match", "flight", "icml", "conference"].contains { lowTags.contains($0) } }

    var kindColor: Color {
        let t = lowTags
        if t.contains("match") { return Theme.accent }
        if t.contains("flight") { return Theme.planSage }
        if t.contains("icml") || t.contains("conference") { return Theme.planSlate }
        return .primary
    }

    var end: String? {
        tags.first(where: { $0.lowercased().hasPrefix("end:") }).map { String($0.dropFirst(4)) }
    }
}

private struct PlanDraft: Identifiable {
    let date: String
    let slug: String
    let item: PlanEntry?
    var id: String { item?.id ?? "new:\(slug):\(date)" }
}

private struct PlanRange: Identifiable {
    let lo: String
    let hi: String

    init(_ a: String, _ b: String) {
        lo = min(a, b)
        hi = max(a, b)
    }

    var id: String { "\(lo)~\(hi)" }

    var dates: [String] {
        var out: [String] = []
        var d = lo
        while d <= hi && out.count < 120 {
            out.append(d)
            d = planAddDays(d, 1)
        }
        return out
    }

    func contains(_ date: String) -> Bool { date >= lo && date <= hi }

    var label: String {
        let a = lo.replacingOccurrences(of: "-", with: "/")
        return lo == hi ? a : "\(a) → \(hi.replacingOccurrences(of: "-", with: "/"))"
    }
}

private extension Theme {
    static let planSage = success
    static let planSlate = link
}

private let planProgramTags: Set<String> = [
    "oral", "poster", "invited", "expo", "social", "networking", "reception", "ceremony",
    "spotlight", "keynote", "session", "talk", "buffer", "sponsor", "opening", "closing",
]

private let planKindEmoji: [String: String] = [
    "flight": "✈", "match": "⚽", "icml": "🎓", "conference": "🎓", "travel": "🚆",
]

private func planText(_ value: Any?) -> String? {
    guard let s = value as? String, !s.isEmpty else { return nil }
    return s
}

private let planUTC: Calendar = {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(secondsFromGMT: 0) ?? .current
    return c
}()

private let planLocal: Calendar = {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = .current
    return c
}()

private func planParts(_ s: String) -> [Int]? {
    let p = s.split(separator: "-").compactMap { Int($0) }
    return p.count == 3 ? p : nil
}

private func planDate(_ s: String, _ cal: Calendar = planUTC) -> Date? {
    guard let p = planParts(s) else { return nil }
    return cal.date(from: DateComponents(year: p[0], month: p[1], day: p[2], hour: 12))
}

private func planString(_ date: Date, _ cal: Calendar = planUTC) -> String {
    let c = cal.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
}

private func planAddDays(_ s: String, _ n: Int) -> String {
    guard let d = planDate(s), let moved = planUTC.date(byAdding: .day, value: n, to: d) else { return s }
    return planString(moved)
}

private func planWeekday(_ s: String) -> Int {
    guard let d = planDate(s) else { return 0 }
    return planUTC.component(.weekday, from: d) - 1
}

private func planDayDiff(_ a: String, _ b: String) -> Int {
    guard let x = planDate(a), let y = planDate(b) else { return 0 }
    return planUTC.dateComponents([.day], from: x, to: y).day ?? 0
}

private func planWeekdayLabel(_ date: String) -> String {
    let i = planWeekday(date)
    return UIText.t(["일", "월", "화", "수", "목", "금", "토"][i], ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][i])
}

private func planMonth(_ date: String) -> String {
    let m = planParts(date)?[1] ?? 1
    let names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    return UIText.t("\(m)월", names[max(0, min(11, m - 1))])
}

private func planShort(_ date: String?) -> String {
    guard let date else { return "" }
    return String(date.dropFirst(5)).replacingOccurrences(of: "-", with: "/")
}

private func planSpan(_ first: String?, _ last: String?) -> String {
    planShort(first) + (last.map { " – \(planShort($0))" } ?? "")
}

private func planSyncKey(_ slug: String, _ date: String) -> String { "\(slug)|\(date)" }

private func planCellOrder(_ a: PlanEntry, _ b: PlanEntry) -> Bool {
    let x = a.timeStart ?? "~", y = b.timeStart ?? "~"
    return x != y ? x < y : a.order < b.order
}

private func planEventOrder(_ a: PlanEntry, _ b: PlanEntry) -> Bool {
    switch (a.timeStart, b.timeStart) {
    case let (x?, y?): return x < y
    case (.some, nil): return true
    case (nil, .some): return false
    default: return a.order < b.order
    }
}

private func planTierColor(_ tier: Int?) -> Color {
    switch tier ?? 3 {
    case 0: return Theme.accent
    case 1: return Theme.planSage
    case 2: return .secondary
    default: return Color.primary.opacity(0.12)
    }
}

private func planMinutes(_ t: String?) -> Int? {
    guard let t else { return nil }
    let parts = t.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
    guard parts.count == 2, (1...2).contains(parts[0].count), parts[0].allSatisfy(\.isNumber),
          let h = Int(parts[0]) else { return nil }
    let mm = parts[1].prefix(2)
    guard mm.count == 2, mm.allSatisfy(\.isNumber), let m = Int(mm) else { return nil }
    return h * 60 + m
}

private func planThemes(_ theme: String?) -> [String] {
    guard let theme else { return [] }
    var out: [String] = []
    for part in theme.lowercased().split(whereSeparator: { $0 == "·" || $0 == "," || $0 == "/" || $0.isWhitespace }) {
        let s = String(part)
        if !out.contains(s) { out.append(s) }
    }
    return out
}

private func planScore(_ e: PlanEntry, _ themes: [String]) -> Int {
    let text = "\(e.title) \(e.tags.joined(separator: " ")) \(e.notes ?? "")".lowercased()
    var score = themes.filter { text.contains($0) }.count
    switch e.tier ?? -1 {
    case 0: score += 100
    case 1: score += 10
    case 2: score += 3
    default: break
    }
    return score
}

private func planConflicts(_ events: [PlanEntry], themes: [String]) -> [String: Bool] {
    func span(_ e: PlanEntry) -> (start: Int, end: Int)? {
        guard let s = planMinutes(e.timeStart) else { return nil }
        return (s, planMinutes(e.timeEnd) ?? s + 60)
    }
    var out: [String: Bool] = [:]
    var assigned = Set<Int>()
    for i in events.indices where !assigned.contains(i) {
        guard span(events[i]) != nil else { continue }
        var members = [i]
        for j in events.indices where j > i && !assigned.contains(j) {
            guard let other = span(events[j]) else { continue }
            let overlaps = members.contains { m in
                guard let a = span(events[m]) else { return false }
                return other.start < a.end && a.start < other.end
            }
            if overlaps { members.append(j) }
        }
        guard members.count > 1 else { continue }
        var best = members[0]
        for m in members.dropFirst() where planScore(events[m], themes) > planScore(events[best], themes) {
            best = m
        }
        for m in members {
            out[events[m].id] = m == best
            assigned.insert(m)
        }
    }
    return out
}

@MainActor
private final class PlanModel: ObservableObject {
    @Published var trips: [PlanTrip] = []
    @Published var days: [PlanDay] = []
    @Published var items: [PlanEntry] = [] {
        didSet { index() }
    }
    @Published var syncs: [String: String] = [:]
    @Published var error: String?
    @Published var loaded = false
    private var byDate: [String: [PlanEntry]] = [:]
    func load() async {
        do {
            guard let plans = try await ConvexHTTP.query("plans:listAll") as? [[String: Any]],
                  let all = try await ConvexHTTP.query("plans:allItems") as? [String: Any]
            else { throw ConvexError.shape }
            trips = plans.compactMap(PlanTrip.init)
                .filter { $0.slug != "recent-calendar" }
                .sorted { ($0.firstDate ?? "") < ($1.firstDate ?? "") }
            days = ((all["days"] as? [[String: Any]]) ?? []).compactMap(PlanDay.init).sorted { $0.date < $1.date }
            items = ((all["items"] as? [[String: Any]]) ?? []).compactMap(PlanEntry.init)
            error = nil
        } catch is CancellationError {
            return
        } catch let failure as URLError where failure.code == .cancelled {
            return
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    private func index() {
        byDate = Dictionary(grouping: items, by: \.date)
    }

    func entries(on date: String) -> [PlanEntry] {
        (byDate[date] ?? []).sorted(by: planCellOrder)
    }

    func slug(for date: String, fallback: String) -> String {
        byDate[date]?.first?.planSlug ?? fallback
    }

    func send(_ path: String, _ args: [String: Any]) async throws {
        try await ConvexHTTP.mutation(path, args: args)
        await load()
    }

    func run(_ path: String, _ args: [String: Any]) async {
        do {
            try await send(path, args)
        } catch {
            self.error = error.localizedDescription
        }
    }

    func toggle(_ id: String) async {
        await run("plans:toggleDone", ["itemId": id])
    }

    func checkSync(slug: String, date: String) async {
        let key = planSyncKey(slug, date)
        guard syncs[key] == nil else { return }
        syncs[key] = await latestSync(slug: slug, date: date)
    }

    func requestSync(slug: String, date: String) async {
        let key = planSyncKey(slug, date)
        syncs[key] = "pending"
        do {
            try await ConvexHTTP.mutation("calendar:requestSyncDay", args: ["planSlug": slug, "date": date])
        } catch {
            syncs[key] = "error"
            self.error = error.localizedDescription
            return
        }
        for _ in 0..<40 {
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
            let status = await latestSync(slug: slug, date: date)
            if status != "pending" {
                syncs[key] = status
                if status == "done" { await load() }
                return
            }
        }
    }

    private func latestSync(slug: String, date: String) async -> String {
        do {
            let value = try await ConvexHTTP.query("calendar:latestForDay", args: ["planSlug": slug, "date": date])
            return ((value as? [String: Any])?["status"] as? String) ?? "none"
        } catch {
            self.error = error.localizedDescription
            return "error"
        }
    }


}

struct PlansView: View {
    @Environment(\.appearanceTokens) private var theme
    @StateObject private var model = PlanModel()
    @AppStorage("plans.view") private var mode = "calendar"
    @State private var selected: String? = nil
    @State private var weeks = 5
    @State private var editing: PlanDraft? = nil
    @State private var range: PlanRange? = nil
    @State private var picking = false
    @State private var rangeStart: String? = nil
    @State private var collapsed: Set<String> = []

    init() {}

    private var today: String { calendarDay() }

    private var trip: PlanTrip? {
        guard let selected else { return nil }
        return model.trips.first { $0.slug == selected }
    }

    private var defaultSlug: String { selected ?? model.trips.first?.slug ?? "travel-history" }

    private var weekStart: String {
        let anchor = trip?.firstDate ?? today
        return planAddDays(anchor, -planWeekday(anchor))
    }

    private var dates: [String] { (0..<(weeks * 7)).map { planAddDays(weekStart, $0) } }

    private var scrollKey: String { "\(mode)|\(weekStart)|\(model.loaded)" }

    var body: some View {
        TabNavigationStack {
            VStack(spacing: 0) {
                // Keep the controls outside the scroll viewport so a top-aligned
                // day cannot land underneath the fixed header.
                controls
                ScrollViewReader { proxy in
                    List {
                        LiquidRefreshHeader()
                        if let error = model.error {
                            LoadFailure(message: error) { Task { await model.load() } }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .glassRow().glassRowLayout()
                        }
                        if !model.loaded {
                            loading
                        } else if model.trips.isEmpty {
                            if model.error == nil {
                                LoadEmpty(message: UIText.t("아직 계획이 없어요.", "No plans yet."))
                                    .glassRow().glassRowLayout()
                            }
                        } else if mode == "list" {
                            listView
                        } else {
                            calendarView
                        }
                    }
                    .accessibilityIdentifier("plans.scroll")
                    .liquidList()
                    .onChange(of: scrollKey) { _, _ in
                        guard mode == "calendar", model.loaded, !model.trips.isEmpty else { return }
                        let target = dates.contains(today) ? today : weekStart
                        DispatchQueue.main.async { proxy.scrollTo(target, anchor: .top) }
                    }
                }
            }
            .navigationTitle(trip?.title ?? UIText.t("일정", "Itineraries"))
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if mode == "calendar" && !model.trips.isEmpty {
                        Button {
                            picking.toggle()
                            rangeStart = nil
                        } label: {
                            ListIcon(systemName: picking ? "xmark" : "arrow.left.and.right")
                        }
                        .accessibilityLabel(UIText.t("기간 선택", "Select a range"))
                    }
                    Button {
                        editing = PlanDraft(date: today, slug: model.slug(for: today, fallback: defaultSlug), item: nil)
                    } label: {
                        ListIcon(systemName: "plus")
                    }
                    .disabled(model.trips.isEmpty)
                    .accessibilityLabel(UIText.t("일정 추가", "Add event"))
                    .accessibilityIdentifier("plans.add")
                }
            }
            .sheet(item: $editing) { PlanEditor(draft: $0, model: model) }
            .sheet(item: $range) { r in
                PlanDaySheet(range: r, defaultSlug: defaultSlug, model: model)
                    .presentationDetents([.medium, .large])
            }
            .onChange(of: mode) { _, _ in
                picking = false
                rangeStart = nil
            }
            .onChange(of: weekStart) { _, _ in weeks = 5 }
            .liquidRefreshable { await model.load() }
        }
        .task {
            if !["calendar", "list"].contains(mode) { mode = "calendar" }
            await model.load()
        }
    }

    @ViewBuilder
    private var controls: some View {
        if !model.loaded || !model.trips.isEmpty {
            VStack(alignment: .leading, spacing: theme.space(2)) {
                SegmentedButtons(title: UIText.t("보기", "View"), selection: $mode, options: [
                    .init(id: "plans.mode.calendar", value: "calendar", title: UIText.t("캘린더", "Calendar")),
                    .init(id: "plans.mode.list", value: "list", title: UIText.t("목록", "List")),
                ])
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: theme.space(1.5)) {
                        chip(UIText.t("전체", "All"), span: nil, active: selected == nil) { selected = nil }
                        ForEach(model.trips) { trip in
                            chip(trip.title, span: planSpan(trip.firstDate, trip.lastDate), active: selected == trip.slug) {
                                selected = selected == trip.slug ? nil : trip.slug
                            }
                        }
                    }
                }
                if picking {
                    Text(rangeStart == nil
                         ? UIText.t("첫 날을 고르세요", "Pick the first day")
                         : UIText.t("마지막 날을 고르세요", "Pick the last day"))
                        .themeText(.meta).foregroundStyle(Theme.secondary)
                }
            }
            .padding(.horizontal, theme.space(4))
            .padding(.vertical, theme.space(2))
            .background(.ultraThinMaterial)
            .loadingPlaceholder(!model.loaded)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("plans.controls")
        }
    }

    private func chip(_ title: String, span: String?, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: theme.space(0.25)) {
                Text(title).themeText(.badge).lineLimit(1)
                if let span {
                    Text(span).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary)
                }
            }
            .padding(.horizontal, theme.space(2.5))
            .padding(.vertical, theme.space(1.25))
            .frame(minHeight: 34)
            .background(active ? Theme.accent.opacity(0.14) : Theme.secondary.opacity(0.10),
                        in: RoundedRectangle(cornerRadius: theme.value("radiusControl"), style: .continuous))
            .foregroundStyle(active ? Theme.accent : Color.primary)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var loading: some View {
        if mode == "list" {
            Section {
                SkeletonText(role: .meta, lines: 2, width: 0.7).glassRowLayout()
                ForEach(0..<3, id: \.self) { _ in
                    ContentRowSkeleton(titleLines: 1)
                        .padding(.leading, theme.space(2))
                        .overlay(alignment: .leading) {
                            RoundedRectangle(cornerRadius: theme.value("radiusSmall"))
                                .fill(Theme.ink.opacity(0.08)).frame(width: theme.space(0.75))
                        }
                        .glassRow().glassRowLayout()
                        .loadingAccessibility("plans.loading", label: UIText.t("일정 불러오는 중", "Loading plans"))
                }
            } header: {
                SkeletonText(role: .meta, width: 0.45)
            }
        } else {
            ForEach(Array(dates.prefix(5)), id: \.self) { date in
                dayCell(date, loading: true).loadingPlaceholder()
                    .loadingAccessibility("plans.loading", label: UIText.t("일정 불러오는 중", "Loading plans"))
            }
        }
    }

    @ViewBuilder
    private var calendarView: some View {
        ForEach(dates, id: \.self) { date in
            dayCell(date)
        }
        Button {
            weeks += 5
        } label: {
            Text(UIText.t("다음 주 더 보기", "Load more weeks"))
                .themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, theme.space(1.5))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .glassRowLayout()
    }

    private func dayCell(_ date: String, loading: Bool = false) -> some View {
        let cells = model.entries(on: date).filter(\.calendarWorthy)
        let tint = Theme.secondary
        let dow = planWeekday(date)
        let isToday = date == today
        let marked = rangeStart == date || (range?.contains(date) ?? false)
        return VStack(alignment: .leading, spacing: theme.space(1.5)) {
            HStack(spacing: theme.space(1.5)) {
                if date.hasSuffix("-01") {
                    Text(planMonth(date)).themeText(.meta, design: .monospaced).foregroundStyle(Theme.accent)
                }
                Text(planShort(date)).themeText(.title)
                    .foregroundStyle(isToday ? Theme.accent : Color.primary)
                    .accessibilityIdentifier("plans.date.\(date)")
                Text(planWeekdayLabel(date)).themeText(.meta)
                    .foregroundStyle(dow == 0 ? Theme.accent : dow == 6 ? Theme.planSlate : Theme.secondary)
                Spacer(minLength: theme.space(1))
                Button {
                    editing = PlanDraft(date: date, slug: model.slug(for: date, fallback: defaultSlug), item: nil)
                } label: {
                    ListIcon(systemName: "plus")
                        .foregroundStyle(Theme.secondary)

                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(UIText.t("일정 추가", "Add event"))
            }
            if loading {
                SkeletonText(role: .meta, width: 0.85)
                SkeletonText(role: .meta, width: 0.65)
            }
            ForEach(cells) { it in
                Button {
                    editing = PlanDraft(date: it.date, slug: it.planSlug, item: it)
                } label: {
                    PlanEventLine(item: it)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("plans.calendar.event.\(it.id)")
                .accessibilityValue(it.date)
            }
        }
        .padding(.leading, theme.space(2.5))
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: theme.value("radiusSmall"), style: .continuous).fill(tint).frame(width: 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassRow()
        .overlay {
            RoundedRectangle(cornerRadius: theme.value("radiusCard"), style: .continuous)
                .stroke(Theme.accent, lineWidth: marked ? 1.5 : 1)
                .opacity(marked || isToday ? 1 : 0)
                .allowsHitTesting(false)
        }
        .onTapGesture { tapDay(date) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("plans.calendar.day.\(date)")
        .glassRowLayout()
        .id(date)
    }

    private func tapDay(_ date: String) {
        guard picking else {
            range = PlanRange(date, date)
            return
        }
        if let start = rangeStart {
            range = PlanRange(start, date)
            rangeStart = nil
            picking = false
        } else {
            rangeStart = date
        }
    }

    private var listDays: [PlanDay] {
        if let selected { return model.days.filter { $0.planSlug == selected } }
        let floor = planAddDays(today, -3)
        var seen = Set<String>()
        return model.days.filter { $0.date >= floor && seen.insert($0.date).inserted }
    }

    @ViewBuilder
    private var listView: some View {
        let shown = listDays
        let entries = selected.map { slug in model.items.filter { $0.planSlug == slug } } ?? model.items
        let themes = planThemes(trip?.theme)
        if shown.isEmpty {
            Text(UIText.t("아직 일정 날짜가 없어요.", "No plan days yet."))
                .themeText(.meta).italic().foregroundStyle(Theme.secondary)
                .frame(maxWidth: .infinity)
                .glassRowLayout()
        }
        ForEach(shown) { day in
            daySection(day, entries: entries.filter { $0.date == day.date }, themes: themes)
        }
    }

    private func daySection(_ day: PlanDay, entries: [PlanEntry], themes: [String]) -> some View {
        let events = entries.filter { $0.kind == "event" }.sorted(by: planEventOrder)
        let todos = entries.filter { $0.kind == "todo" }.sorted { $0.order < $1.order }
        let picks = planConflicts(events, themes: themes)
        let open = !collapsed.contains(day.id)
        return Section {
            if let summary = day.summary {
                Text(summary).themeText(.meta).italic().foregroundStyle(Theme.secondary)
                    .accessibilityIdentifier("plans.agenda.summary.\(day.id)")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .glassRowLayout()
            }
            ForEach(todos) { todoRow($0) }
            if !events.isEmpty {
                Button {
                    if open { collapsed.insert(day.id) } else { collapsed.remove(day.id) }
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: theme.value("rowGap")) {
                        ListIcon(systemName: open ? "chevron.down" : "chevron.right")
                        Text(UIText.t("이벤트 \(events.count) · 완료 \(events.filter(\.done).count)",
                                      "Events \(events.count) · done \(events.filter(\.done).count)"))
                    }
                    .themeText(.meta, design: .monospaced)
                    .foregroundStyle(Theme.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .glassRowLayout()
                if open {
                    ForEach(events) { eventRow($0, pick: picks[$0.id]) }
                }
            }
        } header: {
            HStack(spacing: theme.space(1.5)) {
                Text(day.date)
                if let label = day.dayLabel { Text(label) }
                Spacer()
                syncButton(day)
            }
            .themeText(.meta, design: .monospaced)
            .foregroundStyle(Theme.secondary)
            .textCase(nil)
        }
    }

    private func syncButton(_ day: PlanDay) -> some View {
        let status = model.syncs[planSyncKey(day.planSlug, day.date)]
        return Button {
            Task { await model.requestSync(slug: day.planSlug, date: day.date) }
        } label: {
            HStack(spacing: theme.space(0.75)) {
                if status == "pending" {
                    ProgressView().controlSize(.mini)
                } else {
                    ListIcon(systemName: status == "error" ? "exclamationmark.circle"
                        : status == "done" ? "checkmark" : "arrow.triangle.2.circlepath")
                }
                Text(UIText.t("동기화", "Sync"))
            }
            .foregroundStyle(status == "error" ? Theme.failure : Theme.secondary)
        }
        .buttonStyle(.plain)
        .disabled(status == "pending")
        .task { await model.checkSync(slug: day.planSlug, date: day.date) }
    }

    private func checkButton(_ it: PlanEntry) -> some View {
        Button {
            Task { await model.toggle(it.id) }
        } label: {
            ListIcon(systemName: it.done ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(Theme.secondary)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(it.done ? UIText.t("완료 취소", "Mark as not done") : UIText.t("완료", "Mark as done"))
    }

    private func editButton(_ it: PlanEntry) -> some View {
        Button {
            editing = PlanDraft(date: it.date, slug: it.planSlug, item: it)
        } label: {
            Label(UIText.t("편집", "Edit"), systemImage: "pencil")
        }
    }

    private func todoRow(_ it: PlanEntry) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: theme.value("rowGap")) {
            checkButton(it)
            Text(it.title).themeText(.title).strikethrough(it.done)
                .foregroundStyle(it.done ? Theme.secondary : Color.primary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassRow()
        .glassRowLayout()
        .contextMenu { editButton(it) }
    }

    private func eventRow(_ it: PlanEntry, pick: Bool?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: theme.value("rowGap")) {
            checkButton(it)
            VStack(alignment: .leading, spacing: theme.value("rowTextGap")) {
                HStack(alignment: .firstTextBaseline, spacing: theme.space(1.25)) {
                    if let emoji = it.emoji { Text(emoji) }
                    if let time = it.time {
                        Text(time).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary)
                    }
                    Text(it.title).themeText(.title).strikethrough(it.done)
                        .foregroundStyle(it.done ? Theme.secondary : Color.primary)
                }
                if it.tier != nil || pick != nil || it.location != nil {
                    HStack(spacing: theme.space(2)) {
                        if let tier = it.tier { Text("T\(tier)") }
                        if let pick {
                            Text(pick ? UIText.t("★ 추천", "★ pick") : UIText.t("겹침", "conflict"))
                                .padding(.horizontal, theme.space(1))
                                .background(pick ? Theme.planSage : Color.clear,
                                            in: RoundedRectangle(cornerRadius: theme.value("radiusSmall"), style: .continuous))
                                .foregroundStyle(pick ? Theme.paper : Theme.secondary)
                        }
                        if let location = it.location { Label(location, systemImage: "mappin") }
                    }
                    .themeText(.meta, design: .monospaced)
                    .foregroundStyle(Theme.secondary)
                }
                if let notes = it.notes {
                    RichText(source: notes, style: .meta).foregroundStyle(Theme.secondary)
                }
                if !it.tags.isEmpty {
                    FlowLayout(spacing: theme.space(1)) {
                        ForEach(it.tags, id: \.self) { tag in
                            Text(tag).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary)
                                .padding(.horizontal, theme.space(1.25))
                                .padding(.vertical, theme.space(0.25))
                                .background(Theme.secondary.opacity(0.12),
                                            in: RoundedRectangle(cornerRadius: theme.value("radiusSmall"), style: .continuous))
                        }
                    }
                }
            }
        }
        .padding(.leading, theme.space(2))
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: theme.value("radiusSmall"), style: .continuous).fill(planTierColor(it.tier)).frame(width: 3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassRow()
        .overlay {
            RoundedRectangle(cornerRadius: theme.value("radiusCard"), style: .continuous)
                .stroke(Theme.planSage, lineWidth: 1)
                .opacity(pick == true ? 1 : 0)
                .allowsHitTesting(false)
        }
        .glassRowLayout()
        .contextMenu { editButton(it) }
    }


}

private struct PlanEventLine: View {
    @Environment(\.appearanceTokens) private var theme
    let item: PlanEntry

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: theme.space(1)) {
            if let emoji = item.emoji { Text(emoji) }
            if let time = item.time { Text(time).fontWeight(theme.weight("textBadgeWeight")) }
            Text(item.title)
                .fontWeight(theme.weight(item.strong ? "textTitleWeight" : "textMetaWeight"))
                .foregroundStyle(item.kindColor)
        }
        .themeText(.meta)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

private struct PlanDaySheet: View {
    @Environment(\.appearanceTokens) private var theme
    let range: PlanRange
    let defaultSlug: String
    @ObservedObject var model: PlanModel
    @State private var editing: PlanDraft? = nil
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                LiquidRefreshHeader()
                ForEach(range.dates, id: \.self) { date in
                    Section {
                        let entries = model.entries(on: date)
                        if entries.isEmpty {
                            Text(UIText.t("일정 없음", "No events."))
                                .themeText(.meta).italic().foregroundStyle(Theme.secondary)
                                .glassRowLayout()
                        }
                        ForEach(entries) { row($0) }
                    } header: {
                        header(date)
                    }
                }
            }
            .liquidList()
            .accessibilityIdentifier("plans.day.scroll")
            .navigationTitle(range.label)
            .liquidSurface().inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(UIText.t("닫기", "Close")) { dismiss() }
                        .accessibilityIdentifier("plans.day.close")
                }
            }
            .sheet(item: $editing) { PlanEditor(draft: $0, model: model) }
        }
    }

    private func header(_ date: String) -> some View {
        return HStack(spacing: theme.space(1.5)) {
            Text(date.replacingOccurrences(of: "-", with: "/"))
            Text(planWeekdayLabel(date))
            Spacer()
            Button {
                editing = PlanDraft(date: date, slug: model.slug(for: date, fallback: defaultSlug), item: nil)
            } label: {
                Label(UIText.t("추가", "Add"), systemImage: "plus")
            }
            .buttonStyle(.plain)
        }
        .themeText(.meta, design: .monospaced)
        .foregroundStyle(Theme.secondary)
        .textCase(nil)
    }

    private func row(_ it: PlanEntry) -> some View {
        Button {
            editing = PlanDraft(date: it.date, slug: it.planSlug, item: it)
        } label: {
            VStack(alignment: .leading, spacing: theme.space(0.75)) {
                PlanEventLine(item: it)
                if let notes = it.notes {
                    RichText(source: notes, style: .meta).foregroundStyle(Theme.secondary)
                }
            }
            .strikethrough(it.archived)
            .opacity(it.archived ? 0.4 : 1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassRow()
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("plans.day.event.\(it.id)")
        .glassRowLayout()
        .swipeActions(edge: .trailing) {
            Button {
                Task { await model.run("plans:setArchived", ["itemId": it.id, "archived": !it.archived]) }
            } label: {
                Label(it.archived ? UIText.t("복원", "Restore") : UIText.t("보관", "Archive"),
                      systemImage: it.archived ? "tray.and.arrow.up" : "archivebox")
            }
            .tint(.gray)
        }
    }
}

private struct PlanEditor: View {
    @Environment(\.appearanceTokens) private var theme
    let draft: PlanDraft
    let model: PlanModel
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var date: String
    @State private var time: String
    @State private var location: String
    @State private var notes: String
    @State private var busy = false
    @State private var error: String? = nil

    init(draft: PlanDraft, model: PlanModel) {
        self.draft = draft
        self.model = model
        _title = State(initialValue: draft.item?.title ?? "")
        _date = State(initialValue: draft.item?.date ?? draft.date)
        _time = State(initialValue: draft.item?.time ?? "")
        _location = State(initialValue: draft.item?.location ?? "")
        _notes = State(initialValue: draft.item?.notes ?? "")
    }

    private var day: Binding<Date> {
        Binding(
            get: { planDate(date, planLocal) ?? Date() },
            set: { date = planString($0, planLocal) }
        )
    }

    private var name: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(UIText.t("제목", "Title"), text: $title)
                        .accessibilityIdentifier("plans.editor.title")
                    DatePicker(UIText.t("날짜", "Date"), selection: day, displayedComponents: .date)
                    TextField(UIText.t("시간 (예: 19:00)", "Time (e.g. 19:00)"), text: $time)
                        .keyboardType(.numbersAndPunctuation)
                    TextField(UIText.t("장소 (도시)", "Location (city)"), text: $location)
                    TextField(UIText.t("메모", "Notes"), text: $notes, axis: .vertical)
                        .lineLimit(3...8)
                } footer: {
                    if draft.item == nil {
                        Text(UIText.t("\(draft.slug) 플랜에 추가돼요.", "Goes into the \(draft.slug) plan."))
                    }
                }
                if let item = draft.item {
                    Section {
                        Button(item.archived ? UIText.t("복원", "Restore") : UIText.t("보관", "Archive")) {
                            Task { await act("plans:setArchived", ["itemId": item.id, "archived": !item.archived]) }
                        }
                        Button(UIText.t("삭제", "Delete"), role: .destructive) {
                            Task { await act("plans:deleteItem", ["itemId": item.id]) }
                        }
                    }
                    .disabled(busy)
                }
                if let error {
                    Section { LoadFailure(message: error) }
                }
            }
            .navigationTitle(draft.item == nil ? UIText.t("새 일정", "New event") : UIText.t("일정 편집", "Edit event"))
            .liquidSurface().inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(UIText.t("취소", "Cancel")) { dismiss() }
                        .accessibilityIdentifier("plans.editor.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(draft.item == nil ? UIText.t("추가", "Add") : UIText.t("저장", "Save")) {
                        Task { await save() }
                    }
                    .disabled(name.isEmpty || busy)
                    .accessibilityIdentifier(draft.item == nil ? "plans.editor.create" : "plans.editor.save")
                }
            }
        }
    }

    private func save() async {
        guard !name.isEmpty, !busy else { return }
        var args: [String: Any] = ["title": name, "date": date]
        for (key, value) in [("time", time), ("location", location), ("notes", notes)] {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { args[key] = trimmed }
        }
        if let item = draft.item {
            args["itemId"] = item.id
            await act("plans:updateItem", args)
        } else {
            args["slug"] = draft.slug
            await act("plans:createItem", args)
        }
    }

    private func act(_ path: String, _ args: [String: Any]) async {
        busy = true
        defer { busy = false }
        do {
            try await model.send(path, args)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
