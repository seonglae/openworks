import SwiftUI

struct PullRequest: Identifiable {
    let id: Int
    let repo: String
    let number: Int
    let title: String
    let url: URL?
    let author: String
    let labels: [String]
    let draft: Bool
    let updatedAt: String
    let comments: Int
    var mergeable: Bool?
    var behindBy = 0
    var additions = 0
    var deletions = 0
    var changedFiles = 0
    var checks: (pass: Int, total: Int, state: String)?

    init?(_ json: [String: Any]) {
        guard let id = (json["id"] as? NSNumber)?.intValue, let repo = json["repo"] as? String,
              let number = (json["number"] as? NSNumber)?.intValue else { return nil }
        self.id = id
        self.repo = repo
        self.number = number
        title = (json["title"] as? String) ?? "#\(number)"
        url = (json["url"] as? String).flatMap(URL.init(string:))
        author = (json["author"] as? String) ?? ""
        labels = json["labels"] as? [String] ?? []
        draft = json["draft"] as? Bool ?? false
        updatedAt = (json["updatedAt"] as? String) ?? ""
        comments = (json["comments"] as? NSNumber)?.intValue ?? 0
        mergeable = json["mergeable"] as? Bool
    }
}

@MainActor
final class PRModel: ObservableObject {
    @Published var repos: [(repo: String, prs: [PullRequest])] = []
    @Published var working: Set<String> = []
    @Published var error: String?
    @Published var loaded = false
    @Published private(set) var refreshID = 0

