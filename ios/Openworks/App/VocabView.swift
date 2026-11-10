import SwiftUI

private struct VocabEntry: Identifiable {
    let id: String
    let en: String
    let jp: String?
    let reading: String?
    let meaning: String?
    let example: String?
    let due: String
    let pendingEnrich: Bool

    init?(_ row: [String: Any]) {
        guard let id = row["_id"] as? String, let en = row["en"] as? String else { return nil }
        func field(_ key: String) -> String? { (row[key] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        self.id = id
        self.en = en
        jp = field("jp")
        reading = field("reading")
        meaning = field("meaning")
        example = field("example")
        due = row["due"] as? String ?? ""
        pendingEnrich = row["pendingEnrich"] as? Bool ?? false
    }
}

@MainActor
private final class VocabModel: ObservableObject {
    @Published var entries: [VocabEntry] = []
    @Published var due: [VocabEntry] = []
    @Published var dueCount = 0
    @Published var total = 0
    @Published var savedDatabaseId: String?
    @Published var grading = false
    @Published var error: String?
    @Published var loaded = false

    func load() async {
        do {
            guard let due = try await ConvexHTTP.query("expressions:due", args: ["today": calendarDay()]) as? [String: Any],
                  let all = try await ConvexHTTP.query("expressions:list") as? [[String: Any]]
            else { throw ConvexError.shape }
            self.due = (due["due"] as? [[String: Any]] ?? []).compactMap(VocabEntry.init)
            dueCount = (due["dueCount"] as? NSNumber)?.intValue ?? self.due.count
            total = (due["total"] as? NSNumber)?.intValue ?? all.count
            entries = all.compactMap(VocabEntry.init)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        do {
            guard let connectors = try await ConvexHTTP.query("connectors:list") as? [[String: Any]] else { throw ConvexError.shape }
            let notion = connectors.first { $0["type"] as? String == "notion" }
            savedDatabaseId = (notion?["config"] as? [String: Any])?["databaseId"] as? String
        } catch { self.error = error.localizedDescription }
        loaded = true
    }

    func grade(_ entry: VocabEntry, _ grade: String) async {
        guard !grading else { return }
        grading = true
        do {
            try await ConvexHTTP.mutation("expressions:review", args: [
                "id": entry.id, "grade": grade, "today": calendarDay(),
            ])
        } catch {
            self.error = error.localizedDescription
            grading = false
            return
        }
        due.removeAll { $0.id == entry.id }
        dueCount = max(0, dueCount - 1)
        await load()
        grading = false
    }

    func add(en: String, jp: String, reading: String, meaning: String, example: String) async throws {
        var args: [String: Any] = ["en": en, "today": calendarDay()]
        for (key, value) in [("jp", jp), ("reading", reading), ("meaning", meaning), ("example", example)] where !value.isEmpty {
            args[key] = value
        }
        try await ConvexHTTP.mutation("expressions:add", args: args)
        await load()
    }

    func importLines(_ text: String) async throws -> (imported: Int, skipped: Int) {
        let lines = text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        var imported = 0
        for line in lines {
            let parts = line.split(separator: "|", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespaces) }
            guard let en = parts.first, !en.isEmpty else { continue }
            var args: [String: Any] = ["en": en, "today": calendarDay()]
            if parts.count > 1, !parts[1].isEmpty { args["jp"] = parts[1] }
            if parts.count > 2, !parts[2].isEmpty { args["meaning"] = parts[2] }
            try await ConvexHTTP.mutation("expressions:add", args: args)
            imported += 1
        }
        await load()
        return (imported, lines.count - imported)
    }

    func remove(_ entry: VocabEntry) async {
        do {
            try await ConvexHTTP.mutation("expressions:remove", args: ["id": entry.id])
        } catch {
            self.error = error.localizedDescription
            return
        }
        entries.removeAll { $0.id == entry.id }
        await load()
    }

    func export(_ id: String) async -> String {
        do {
            try await ConvexHTTP.mutation("connectors:setNotionConfig", args: ["databaseId": id])
            savedDatabaseId = id
            let result = try await ConvexHTTP.action("notion:exportVocab", args: ["databaseId": id]) as? [String: Any]
            let count = (result?["count"] as? NSNumber)?.intValue ?? 0
            return UIText.t("Notion에 \(count)개 내보냈어요.", "Exported \(count) to Notion.")
        } catch {
            return error.localizedDescription
        }
    }

    func importPage(_ pageId: String) async -> String {
        do {
            let result = try await ConvexHTTP.action("notion:importVocabFromNotion", args: ["pageId": pageId]) as? [String: Any]
            let imported = (result?["imported"] as? NSNumber)?.intValue ?? 0
            let found = (result?["found"] as? NSNumber)?.intValue ?? 0
            await load()
            return UIText.t("\(found)개 중 \(imported)개를 가져왔어요.", "Imported \(imported) of \(found).")
        } catch {
            return error.localizedDescription
        }
    }

    func saveDatabaseId(_ id: String) async -> String {
        do {
            try await ConvexHTTP.mutation("connectors:setNotionConfig", args: ["databaseId": id])
            savedDatabaseId = id
            return UIText.t("저장했어요.", "Saved.")
        } catch {
            return error.localizedDescription
        }
    }
}

struct VocabView: View {
    @Environment(\.appearanceTokens) private var theme
    @StateObject private var model = VocabModel()
    @State private var reviewing = false
    @State private var revealed: String?
    @State private var adding = false
    @State private var databaseId = ""
    @State private var notionNote: String?
    @State private var notionPage = ""

    private var trimmedDatabaseId: String { databaseId.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        TabNavigationStack {
            List {
                LiquidRefreshHeader()
                if let error = model.error {
                    LoadFailure(message: error)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .glassRow().glassRowLayout()
                }
                if model.error == nil || !model.entries.isEmpty {
                    summary.loadingPlaceholder(!model.loaded).glassRow().glassRowLayout()
                }
                if reviewing {
                    reviewCard.glassRow().glassRowLayout()
                }
                Section {
                    if !model.loaded {
                        ForEach(0..<4, id: \.self) { _ in
                            HStack(alignment: .firstTextBaseline, spacing: theme.value("rowGap")) {
                                SkeletonIcon()
                                VStack(alignment: .leading, spacing: theme.value("rowTextGap")) {
                                    SkeletonText(width: 0.8)
                                    SkeletonText(role: .meta, width: 0.6)
                                    SkeletonText(role: .meta, width: 0.9)
                                }
                                SkeletonText(role: .meta)
                                    .frame(width: theme.value("textMetaSize") * theme.scale * 5)
                            }
                            .glassRow().glassRowLayout()
                        }
                    }
                    ForEach(model.entries) { row($0) }
                    if model.loaded && model.entries.isEmpty && model.error == nil {
                        Text(UIText.t("아직 표현이 없어요. + 로 추가할 수 있어요.", "No expressions yet. Add one with +."))
                            .themeText(.title).foregroundStyle(Theme.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .glassRow().glassRowLayout()
                    }
                } header: {
                    if !model.loaded {
                        SkeletonText(role: .meta, width: 0.35)
                            .loadingAccessibility("vocab.loading", label: UIText.t("단어 불러오는 중", "Loading vocabulary"))
                    } else if model.error == nil || !model.entries.isEmpty {
                        header(UIText.t("전체", "All") + " · \(model.entries.count)")
                    }
                }
                Section {
                    notionRow.glassRow().glassRowLayout()
                } header: {
                    header("Notion")
                }
            }
            .liquidList()
            .accessibilityIdentifier("vocab.scroll")
            .navigationTitle(UIText.t("단어", "Vocab"))
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { adding = true } label: { ListIcon(systemName: "plus") }
                        .accessibilityLabel(UIText.t("표현 추가", "Add expression"))
                        .accessibilityIdentifier("vocab.add")
                }
            }
            .sheet(isPresented: $adding) { VocabAddSheet(model: model) }
            .onChange(of: model.savedDatabaseId) { _, saved in
                if let saved { databaseId = saved }
            }
            .liquidRefreshable { await model.load() }
            .task { await model.load() }
        }
    }

    private func header(_ text: String) -> some View {
        Text(text).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary).textCase(nil)
    }

