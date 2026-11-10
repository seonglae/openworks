import PhotosUI
import SwiftUI
import UIKit

struct DietEntry: Identifiable {
    let id: String
    let name: String?
    let status: String
    let kcal: Double?
    let protein: Double?
    let carbs: Double?
    let fat: Double?
    let notes: String?
    let hasImage: Bool
}

struct DietTotals {
    var kcal = 0.0
    var protein = 0.0
    var carbs = 0.0
    var fat = 0.0
}

private func dietNumber(_ value: Any?) -> Double? { (value as? NSNumber)?.doubleValue }

@MainActor
final class DietModel: ObservableObject {
    @Published var date = Date()
    @Published var entries: [DietEntry] = []
    @Published var totals = DietTotals()
    @Published var trend: [(date: String, kcal: Double)] = []
    @Published var images: [String: URL] = [:]
    @Published var failedImages: Set<String> = []
    @Published var error: String?
    @Published var loaded = false
    @Published var trendLoaded = false
    @Published var busy = false
    private var shownDay: String?

    var day: String { calendarDay(date) }

    var waiting: Bool { entries.contains { $0.status == "pending" || $0.status == "analyzing" } }

    func load() async {
        let date = self.date
        let day = calendarDay(date)
        let from = calendarDay(Calendar.current.date(byAdding: .day, value: -13, to: date) ?? date)
        if day != shownDay {
            entries = []
            trend = []
            loaded = false
            trendLoaded = false
        }
        error = nil
        async let list: Void = loadDay(day)
        async let chart: Void = loadTrend(from: from, to: day)
        await list
        await chart
        await loadImages()
    }

    private func loadDay(_ day: String) async {
        do {
            guard let value = try await ConvexHTTP.query("diet:listByDate", args: ["date": day]) as? [String: Any],
                  let rows = value["entries"] as? [[String: Any]]
            else { throw ConvexError.shape }
            guard day == self.day else { return }
            entries = rows.compactMap { e in
                guard let id = e["_id"] as? String else { return nil }
                return DietEntry(
                    id: id, name: e["name"] as? String, status: e["status"] as? String ?? "pending",
                    kcal: dietNumber(e["kcal"]), protein: dietNumber(e["protein"]),
                    carbs: dietNumber(e["carbs"]), fat: dietNumber(e["fat"]),
                    notes: e["notes"] as? String, hasImage: e["imageId"] is String)
            }
            let t = value["totals"] as? [String: Any] ?? [:]
            totals = DietTotals(kcal: dietNumber(t["kcal"]) ?? 0, protein: dietNumber(t["protein"]) ?? 0,
                                carbs: dietNumber(t["carbs"]) ?? 0, fat: dietNumber(t["fat"]) ?? 0)
            shownDay = day
        } catch {
            guard !Task.isCancelled, day == self.day else { return }
            self.error = error.localizedDescription
        }
        loaded = true
    }

    private func loadTrend(from: String, to day: String) async {
        do {
            guard let rows = try await ConvexHTTP.query("diet:dailyTotals", args: ["from": from, "to": day])
                as? [[String: Any]] else { throw ConvexError.shape }
            guard day == self.day else { return }
            trend = rows.compactMap { r in
                guard let d = r["date"] as? String else { return nil }
                return (date: d, kcal: dietNumber(r["kcal"]) ?? 0)
            }
        } catch {
            guard !Task.isCancelled, day == self.day else { return }
            self.error = error.localizedDescription
        }
        trendLoaded = true
    }

    private func loadImages() async {
        for entry in entries where entry.hasImage && images[entry.id] == nil {
            do {
                guard let link = try await ConvexHTTP.query("diet:imageUrl", args: ["entryId": entry.id]) as? String,
                      let url = URL(string: link) else { throw ConvexError.shape }
                images[entry.id] = url
                failedImages.remove(entry.id)
            } catch {
                failedImages.insert(entry.id)
                self.error = error.localizedDescription
            }
        }
    }

    func log(name: String) async {
        do {
            try await ConvexHTTP.mutation("diet:createEntry", args: ["date": day, "name": name])
            error = nil
        } catch {
            self.error = error.localizedDescription
            return
        }
        await load()
    }

    func remove(_ entry: DietEntry) async {
        do {
            try await ConvexHTTP.mutation("diet:remove", args: ["entryId": entry.id])
        } catch {
            self.error = error.localizedDescription
            return
        }
        await load()
    }

    func addPhoto(_ item: PhotosPickerItem) async {
        let day = self.day
        busy = true
        defer { busy = false }
        do {
            guard let raw = try await item.loadTransferable(type: Data.self),
                  let jpeg = UIImage(data: raw)?.jpegData(compressionQuality: 0.8)
            else { throw ConvexError.shape }
            let link = try await ConvexHTTP.mutation("diet:generateUploadUrl") as? String
            guard let target = link.flatMap(URL.init(string:)) else { throw ConvexError.shape }
            var request = URLRequest(url: target)
            request.httpMethod = "POST"
            request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
            let (data, _) = try await URLSession.shared.upload(for: request, from: jpeg)
            let reply = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            guard let storageId = reply?["storageId"] as? String else { throw ConvexError.shape }
            try await ConvexHTTP.mutation("diet:createEntry", args: ["imageId": storageId, "date": day])
            error = nil
        } catch {
            self.error = error.localizedDescription
            return
        }
        await load()
    }
}