    func load() async {
        do {
            guard let grouped = try await ConvexHTTP.action("github:listOpenPRs") as? [String: [[String: Any]]] else {
                throw ConvexError.shape
            }
            repos = grouped.keys.sorted().compactMap { repo in
                let prs = (grouped[repo] ?? []).compactMap(PullRequest.init)
                return prs.isEmpty ? nil : (repo, prs)
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
        await loadWorking()
        await loadDetails()
        refreshID += 1
    }

    private func loadDetails() async {
        let prs = repos.flatMap(\.prs).map { ["repo": $0.repo, "number": $0.number] as [String: Any] }
        guard !prs.isEmpty else { return }
        do {
        guard let details = try await ConvexHTTP.action("github:listPRDetails", args: ["prs": prs]) as? [[String: Any]] else { throw ConvexError.shape }
        var byKey: [String: [String: Any]] = [:]
        for d in details {
            if let repo = d["repo"] as? String, let n = (d["number"] as? NSNumber)?.intValue { byKey["\(repo)#\(n)"] = d }
        }
        repos = repos.map { group in
            (group.repo, group.prs.map { pr in
                guard let d = byKey["\(pr.repo)#\(pr.number)"] else { return pr }
                var next = pr
                next.mergeable = d["mergeable"] as? Bool
                next.behindBy = (d["behindBy"] as? NSNumber)?.intValue ?? 0
                next.additions = (d["additions"] as? NSNumber)?.intValue ?? 0
                next.deletions = (d["deletions"] as? NSNumber)?.intValue ?? 0
                next.changedFiles = (d["changedFiles"] as? NSNumber)?.intValue ?? 0
                return next
            })
        }
        } catch { self.error = error.localizedDescription }
    }

    func loadChecks(_ repo: String) async {
        do {
        let prs = repos.first(where: { $0.repo == repo })?.prs ?? []
        for pr in prs where pr.checks == nil {
            guard let c = try await ConvexHTTP.action("github:getChecks", args: ["repo": pr.repo, "number": pr.number]) as? [String: Any] else { throw ConvexError.shape }
            guard let index = repos.firstIndex(where: { $0.repo == repo }),
                  let i = repos[index].prs.firstIndex(where: { $0.id == pr.id }) else { continue }
            repos[index].prs[i].checks = ((c["checksPass"] as? NSNumber)?.intValue ?? 0,
                                          (c["checksTotal"] as? NSNumber)?.intValue ?? 0,
                                          (c["checksState"] as? String) ?? "none")
        }
        } catch { self.error = error.localizedDescription }
    }

    func loadWorking() async {
        do {
        guard let jobs = try await ConvexHTTP.query("jobs:listOffset", args: ["type": "pr-fix", "archived": false, "skip": 0, "limit": 100]) as? [[String: Any]] else { throw ConvexError.shape }
        working = Set(jobs.filter { ["pending", "summarizing", "suggesting"].contains(($0["status"] as? String) ?? "") }
            .compactMap { $0["url"] as? String })
        } catch { self.error = error.localizedDescription }
    }

    func task(_ pr: PullRequest?, repo: String, action: String, prompt: String) async throws {
        var content: [String: Any] = ["repo": repo, "action": action, "prompt": prompt]
        if let pr {
            content["number"] = pr.number
            content["title"] = pr.title
        }
        let body = String(data: try JSONSerialization.data(withJSONObject: content), encoding: .utf8) ?? "{}"
        let url = pr?.url?.absoluteString ?? "https://github.com/\(repo)"
        let jobId = try await ConvexHTTP.mutation("jobs:create", args: ["url": url, "content": body, "type": "pr-fix"])
        if let jobId = jobId as? String, action == "ask" || action == "eval" {
            let message = action == "eval" ? "[eval] \(UIText.t("PR 평가", "PR evaluation"))" : prompt
            _ = try await ConvexHTTP.mutation("chats:send", args: ["jobId": jobId, "content": message])
        }
        await loadWorking()
    }
}

struct PRView: View {
    @Environment(\.appearanceTokens) private var theme
    @StateObject private var model = PRModel()
    @State private var expanded: Set<String> = []
    @State private var opened: Int?
    @State private var repoTask: String?
    @State private var repoPrompt = ""
    @State private var sending = false

    var body: some View {
        TabNavigationStack {
            List {
                LiquidRefreshHeader()
                if let error = model.error {
                    LoadFailure(message: error) { Task { await model.load() } }.glassRow().glassRowLayout()
                }
                if !model.loaded {
                    PRLoadingSkeleton()
                } else if model.repos.isEmpty && model.error == nil {
                    HStack(spacing: theme.value("rowGap")) {
                        ListIcon(kind: "pr").accessibilityHidden(true)
                        Text(UIText.t("열린 PR이 없어요", "No open pull requests")).themeText(.title)
                    }
                    .foregroundStyle(Theme.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("pr.empty")
                    .glassRow().glassRowLayout()
                } else {
                    ForEach(model.repos, id: \.repo) { group in
                        repositoryHeader(group.repo, count: group.prs.count)
                        if repoTask == group.repo {
                            VStack(alignment: .leading, spacing: theme.space(2)) {
                                TextField(UIText.t("이 저장소에 맡길 일", "A task for this repository"), text: $repoPrompt, axis: .vertical)
                                    .themeText(.title).lineLimit(2...6).accessibilityIdentifier("pr.repo.prompt")
                                HStack {
                                    Button(UIText.t("취소", "Cancel")) { repoTask = nil; repoPrompt = "" }
                                        .accessibilityIdentifier("pr.repo.cancel")
                                    Spacer()
                                    Button(UIText.t("보내기", "Send")) {
                                        sending = true
                                        Task {
                                            do {
                                                try await model.task(nil, repo: group.repo, action: "repo-task", prompt: repoPrompt.trimmingCharacters(in: .whitespacesAndNewlines))
                                                repoTask = nil
                                                repoPrompt = ""
                                            } catch { model.error = error.localizedDescription }
                                            sending = false
                                        }
                                    }.disabled(sending || repoPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                                        .accessibilityIdentifier("pr.repo.send")
                                }.buttonStyle(ThemeActionStyle())
                            }.glassRow().glassRowLayout()
                        }
                        if expanded.contains(group.repo) {
                            ForEach(group.prs) { pr in
                                PRCard(pr: pr, model: model, opened: $opened)
                                    .glassRow().glassRowLayout()
                            }
                        }
                    }
                }
            }
            .liquidList()
            .environment(\.defaultMinListRowHeight, 0)
            .accessibilityIdentifier("pr.scroll")
            .navigationTitle(UIText.t("PR", "PRs"))
            .liquidRefreshable {
                await model.load()
                for repo in expanded { await model.loadChecks(repo) }
            }
            .task { if !model.loaded { await model.load() } }

        }
    }

    private func repositoryHeader(_ repo: String, count: Int) -> some View {
        HStack(spacing: theme.value("rowGap")) {
            Button {
                if expanded.contains(repo) { expanded.remove(repo) } else {
                    expanded.insert(repo)
                    Task { await model.loadChecks(repo) }
                }
            } label: {
                HStack(spacing: theme.value("rowGap")) {
                    ConnectorBadge(type: "github").accessibilityHidden(true)
                    Text(repo).themeText(.meta, design: .monospaced).lineLimit(1).truncationMode(.middle)
                    Text(count, format: .number).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(expanded.contains(repo) ? UIText.t("펼쳐짐", "Expanded") : UIText.t("접힘", "Collapsed"))
            .accessibilityIdentifier("pr.repository.\(repo)")
            Button { repoTask = repo } label: { ListIcon(systemName: "plus.bubble") }
                .buttonStyle(.plain)
                .accessibilityLabel(UIText.t("저장소에 작업 맡기기", "Give the repository a task"))
                .accessibilityIdentifier("pr.task")
        }
        .foregroundStyle(Theme.secondary)
        .padding(.horizontal, theme.value("cardPaddingX"))
        .padding(.vertical, theme.value("cardPaddingY"))
        .glassRowLayout()
    }
}

private struct PRRow: View {
    @Environment(\.appearanceTokens) private var theme
    let pr: PullRequest
    let working: Bool
    var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: theme.value("rowTextGap")) {
            HStack(alignment: .firstTextBaseline, spacing: theme.value("rowGap")) {
                checkIcon
                Text(pr.title).themeText(.title).lineLimit(expanded ? nil : 2)
                Spacer(minLength: theme.space(1))
                if working { ProgressView().controlSize(.small) }
            }
            HStack(spacing: theme.space(2)) {
                Text("#\(pr.number)").themeText(.meta, design: .monospaced)
                Text(pr.author).themeText(.meta)
                if pr.draft { Text(UIText.t("초안", "Draft")).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary) }
                if pr.mergeable == true { Text(UIText.t("merge 가능", "mergeable")).themeText(.meta).foregroundStyle(Theme.success) }
                if pr.behindBy > 0 { Text(UIText.t("\(pr.behindBy) 뒤처짐", "\(pr.behindBy) behind")).themeText(.meta).foregroundStyle(Theme.warning) }
                if pr.additions + pr.deletions > 0 {
                    Text("+\(pr.additions)").themeText(.meta, design: .monospaced).foregroundStyle(Theme.success)
                    Text("−\(pr.deletions)").themeText(.meta, design: .monospaced).foregroundStyle(Theme.failure)
                }
                Spacer()
            }
            .foregroundStyle(Theme.secondary)
            .lineLimit(1)
            if !pr.labels.isEmpty {
                Text(pr.labels.joined(separator: " · ")).themeText(.meta).foregroundStyle(Theme.secondary).lineLimit(1)
            }
        }
    }

    @ViewBuilder
    private var checkIcon: some View {
        switch pr.checks?.state {
        case "success": ListIcon(systemName: "checkmark.circle.fill").foregroundStyle(Theme.success)
        case "failure": ListIcon(systemName: "xmark.circle.fill").foregroundStyle(Theme.failure)
        case "pending": ListIcon(systemName: "clock").foregroundStyle(Theme.warning)
        default: ListIcon(systemName: "circle.dashed").foregroundStyle(Theme.secondary)
        }
    }
}

private struct PRCard: View {
    @Environment(\.appearanceTokens) private var theme
    let pr: PullRequest
    @ObservedObject var model: PRModel
    @Binding var opened: Int?
    @State private var chats: [[String: Any]] = []
    @State private var chatsLoaded = false
    @State private var prompt = ""
    @State private var busy: String?
    @State private var error: String?

    private var expanded: Bool { opened == pr.id }
    private var working: Bool { pr.url.map { model.working.contains($0.absoluteString) } ?? false }

    var body: some View {
        VStack(alignment: .leading, spacing: theme.value("rowGap")) {
            HStack(alignment: .top, spacing: theme.value("rowGap")) {
                Button { opened = expanded ? nil : pr.id } label: {
                    PRRow(pr: pr, working: working, expanded: expanded)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue(expanded ? UIText.t("펼쳐짐", "Expanded") : UIText.t("접힘", "Collapsed"))
                .accessibilityIdentifier("pr.row.\(pr.repo).\(pr.number)")
                if expanded {
                    Button { opened = nil } label: { ListIcon(systemName: "chevron.up") }
                        .buttonStyle(.plain)
                        .accessibilityLabel(UIText.t("PR 접기", "Collapse pull request"))
                        .accessibilityIdentifier("pr.close")
                }
            }
            if expanded {
                actionRow
                if let error { LoadFailure(message: error) }
                if let c = pr.checks {
                    Text(UIText.t("검사 \(c.pass)/\(c.total) 통과", "Checks \(c.pass)/\(c.total) passing"))
                        .themeText(.meta).foregroundStyle(Theme.secondary)
                }
                if pr.changedFiles > 0 {
                    Text(UIText.t("파일 \(pr.changedFiles)개 · +\(pr.additions) −\(pr.deletions)", "\(pr.changedFiles) files · +\(pr.additions) −\(pr.deletions)"))
                        .themeText(.meta).foregroundStyle(Theme.secondary)
                }
                TextField(UIText.t("묻거나 고칠 것을 적으세요", "Ask, or describe a fix"), text: $prompt, axis: .vertical)
                    .themeText(.meta)
                    .lineLimit(1...5)
                    .padding(theme.value("actionPadding"))
                    .background(Theme.paper, in: RoundedRectangle(cornerRadius: theme.value("radiusControl")))
                    .disabled(working || busy != nil)
                    .accessibilityIdentifier("pr.prompt")
                if working {
                    Label(UIText.t("작업 중…", "Working…"), systemImage: "hourglass")
                        .themeText(.meta).foregroundStyle(Theme.secondary)
                }
                conversation
            }
        }
        .task(id: expanded ? model.refreshID : nil) { if expanded { await loadChats() } }
    }

    private var actionRow: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: theme.space(1)) { actions }
                .fixedSize(horizontal: true, vertical: false)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: theme.value("actionBox") * theme.scale), spacing: theme.space(1), alignment: .leading)],
                      alignment: .leading, spacing: theme.space(1)) {
                actions
            }
        }
    }

    private var actions: some View {
        Group {
            action("merge", UIText.t("스쿼시 병합", "Squash merge"), icon: "arrow.triangle.merge", tint: Theme.success, enabled: pr.mergeable == true && !pr.draft) {
                _ = try await ConvexHTTP.action("github:mergePR", args: ["repo": pr.repo, "number": pr.number, "method": "squash"])
            }
            action("rebase", UIText.t("브랜치 업데이트", "Update branch"), icon: "arrow.triangle.2.circlepath", enabled: pr.behindBy > 0) {
                _ = try await ConvexHTTP.action("github:updatePRBranch", args: ["repo": pr.repo, "number": pr.number])
            }
            action("close", UIText.t("PR 닫기", "Close pull request"), icon: "xmark", tint: Theme.failure) {
                _ = try await ConvexHTTP.action("github:closePR", args: ["repo": pr.repo, "number": pr.number])
            }
            if let url = pr.url {
                Link(destination: url) { PRActionIcon(icon: "arrow.up.right", tint: Theme.link) }
                    .buttonStyle(.plain)
                    .accessibilityLabel(UIText.t("GitHub에서 열기", "Open on GitHub"))
                    .accessibilityIdentifier("pr.action.github")
            }
            agent("ask", UIText.t("질문", "Ask"), icon: "bubble.left.and.bubble.right", needsText: true)
            agent("fix", UIText.t("수정", "Fix"), icon: "wrench.and.screwdriver", needsText: false)
            agent("eval", UIText.t("평가", "Evaluate"), icon: "checkmark.bubble", needsText: false)
        }
    }

    @ViewBuilder
    private var conversation: some View {
        if !chatsLoaded {
            VStack(alignment: .leading, spacing: theme.space(2)) {
                SkeletonText(role: .meta, lines: 2, width: 0.8)
                SkeletonText(role: .meta, width: 0.6)
            }.padding(theme.space(2.5)).background(Theme.paper, in: RoundedRectangle(cornerRadius: theme.value("radiusCard")))
        }
        ForEach(Array(chats.enumerated()), id: \.offset) { index, msg in
            let mine = (msg["role"] as? String) == "user"
            HStack(spacing: theme.value("rowGap")) {
                if mine { Spacer(minLength: theme.space(10)) }
                Text((msg["content"] as? String) ?? "")
                    .accessibilityIdentifier("pr.chat.\(index)")
                    .themeText(.meta)
                    .padding(.horizontal, theme.space(2.5)).padding(.vertical, theme.space(1.75))
                    .background(mine ? Theme.ink.opacity(0.08) : Theme.paper, in: RoundedRectangle(cornerRadius: theme.value("radiusCard")))
                if !mine { Spacer(minLength: theme.space(10)) }
            }
        }
    }

    private func loadChats() async {
        defer { chatsLoaded = true }
        guard let url = pr.url?.absoluteString else { return }
        do {
            guard let value = try await ConvexHTTP.query("chats:listByUrl", args: ["url": url]) as? [[String: Any]] else { throw ConvexError.shape }
            chats = value
            await model.loadWorking()
        } catch { self.error = error.localizedDescription }
    }

    private func action(_ key: String, _ label: String, icon: String, tint: Color = Theme.ink, enabled: Bool = true, _ work: @escaping () async throws -> Void) -> some View {
        Button { run(key, work) } label: {
            PRActionIcon(icon: icon, tint: tint, busy: busy == key)
        }
        .buttonStyle(.plain)
        .disabled(!enabled || busy != nil)
        .accessibilityLabel(label)
        .accessibilityIdentifier("pr.action.\(key)")
    }

    private func agent(_ key: String, _ label: String, icon: String, needsText: Bool) -> some View {
        Button { run(key) {
            try await model.task(pr, repo: pr.repo, action: key, prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines))
            prompt = ""
            await loadChats()
        } } label: {
            PRActionIcon(icon: icon, busy: busy == key)
        }
        .buttonStyle(.plain)
        .disabled(working || busy != nil || (needsText && prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
        .accessibilityLabel(label)
        .accessibilityIdentifier("pr.agent.\(key)")
    }

    private func run(_ key: String, _ work: @escaping () async throws -> Void) {
        guard busy == nil else { return }
        busy = key
        error = nil
        Task {
            do {
                try await work()
                if ["merge", "rebase", "close"].contains(key) {
                    if (key == "merge" || key == "close") && opened == pr.id { opened = nil }
                    await model.load()
                    await model.loadChecks(pr.repo)
                }
            } catch {
                self.error = error.localizedDescription
            }
            busy = nil
        }
    }
}