    private var summary: some View {
        HStack(spacing: theme.space(2.5)) {
            Text(UIText.t("복습 \(model.dueCount) · 전체 \(model.total)", "\(model.dueCount) due · \(model.total) total"))
                .themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary)
            Spacer(minLength: theme.space(2))
            Button(reviewing ? UIText.t("복습 끝내기", "End review") : UIText.t("복습 시작", "Start review")) {
                reviewing.toggle()
                revealed = nil
            }
            .themeText(.title)
            .buttonStyle(ThemeActionStyle())
            .tint(Theme.accent)
            .disabled(!reviewing && model.dueCount == 0)
            .accessibilityIdentifier("vocab.review")
        }
    }

    private var reviewCard: some View {
        VStack(spacing: theme.space(1.5)) {
            if let card = model.due.first {
                Text(card.jp ?? card.en).themeText(.heading)
                if revealed == card.id {
                    if card.jp != nil { Text(card.en).themeText(.body) }
                    if let reading = card.reading {
                        Text(reading).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary)
                    }
                    if let meaning = card.meaning { Text(meaning).themeText(.title) }
                    if let example = card.example {
                        Text(example).themeText(.meta).italic().foregroundStyle(Theme.secondary)
                    }
                    HStack(spacing: theme.space(2)) {
                        gradeButton(card, "again", UIText.t("다시", "Again"))
                        gradeButton(card, "good", UIText.t("좋음", "Good"), primary: true)
                        gradeButton(card, "easy", UIText.t("쉬움", "Easy"))
                    }
                    .padding(.top, theme.space(2))
                } else {
                    Button(UIText.t("정답 보기", "Show answer")) { revealed = card.id }
                        .accessibilityIdentifier("vocab.review.answer")
                        .themeText(.title)
                        .buttonStyle(ThemeActionStyle())
                        .tint(Theme.accent)
                        .padding(.top, theme.space(2))
                }
            } else {
                Text(UIText.t("오늘 복습할 표현이 없어요.", "All caught up. Nothing due."))
                    .themeText(.title).foregroundStyle(Theme.secondary)
                    .padding(.vertical, theme.space(3))
            }
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.vertical, theme.space(2))
    }

    @ViewBuilder
    private func gradeButton(_ card: VocabEntry, _ grade: String, _ label: String, primary: Bool = false) -> some View {
        let button = Button(label) { Task { await model.grade(card, grade) } }
            .accessibilityIdentifier("vocab.review.grade.\(grade)")
            .themeText(.title)
            .disabled(model.grading)
        if primary {
            button.buttonStyle(ThemeActionStyle(prominent: true)).tint(Theme.accent).foregroundStyle(Theme.paper)
        } else {
            button.buttonStyle(ThemeActionStyle()).tint(Theme.accent)
        }
    }

    private func row(_ entry: VocabEntry) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: theme.value("rowGap")) {
            ListIcon(kind: "vocab")
            VStack(alignment: .leading, spacing: theme.value("rowTextGap")) {
                Text(entry.en).themeText(.title)
                    .accessibilityIdentifier("vocab.entry.\(entry.id)")
                if let jp = entry.jp {
                    Text(jp).themeText(.meta).foregroundStyle(Theme.secondary)
                }
                if let meaning = entry.meaning {
                    Text(meaning).themeText(.meta).foregroundStyle(Theme.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: theme.space(2))
            VStack(alignment: .trailing, spacing: theme.space(0.5)) {
                Text(UIText.t("복습 ", "due ") + String(entry.due.dropFirst(5)))
                    .themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary)
                if entry.pendingEnrich {
                    Text(UIText.t("채우는 중…", "enriching…"))
                        .themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassRow()
        .glassRowLayout()
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) {
                Task { await model.remove(entry) }
            } label: { Label(UIText.t("삭제", "Delete"), systemImage: "trash") }
        }
    }

    private var notionRow: some View {
        VStack(alignment: .leading, spacing: theme.space(2)) {
            HStack(spacing: theme.space(2)) {
                TextField(UIText.t("내보낼 Notion database id", "Notion database id"), text: $databaseId)
                    .themeText(.body, design: .monospaced)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button(UIText.t("저장", "Save")) {
                    let id = trimmedDatabaseId
                    Task { notionNote = await model.saveDatabaseId(id) }
                }
                .themeText(.title)
                .buttonStyle(ThemeActionStyle())
                .tint(Theme.accent)
                .disabled(trimmedDatabaseId.isEmpty || trimmedDatabaseId == model.savedDatabaseId)
                Button(UIText.t("내보내기", "Export")) {
                    let id = trimmedDatabaseId
                    Task { notionNote = await model.export(id) }
                }
                .themeText(.title)
                .buttonStyle(ThemeActionStyle(prominent: !trimmedDatabaseId.isEmpty))
                .tint(Theme.accent)
                .disabled(trimmedDatabaseId.isEmpty)
            }
            HStack(spacing: theme.space(2)) {
                TextField(UIText.t("가져올 Notion 페이지 id", "Notion page id to import from"), text: $notionPage)
                    .themeText(.body, design: .monospaced)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button(UIText.t("가져오기", "Import")) {
                    let page = notionPage.trimmingCharacters(in: .whitespacesAndNewlines)
                    Task {
                        notionNote = await model.importPage(page)
                        notionPage = ""
                    }
                }
                .themeText(.title)
                .buttonStyle(ThemeActionStyle())
                .disabled(notionPage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if let notionNote { Text(notionNote).themeText(.meta).foregroundStyle(Theme.secondary) }
        }
    }
}

private struct VocabAddSheet: View {
    @Environment(\.appearanceTokens) private var theme
    @ObservedObject var model: VocabModel
    @Environment(\.dismiss) private var dismiss
    @State private var en = ""
    @State private var jp = ""
    @State private var reading = ""
    @State private var meaning = ""
    @State private var example = ""
    @State private var added: String?
    @State private var bulk = ""
    @State private var bulkNote: String?
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool

    private func clean(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(UIText.t("영어", "English"), text: $en)
                        .accessibilityIdentifier("vocab.editor.english")
                        .focused($focused)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField(UIText.t("日本語 (선택)", "日本語 (optional)"), text: $jp)
                    TextField(UIText.t("읽기 / romaji", "reading / romaji"), text: $reading)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField(UIText.t("뜻 / 메모", "meaning / note"), text: $meaning)
                    TextField(UIText.t("예문", "example sentence"), text: $example, axis: .vertical)
                } header: {
                    Text(UIText.t("표현", "Expression"))
                } footer: {
                    Text(added ?? UIText.t("영어만 적으면 나머지는 채워져요.", "English alone is enough; the rest is filled in."))
                }

                Section {
                    TextEditor(text: $bulk)
                        .frame(minHeight: 110)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button(UIText.t("가져오기", "Import")) { Task { await importBulk() } }
                        .disabled(clean(bulk).isEmpty || busy)
                } header: {
                    Text(UIText.t("한 번에 여러 개", "Bulk import"))
                } footer: {
                    Text(bulkNote ?? UIText.t(
                        "한 줄에 하나: 영어만, 또는 en | jp | meaning",
                        "One per line: English alone, or en | jp | meaning"))
                }

                if let error {
                    Section { LoadFailure(message: error) }
                }
            }
            .navigationTitle(UIText.t("표현 추가", "Add expression"))
            .liquidSurface().inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(UIText.t("닫기", "Close")) { dismiss() }
                        .accessibilityIdentifier("vocab.editor.close")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(UIText.t("추가", "Add")) { Task { await submit() } }
                        .disabled(clean(en).isEmpty || busy)
                }
            }
            .task { focused = true }
        }
    }

    private func submit() async {
        busy = true
        defer { busy = false }
        let phrase = clean(en)
        do {
            try await model.add(en: phrase, jp: clean(jp), reading: clean(reading),
                                meaning: clean(meaning), example: clean(example))
            en = ""; jp = ""; reading = ""; meaning = ""; example = ""
            added = UIText.t("추가했어요: \(phrase)", "Added: \(phrase)")
            error = nil
            focused = true
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func importBulk() async {
        busy = true
        defer { busy = false }
        do {
            let result = try await model.importLines(bulk)
            bulk = ""
            bulkNote = result.skipped > 0
                ? UIText.t("\(result.imported)개 추가, 영어가 없는 \(result.skipped)줄은 건너뜀",
                           "Imported \(result.imported), skipped \(result.skipped) with no English side")
                : UIText.t("\(result.imported)개 추가", "Imported \(result.imported)")
            error = nil
        } catch {
            self.error = error.localizedDescription
            await model.load()
        }
    }
}
