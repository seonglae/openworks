import SwiftUI

private struct MailEntry: Identifiable {
    let id: String
    let from: String
    let subject: String
}

private func mailSender(_ from: String) -> String {
    var name = from
    if let lt = from.firstIndex(of: "<"), lt > from.startIndex { name = String(from[..<lt]) }
    return String(name.trimmingCharacters(in: .whitespaces).prefix(28))
}

@MainActor
private final class MailboxModel: ObservableObject {
    @Published var requestId: String?
    @Published var status = "starting"
    @Published var entries: [MailEntry] = []
    @Published var failure: String?
    @Published var error: String?
    @Published var adding: Set<String> = []
    @Published var added: Set<String> = []
    @Published var processingAll = false

    var loading: Bool { ["starting", "pending", "running"].contains(status) }
    var visible: [MailEntry] { entries.filter { !added.contains($0.id) } }

    func request() async {
        requestId = nil
        status = "starting"
        entries = []
        added = []
        failure = nil
        do {
            guard let obj = try await ConvexHTTP.mutation("mailbox:requestList") as? [String: Any],
                  let id = obj["id"] as? String else { throw ConvexError.shape }
            requestId = id
            status = "pending"
        } catch {
            if Task.isCancelled { return }
            status = "error"
            failure = error.localizedDescription
        }
    }

    func poll() async {
        guard let id = requestId else { return }
        do {
            guard let req = try await ConvexHTTP.query("mailbox:getRequest", args: ["id": id]) as? [String: Any] else { throw ConvexError.shape }
            guard id == requestId else { return }
            let status = (req["status"] as? String) ?? "pending"
            if status == "done" {
                let data = Data(((req["result"] as? String) ?? "[]").utf8)
                guard let list = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { throw ConvexError.shape }
                entries = list.compactMap { entry in
                    guard let id = entry["id"] as? String else { return nil }
                    return MailEntry(id: id, from: (entry["from"] as? String) ?? "", subject: (entry["subject"] as? String) ?? "")
                }
            } else if status == "error" {
                failure = (req["error"] as? String) ?? UIText.t("요청 실패", "Request failed")
            }
            self.status = status
        } catch {
            guard !Task.isCancelled else { return }
            status = "error"
            failure = error.localizedDescription
        }
    }

    func add(_ entry: MailEntry) async {
        guard !adding.contains(entry.id) else { return }
        adding.insert(entry.id)
        defer { adding.remove(entry.id) }
        do {
            try await ConvexHTTP.mutation("jobs:create", args: [
                "url": "https://mail.google.com/mail/u/0/#inbox/\(entry.id)",
                "title": entry.subject.isEmpty ? UIText.t("(제목 없음)", "(no subject)") : entry.subject,
                "type": "newsletter",
                "emailId": entry.id,
            ])
            try await ConvexHTTP.mutation("mailbox:requestMarkRead", args: ["emailId": entry.id])
            added.insert(entry.id)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func processAll() async {
        guard !processingAll else { return }
        processingAll = true
        defer { processingAll = false }
        for entry in visible where !adding.contains(entry.id) {
            await add(entry)
        }
    }
}

struct MailboxView: View {
    @Environment(\.appearanceTokens) private var theme
    @StateObject private var model = MailboxModel()

    init() {}

    var body: some View {
        TabNavigationStack {
            List {
                LiquidRefreshHeader()
                if let error = model.error {
                    LoadFailure(message: error)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .glassRow().glassRowLayout()
                }
                Section {
                    if model.loading {
                        ForEach(0..<4, id: \.self) { _ in
                            HStack(alignment: .firstTextBaseline, spacing: theme.value("rowGap")) {
                                ContentRowSkeleton()
                                Label(UIText.t("읽고 처리", "Read & process"), systemImage: "plus")
                                    .themeText(.action)
                                    .padding(theme.value("actionPadding"))
                                    .frame(minHeight: theme.value("actionBox") * theme.scale)
                                    .loadingPlaceholder()
                            }
                            .glassRow().glassRowLayout()
                            .loadingAccessibility("mailbox.loading", label: UIText.t("메일함 불러오는 중", "Loading mailbox"))
                        }
                    } else if model.status == "error" {
                        LoadFailure(message: model.failure ?? UIText.t("요청 실패", "Request failed")) { Task { await model.request() } }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .glassRow().glassRowLayout()
                    } else if model.visible.isEmpty {
                        Text(UIText.t("읽지 않은 newsletter가 없어요.", "No unread newsletters."))
                            .themeText(.meta).italic().foregroundStyle(Theme.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .glassRow().glassRowLayout()
                    } else {
                        ForEach(model.visible) { entry in
                            row(entry).glassRow().glassRowLayout()
                        }
                    }
                } header: {
                    Text(UIText.t("읽지 않은 newsletter", "Unread newsletters"))
                        .themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary).textCase(nil)
                }
                Text(UIText.t("읽고 처리하면 뉴스레터 목록에 추가하고 메일을 읽음으로 표시해요.",
                              "Read & process adds the newsletter to your list and marks the email read."))
                    .themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, theme.space(1))
                    .padding(.vertical, theme.space(2))
                    .glassRowLayout()
            }
            .liquidList()
            .accessibilityIdentifier("mailbox.scroll")
            .navigationTitle(UIText.t("메일함", "Inbox"))
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if !model.loading && !model.visible.isEmpty {
                        Button {
                            Task { await model.processAll() }
                        } label: {
                            if model.processingAll {
                                ProgressView()
                            } else {
                                Text(UIText.t("모두 처리 (\(model.visible.count))", "Process all (\(model.visible.count))"))
                            }
                        }
                        .disabled(model.processingAll)
                    }
                    Button {
                        Task { await model.request() }
                    } label: { ListIcon(systemName: "arrow.clockwise") }
                        .disabled(model.loading)
                }
            }
            .liquidRefreshable { await model.request() }
            .task { if model.requestId == nil { await model.request() } }
            .task(id: model.requestId) {
                guard model.requestId != nil else { return }
                while model.loading && !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(2))
                    if Task.isCancelled { return }
                    await model.poll()
                }
            }
        }
    }

    private func row(_ entry: MailEntry) -> some View {
        let busy = model.adding.contains(entry.id)
        return HStack(alignment: .firstTextBaseline, spacing: theme.value("rowGap")) {
            ListIcon(kind: "mailbox")
            VStack(alignment: .leading, spacing: theme.value("rowTextGap")) {
                Text(entry.subject.isEmpty ? UIText.t("(제목 없음)", "(no subject)") : entry.subject).themeText(.title).lineLimit(2)
                    .accessibilityIdentifier("mailbox.entry.\(entry.id)")
                Text(mailSender(entry.from)).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary).lineLimit(1)
            }
            Spacer(minLength: theme.space(2))
            Button {
                Task { await model.add(entry) }
            } label: {
                if busy {
                    ProgressView().controlSize(.small)
                } else {
                    Label(UIText.t("읽고 처리", "Read & process"), systemImage: "plus")
                        .themeText(.action)
                }
            }
            .buttonStyle(ThemeActionStyle())
            .tint(Theme.accent)
            .disabled(busy)
        }
    }
}