private struct PRActionIcon: View {
    @Environment(\.appearanceTokens) private var theme
    @Environment(\.isEnabled) private var enabled
    let icon: String
    var tint: Color = Theme.ink
    var busy = false

    var body: some View {
        Group {
            if busy { ProgressView().controlSize(.small) } else { ListIcon(systemName: icon) }
        }
        .frame(width: theme.value("actionBox") * theme.scale, height: theme.value("actionBox") * theme.scale)
        .foregroundStyle(tint)
        .background(tint.opacity(0.1), in: RoundedRectangle(cornerRadius: theme.value("radiusPill")))
        .opacity(enabled ? 1 : 0.45)
        .accessibilityHidden(true)
    }
}

private struct PRLoadingSkeleton: View {
    @Environment(\.appearanceTokens) private var theme

    var body: some View {
        VStack(spacing: theme.value("cardGap")) {
            ForEach(0..<3, id: \.self) { _ in
                HStack(spacing: theme.value("rowGap")) {
                    bar(width: theme.value("iconBox") * theme.scale, height: theme.value("iconBox") * theme.scale)
                    bar(width: theme.space(32), height: theme.value("textMetaSize") * theme.scale)
                    bar(width: theme.space(4), height: theme.value("textMetaSize") * theme.scale)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, theme.value("cardPaddingX"))
                .padding(.vertical, theme.value("cardPaddingY"))
                ForEach(0..<2, id: \.self) { _ in
                    VStack(alignment: .leading, spacing: theme.value("rowTextGap")) {
                        HStack(spacing: theme.value("rowGap")) {
                            bar(width: theme.value("iconBox") * theme.scale, height: theme.value("iconBox") * theme.scale)
                            bar(height: theme.value("textTitleSize") * theme.scale)
                        }
                        HStack(spacing: theme.space(2)) {
                            bar(width: theme.space(8), height: theme.value("textMetaSize") * theme.scale)
                            bar(width: theme.space(16), height: theme.value("textMetaSize") * theme.scale)
                            bar(width: theme.space(12), height: theme.value("textMetaSize") * theme.scale)
                        }
                    }
                    .glassRow()
                }
            }
        }
        .glassRowLayout()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(UIText.t("PR 불러오는 중", "Loading pull requests"))
        .accessibilityIdentifier("pr.loading")
    }

    private func bar(width: CGFloat? = nil, height: CGFloat) -> some View {
        Skeleton().frame(width: width, height: height)
            .clipShape(RoundedRectangle(cornerRadius: theme.value("radiusSmall")))
    }
}