struct DietView: View {
    @Environment(\.appearanceTokens) private var theme
    @StateObject private var model = DietModel()
    @State private var name = ""
    @State private var pick: PhotosPickerItem?
    @State private var pickedDay: String?

    private var typed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        TabNavigationStack {
            List {
                LiquidRefreshHeader()
                if let error = model.error {
                    LoadFailure(message: error)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .glassRow().glassRowLayout()
                }
                controls.glassRow().glassRowLayout()
                totalsCard.loadingPlaceholder(!model.loaded).glassRow().glassRowLayout()
                Section {
                    if !model.loaded {
                        ForEach(0..<3, id: \.self) { _ in
                            ContentRowSkeleton(titleLines: 1, imageIcon: true, spacerUnits: 0).glassRow().glassRowLayout()
                                .loadingAccessibility("diet.loading", label: UIText.t("식단 불러오는 중", "Loading food entries"))
                        }
                    } else if model.entries.isEmpty {
                        if model.error == nil {
                            Text(UIText.t("이 날은 기록한 음식이 없어요.", "No food logged for this day."))
                                .themeText(.meta).italic().foregroundStyle(Theme.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .glassRow().glassRowLayout()
                        }
                    } else {
                        ForEach(model.entries) { entry in
                            DietEntryRow(entry: entry, image: model.images[entry.id], imageFailed: model.failedImages.contains(entry.id))
                                .glassRow().glassRowLayout()
                                .swipeActions(edge: .trailing) {
                                    Button(role: .destructive) {
                                        Task { await model.remove(entry) }
                                    } label: { Label(UIText.t("삭제", "Delete"), systemImage: "trash") }
                                }
                                .contextMenu {
                                    Button(role: .destructive) {
                                        Task { await model.remove(entry) }
                                    } label: { Label(UIText.t("삭제", "Delete"), systemImage: "trash") }
                                }
                        }
                    }
                } header: {
                    header(UIText.t("기록", "Log") + " · \(model.day)")
                }
                Section {
                    trendCard.glassRow().glassRowLayout()
                } header: {
                    header(UIText.t("최근 14일 · kcal", "Last 14 days · kcal"))
                }
            }
            .liquidList()
            .accessibilityIdentifier("diet.scroll")
            .navigationTitle(UIText.t("식단", "Diet"))
            .liquidRefreshable { await model.load() }
            .task(id: model.day) { await model.load() }
            .task(id: model.waiting) {
                while model.waiting && !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(4))
                    if Task.isCancelled { return }
                    await model.load()
                }
            }
            .onChange(of: pick) { _, item in
                guard let item else { return }
                pick = nil
                Task { await model.addPhoto(item) }
            }
        }
    }

    private var controls: some View {
        let photoLabel = model.busy ? UIText.t("올리는 중…", "Uploading…") : UIText.t("사진", "Photo")
        return VStack(spacing: theme.space(2.5)) {
            HStack(spacing: theme.space(2.5)) {
                DatePicker(UIText.t("날짜", "Date"), selection: $model.date, displayedComponents: .date)
                    .labelsHidden()
                Button(UIText.t("오늘", "Today")) { model.date = Date() }
                    .themeText(.meta, design: .monospaced)
                    .buttonStyle(.borderless)
                    .tint(Theme.accent)
                Spacer(minLength: theme.space(0))
                PhotosPicker(selection: $pick, matching: .images) {
                    Label(photoLabel, systemImage: "photo.badge.plus")
                        .themeText(.title)
                }
                .buttonStyle(.borderless)
                .tint(Theme.accent)
                .disabled(model.busy)
            }
            HStack(spacing: theme.space(2.5)) {
                TextField(UIText.t("또는 음식 이름을 입력…", "or type a food name…"), text: $name)
                    .submitLabel(.done)
                    .onSubmit(logTyped)
                Button(UIText.t("기록", "Log"), action: logTyped)
                    .themeText(.title)
                    .buttonStyle(.borderless)
                    .tint(Theme.accent)
                    .disabled(typed.isEmpty)
            }
        }
    }

    private func logTyped() {
        let food = typed
        guard !food.isEmpty else { return }
        name = ""
        Task { await model.log(name: food) }
    }

    private var totalsCard: some View {
        HStack(spacing: theme.space(2)) {
            figure(model.totals.kcal, UIText.t("kcal", "kcal"))
            figure(model.totals.protein, UIText.t("g 단백질", "g protein"))
            figure(model.totals.carbs, UIText.t("g 탄수화물", "g carbs"))
            figure(model.totals.fat, UIText.t("g 지방", "g fat"))
        }
    }

    private func figure(_ value: Double, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: theme.space(0.5)) {
            Text(model.loaded ? "\(Int(value.rounded()))" : "…")
                .themeText(.heading).monospacedDigit()
                .lineLimit(1).minimumScaleFactor(0.6)
            Text(label).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var trendCard: some View {
        let days = model.trend
        let peak = max(days.map(\.kcal).max() ?? 1, 1)
        let picked = days.first { $0.date == pickedDay }
        return VStack(alignment: .leading, spacing: theme.space(1.5)) {
            if !model.trendLoaded {
                SkeletonText(role: .meta, width: 0.5)
                SkeletonChart(height: theme.space(24), bars: 14)
            } else if days.isEmpty {
                if model.error == nil {
                    Text(UIText.t("아직 기록이 없어요.", "No history yet."))
                        .themeText(.meta).italic().foregroundStyle(Theme.secondary)
                }
            } else {
                Text(picked.map { d in UIText.t("\(d.date): \(Int(d.kcal.rounded())) kcal", "\(d.date): \(Int(d.kcal.rounded())) kcal") } ?? " ")
                    .themeText(.meta).monospacedDigit().foregroundStyle(Theme.secondary)
                HStack(alignment: .bottom, spacing: theme.space(1)) {
                    ForEach(days, id: \.date) { d in
                        VStack(spacing: theme.space(0.75)) {
                            Spacer(minLength: theme.space(0))
                            RoundedRectangle(cornerRadius: theme.value("radiusSmall"), style: .continuous)
                                .fill(Theme.accent.opacity(d.date == pickedDay ? 0.85 : 0.5))
                                .frame(maxWidth: 24)
                                .frame(height: CGFloat(max(2, 80 * d.kcal / peak)))
                            Text(String(d.date.dropFirst(5)))
                                .themeText(.meta).monospacedDigit()
                                .foregroundStyle(Theme.secondary)
                                .lineLimit(1).minimumScaleFactor(0.5)
                        }
                        .frame(maxWidth: .infinity)
                        .contentShape(Rectangle())
                        .onTapGesture { pickedDay = pickedDay == d.date ? nil : d.date }
                    }
                }
                .frame(height: 96)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func header(_ text: String) -> some View {
        Text(text).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary).textCase(nil)
    }
}

private struct DietEntryRow: View {
    @Environment(\.appearanceTokens) private var theme
    let entry: DietEntry
    let image: URL?
    let imageFailed: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: theme.value("rowGap")) {
            Group {
                if entry.hasImage {
                    HeldImage(url: image, height: theme.value("iconBox") * theme.scale, failed: imageFailed)
                } else {
                    ListIcon(systemName: "text.alignleft").foregroundStyle(Theme.secondary)
                }
            }
            .frame(width: theme.value("iconBox") * theme.scale, height: theme.value("iconBox") * theme.scale)
            .clipShape(RoundedRectangle(cornerRadius: theme.value("radiusControl"), style: .continuous))
            .alignmentGuide(.firstTextBaseline) { $0.height / 2 + theme.iconBaselineOffset }
            VStack(alignment: .leading, spacing: theme.value("rowTextGap")) {
                HStack(spacing: theme.space(1.5)) {
                    Text(entry.name ?? (entry.status == "done" ? UIText.t("알 수 없는 음식", "Unknown food") : "…"))
                        .accessibilityIdentifier("diet.entry.\(entry.id)")
                        .themeText(.title).lineLimit(1)
                    if entry.status != "done" { statusPill }
                }
                Text(macros).themeText(.meta).monospacedDigit().foregroundStyle(Theme.secondary).lineLimit(1)
                if let notes = entry.notes, !notes.isEmpty {
                    Text(notes).themeText(.meta).foregroundStyle(Theme.secondary).lineLimit(2)
                }
            }
            Spacer(minLength: theme.space(0))
        }
    }

    private var macros: String {
        var parts = [entry.kcal.map { k in UIText.t("\(Int(k.rounded())) kcal", "\(Int(k.rounded())) kcal") }
            ?? UIText.t("분석 중…", "analyzing…")]
        if let p = entry.protein { parts.append(UIText.t("단 \(Int(p.rounded()))g", "P \(Int(p.rounded()))g")) }
        if let c = entry.carbs { parts.append(UIText.t("탄 \(Int(c.rounded()))g", "C \(Int(c.rounded()))g")) }
        if let f = entry.fat { parts.append(UIText.t("지 \(Int(f.rounded()))g", "F \(Int(f.rounded()))g")) }
        return parts.joined(separator: " · ")
    }

    private var statusPill: some View {
        let label: String
        switch entry.status {
        case "pending": label = UIText.t("대기", "pending")
        case "analyzing": label = UIText.t("분석 중", "analyzing")
        case "error": label = UIText.t("오류", "error")
        default: label = entry.status
        }
        let tone = Theme.statusColor(entry.status)
        return Text(label)
            .themeText(.badge)
            .padding(.horizontal, theme.space(1.75))
            .padding(.vertical, theme.space(0.5))
            .background(tone.opacity(0.15), in: RoundedRectangle(cornerRadius: theme.value("radiusPill")))
            .foregroundStyle(tone)
    }
}
