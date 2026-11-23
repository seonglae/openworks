import AVFoundation
import Combine
import SwiftUI

// parity: feed
struct ReelsView: View {
    @Environment(\.appearanceTokens) private var theme
    @StateObject private var model = FeedModel(shuffled: true)
    @EnvironmentObject private var shell: Shell
    @Environment(\.scenePhase) private var scenePhase
    @State private var position: String?
    @State private var opened: String?
    @State private var diffs: [String: [[String: Any]]] = [:]
    @State private var deciding: Set<String> = []
    @State private var notices: [String: String] = [:]
    @State private var fetching: Set<String> = []
    @State private var leftAt: Date?

    private var current: String? { position ?? model.items.first?.key }

    private func playing(_ item: FeedItem) -> Bool {
        shell.tab == "feed" && current == item.key && scenePhase == .active
    }

    var body: some View {
        NavigationStack {
            Group {
                if !model.loaded && model.items.isEmpty {
                    FeedLoadingSkeleton()
                } else if model.loaded && model.items.isEmpty {
                    VStack(spacing: theme.space(2)) {
                        if let error = model.error {
                            Text(UIText.t("피드를 불러오지 못했어요", "The feed did not load")).themeText(.heading)
                            Text(error).themeText(.meta).foregroundStyle(.secondary).multilineTextAlignment(.center)
                            Button(UIText.t("다시 시도", "Try again")) { Task { await reload(reshuffle: true) } }
                                .buttonStyle(ThemeActionStyle(prominent: true))
                                .foregroundStyle(Theme.paper)
                                .padding(.top, theme.space(2))
                        } else {
                            Text(UIText.t("아직 새 소식이 없어요", "Nothing new yet")).themeText(.heading)
                        }
                    }
                    .padding(theme.space(8))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(LiquidBackground())
                } else {
                    ScrollView(.vertical) {
                        LiquidRefreshHeader()
                        LazyVStack(spacing: theme.space(0)) {
                            ForEach(Array(model.items.enumerated()), id: \.element.id) { index, item in
                                page(item)
                                    .containerRelativeFrame([.horizontal, .vertical])
                                    .id(item.key)
                                    .onAppear { appeared(item, index: index) }
                            }
                        }
                        .scrollTargetLayout()
                    }
                    .scrollTargetBehavior(.paging)
                    .scrollPosition(id: $position)
                    .onChange(of: position) { _, key in model.current = key }
                    .scrollIndicators(.hidden)
                    .accessibilityIdentifier("feed.scroll")
                    .liquidRefreshable(identifier: "feed.refresh.spinner") { await reload(reshuffle: true) }
                    .ignoresSafeArea(edges: .bottom)
                }
            }
            .liquidSurface()
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(item: $opened) { JobDetailView(jobId: $0) }
            // Shuffled once, not on every appearance: coming back from an
            // opened item or another tab re-ran this and dealt a new order
            // under the reader. Pull to refresh and a long absence still do.
            .task { if !model.loaded { await reload(reshuffle: true) } }
            .onChange(of: scenePhase) { _, phase in
                if phase == .background { leftAt = Date() }
                guard phase == .active else { return }
                let away = leftAt.map { Date().timeIntervalSince($0) > 600 } ?? false
                leftAt = nil
                Task { await reload(reshuffle: away) }
            }
        }
    }

    private func reload(reshuffle: Bool) async {
        await model.load(island: nil, reshuffle: reshuffle)
        guard reshuffle else { return }
        diffs = [:]
        position = model.items.first?.key
        if let first = model.items.first { appeared(first, index: 0) }
    }

    @ViewBuilder
    private func page(_ item: FeedItem) -> some View {
        if let clip = item.video {
            VideoReelPage(item: item, url: clip.url, active: playing(item)) {
                approve in Task { await decide(item, approve: approve) }
            }
        } else {
            ReelPage(item: item, suggestions: diffs[item.key], deciding: deciding, notice: notices[item.key]) {
                opened = item.jobId
            } onArchive: {
                Task { await model.archive(item) }
            } onDismiss: {
                Task { await model.dismiss(item) }
            } onVerdict: { suggestion, apply in
                Task { await settle(item, suggestion, apply: apply) }
            }
        }
    }

    private func loadDiffs(_ item: FeedItem, jobId: String) async {
        let rows = (try? await ConvexHTTP.suggestions(jobId: jobId)) ?? []
        diffs[item.key] = rows.filter { ["pending", "approved"].contains(($0["status"] as? String) ?? "pending") }
    }

    private func settle(_ item: FeedItem, _ suggestion: [String: Any], apply: Bool) async {
        if let insight = item.insightId {
            deciding.insert(insight)
            do {
                if apply { openInNotion(try await ConvexHTTP.placeInsight(id: insight)) } else { try await ConvexHTTP.dismissInsight(id: insight) }
                notices[item.key] = nil
                model.items.removeAll { $0.key == item.key }
            } catch {
                notices[item.key] = apply
                    ? UIText.t("넣지 못했어요: \(error.localizedDescription)", "Could not place: \(error.localizedDescription)")
                    : UIText.t("닫지 못했어요: \(error.localizedDescription)", "Could not dismiss: \(error.localizedDescription)")
            }
            deciding.remove(insight)
            return
        }
        guard let id = suggestion["_id"] as? String, let jobId = item.jobId else { return }
        deciding.insert(id)
        do {
            if apply { openInNotion(try await ConvexHTTP.approveSuggestion(id: id)) } else { try await ConvexHTTP.rejectSuggestion(id: id) }
            notices[item.key] = nil
        } catch {
            notices[item.key] = apply
                ? UIText.t("적용하지 못했어요: \(error.localizedDescription)", "Could not apply: \(error.localizedDescription)")
                : UIText.t("거절하지 못했어요: \(error.localizedDescription)", "Could not reject: \(error.localizedDescription)")
        }
        await loadDiffs(item, jobId: jobId)
        deciding.remove(id)
        if diffs[item.key]?.isEmpty == true, notices[item.key] == nil { await model.archive(item) }
    }

    // The Notion app opens on the block that landed; the https link is the
    // fallback when the app is not installed.
    private func openInNotion(_ url: URL?) {
        guard let url else { return }
        let app = URL(string: url.absoluteString.replacingOccurrences(of: "https://", with: "notion://"))
        UIApplication.shared.open(app ?? url, options: [:]) { opened in
            if !opened { UIApplication.shared.open(url) }
        }
    }

    private func decide(_ item: FeedItem, approve: Bool) async {
        guard let id = item.videoId else { return }
        if approve { try? await ConvexHTTP.approveVideo(id: id) } else { try? await ConvexHTTP.removeVideo(id: id) }
        await model.load(island: nil)
    }

    // The diffs of this page and the next two load ahead, so a page that has
    // them never opens on placeholders and changes shape under the reader.
    private func appeared(_ item: FeedItem, index: Int) {
        for ahead in model.items.dropFirst(index).prefix(3)
        where ahead.notion > 0 && diffs[ahead.key] == nil && !fetching.contains(ahead.key) {
            guard let jobId = ahead.jobId else { continue }
            fetching.insert(ahead.key)
            Task {
                await loadDiffs(ahead, jobId: jobId)
                fetching.remove(ahead.key)
            }
        }
        // The next page is asked for a few pages before the end, so the reel
        // does not stop on its last loaded page while it arrives.
        if index >= model.items.count - 4, model.more {
            Task { await model.loadMore(island: nil) }
        }
    }
}


// A text page of the feed: its content centred in the screen at full width,
// with the actions in a row under it. Its shape comes from the feed row alone,
// never from what loads after: a page with Notion edits holds their space with
// placeholders until they arrive, and a picture holds its frame at its own
// aspect ratio, so nothing on the page moves once it is drawn.
struct ReelPageLayout<Content: View>: View {
    @Environment(\.appearanceTokens) private var theme
    @ViewBuilder let content: () -> Content

    var body: some View {
        // From the top, with the same margin above as below: centred, a short card sat in an empty band, and the top
        // margin was four times the gap left above the tab bar. The bottom clears the floating tab bar (about 96).
        VStack(spacing: theme.space(4), content: content)
            .padding(.horizontal, theme.space(5))
            .padding(.top, theme.space(3))
            .padding(.bottom, 96 + theme.space(3))
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Theme.paper)
    }
}

private struct ReelPage: View {
    @Environment(\.appearanceTokens) private var theme
    let item: FeedItem
    let suggestions: [[String: Any]]?
    let deciding: Set<String>
    let notice: String?
    let onOpen: () -> Void
    let onArchive: () -> Void
    let onDismiss: () -> Void
    let onVerdict: ([String: Any], Bool) -> Void
    @Environment(\.openURL) private var openURL
    @State private var zoomed: ZoomTarget?

    private var isPaper: Bool { item.subtitle == "Paper" }
    // A paper's six role lines take the room of one edit on a phone screen.
    private var diffCount: Int { item.place != nil ? 1 : min(item.notion, item.roles.isEmpty ? 2 : 1) }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Theme.paper
            ReelPageLayout {
                if item.card.isEmpty {
                    VStack(spacing: theme.space(2.5)) {
                        HStack(alignment: .firstTextBaseline, spacing: theme.space(1.5)) {
                            IslandMark(key: item.island, inline: true)
                            Text(item.meta).themeText(.meta, design: .monospaced).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Text(item.title)
                            .themeText(.heading, design: .serif)
                            .multilineTextAlignment(.center)
                            .lineLimit(diffCount > 0 ? 3 : 4)
                    }
                    .frame(maxWidth: .infinity)
                    visual
                    if diffCount > 0 {
                        diffZone
                    } else {
                        VStack(alignment: .leading, spacing: theme.space(2)) {
                            ForEach(Array(item.lines.prefix(isPaper ? 2 : 4).enumerated()), id: \.offset) { _, line in
                                Text(.init(line)).themeText(.title).lineLimit(isPaper ? 3 : 5)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    Spacer(minLength: 0)
                    if let notice {
                        Text(notice).themeText(.meta).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    HStack(spacing: theme.value("actionGap")) {
                        if item.jobId != nil {
                            ReelAction(icon: "arrow.up.right", label: UIText.t("열기", "Open"), tint: Theme.accent, run: onOpen)
                            ReelAction(icon: "archivebox", label: UIText.t("보관", "Archive"), tint: Theme.accent, run: onArchive)
                        }
                        if item.insightId != nil {
                            ReelAction(icon: "xmark", label: UIText.t("닫기", "Dismiss"), tint: Theme.accent, run: onDismiss)
                        }
                    }
                    .padding(.top, theme.space(0.5))
                } else {
                    ForEach(Array(item.card.enumerated()), id: \.offset) { _, block in
                        blockView(block)
                    }
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { if item.jobId != nil { onOpen() } }
        }
        .fullScreenCover(item: $zoomed) { PhotoViewer(url: $0.url) }
    }

    // One block of the server's card, drawn natively; the order, labels,
    // colours and line limits all come from the server.
    @ViewBuilder
    private func blockView(_ block: CardBlock) -> some View {
        switch block {
        case let .header(title, lines):
            VStack(spacing: theme.space(2.5)) {
                HStack(alignment: .firstTextBaseline, spacing: theme.space(1.5)) {
                    IslandMark(key: item.island, inline: true)
                    Text(item.meta).themeText(.meta, design: .monospaced).foregroundStyle(.secondary).lineLimit(1)
                }
                Text(title)
                    .themeText(.heading, design: .serif)
                    .multilineTextAlignment(.center)
                    .lineLimit(lines)
            }
            .frame(maxWidth: .infinity)
        case let .figure(url, width, height, caption, minRatio, maxRatio):
            let ratio = max(minRatio, min(maxRatio, (width ?? 16) / max(height ?? 9, 1)))
            AsyncImage(url: url) { picture in
                picture.resizable().scaledToFit()
            } placeholder: {
                Skeleton()
            }
            .aspectRatio(ratio, contentMode: .fit)
            .frame(maxWidth: .infinity)
            .padding(theme.space(2))
            .background(Color.white, in: RoundedRectangle(cornerRadius: theme.value("radiusCard"), style: .continuous))
            .contentShape(Rectangle())
            .onTapGesture { zoomed = ZoomTarget(url: url) }
            if let caption {
                RichText(source: caption, style: .meta)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .fixedSize(horizontal: false, vertical: true)
                    .layoutPriority(1)
            }
        case let .image(url, height):
            if height > 0 {
                // The whole screenshot, taking the room the text leaves, rather than its top cropped into a strip.
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFit()
                    } else if phase.error != nil {
                        Image(systemName: "photo").foregroundStyle(.tertiary)
                    } else {
                        Skeleton()
                    }
                }
                .frame(maxWidth: .infinity, minHeight: height * 0.6, maxHeight: .infinity)
                .contentShape(Rectangle())
                .onTapGesture { zoomed = ZoomTarget(url: url) }
            }
        case let .formula(tex, caption, note):
            VStack(alignment: .leading, spacing: theme.space(2)) {
                RichText(source: "$$\(tex)$$", style: .body)
                    .frame(maxWidth: .infinity, minHeight: 56)
                if let caption {
                    RichText(source: caption, style: .meta)
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let note {
                    RichText(source: note, style: .meta)
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(theme.space(3))
            .background(Theme.card, in: RoundedRectangle(cornerRadius: theme.value("radiusCard"), style: .continuous))
        case let .roles(items):
            VStack(alignment: .leading, spacing: theme.space(1.25)) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, role in
                    HStack(alignment: .firstTextBaseline, spacing: theme.space(2)) {
                        Text(role.label)
                            .themeText(.badge)
                            .padding(.horizontal, theme.space(1.25)).padding(.vertical, theme.space(0.5))
                            .background(role.color.opacity(0.15), in: RoundedRectangle(cornerRadius: theme.value("radiusSmall")))
                            .foregroundStyle(role.color)
                        Text(.init(role.text)).themeText(.meta).lineLimit(role.lines)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .layoutPriority(1)
        case let .quote(text, lines):
            Text(.init(text)).themeText(.body).lineLimit(lines)
                .padding(.leading, theme.space(3))
                .overlay(alignment: .leading) { Rectangle().fill(Color.secondary.opacity(0.3)).frame(width: 2) }
                .frame(maxWidth: .infinity, alignment: .leading)
        case let .text(text, lines, subheadline):
            Text(.init(text)).themeText(subheadline ? .title : .body).lineLimit(lines)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1)
        case let .diffs(label, show, _, maxLines, more):
            cardDiffs(label: label, show: show, maxLines: maxLines, more: more)
        case let .actions(items):
            Spacer(minLength: 0)
            if let notice {
                Text(notice).themeText(.meta).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: theme.value("actionGap")) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, action in
                    if action.kind == "source", let url = action.url {
                        ReelAction(icon: action.icon, label: action.label, tint: Theme.accent) { openURL(url) }
                    } else if let run = run(action.kind) {
                        ReelAction(icon: action.icon, label: action.label, tint: Theme.accent, run: run)
                    }
                }
            }
            .padding(.top, theme.space(0.5))
        }
    }

    private func run(_ kind: String) -> (() -> Void)? {
        switch kind {
        case "open": onOpen
        case "archive": onArchive
        case "dismiss": onDismiss
        default: nil
        }
    }

    // The server says how many edits to show; loaded ones, or as many
    // placeholders of the same size until they arrive.
    private func cardDiffs(label: String, show: Int, maxLines: Int, more: String?) -> some View {
        VStack(alignment: .leading, spacing: theme.space(2.5)) {
            Text(label).themeText(.badge).foregroundStyle(.secondary)
            if let place = item.place {
                SuggestionDiff(suggestion: place, busy: deciding.contains(item.insightId ?? ""), maxLines: maxLines) {
                    onVerdict(place, true)
                } onReject: {
                    onVerdict(place, false)
                }
            } else if let suggestions {
                ForEach(Array(suggestions.prefix(show).enumerated()), id: \.offset) { _, suggestion in
                    SuggestionDiff(suggestion: suggestion,
                                   busy: deciding.contains((suggestion["_id"] as? String) ?? ""),
                                   maxLines: maxLines) {
                        onVerdict(suggestion, true)
                    } onReject: {
                        onVerdict(suggestion, false)
                    }
                }
            } else {
                ForEach(0..<show, id: \.self) { _ in
                    SuggestionDiff(suggestion: SuggestionDiff.placeholder, busy: false, maxLines: maxLines, onApply: {}, onReject: {})
                        .loadingPlaceholder()
                }
            }
            if let more {
                Button(action: onOpen) {
                    Text(more).themeText(.meta).underline()
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.link)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // A paper's figure in a frame of its own aspect ratio, or its key formula.
    @ViewBuilder
    private var visual: some View {
        if let figure = item.figure {
            let ratio = max(diffCount > 0 ? 2.2 : 1.3, min(3.2, (figure.width ?? 16) / max(figure.height ?? 9, 1)))
            AsyncImage(url: figure.url) { picture in
                picture.resizable().scaledToFit()
            } placeholder: {
                Skeleton()
            }
            .aspectRatio(ratio, contentMode: .fit)
            .frame(maxWidth: .infinity)
            .padding(theme.space(2))
            .background(Color.white, in: RoundedRectangle(cornerRadius: theme.value("radiusCard"), style: .continuous))
            if let caption = item.visualCaption ?? figure.caption {
                RichText(source: caption, style: .meta)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else if let image = item.image {
            AsyncImage(url: image) { phase in
                if let picture = phase.image {
                    picture.resizable().scaledToFit()
                } else {
                    Skeleton()
                }
            }
            .frame(maxWidth: .infinity, minHeight: 160, maxHeight: .infinity)
        } else if let formula = item.formula {
            VStack(alignment: .leading, spacing: theme.space(2)) {
                RichText(source: "$$\(formula)$$", style: .body)
                    .frame(maxWidth: .infinity, minHeight: 56)
                if let caption = item.visualCaption {
                    RichText(source: caption, style: .meta)
                        .frame(maxWidth: .infinity, maxHeight: 40, alignment: .topLeading)
                        .clipped()
                }
                if let note = item.formulaNote {
                    RichText(source: note, style: .meta)
                        .frame(maxWidth: .infinity, maxHeight: 64, alignment: .topLeading)
                        .clipped()
                }
            }
            .padding(theme.space(3))
            .background(Theme.card, in: RoundedRectangle(cornerRadius: theme.value("radiusCard"), style: .continuous))
        }
        if isPaper, !item.roles.isEmpty {
            RoleLines(roles: item.roles)
        } else if isPaper, diffCount > 0, item.lines.count > 1 {
            Text(.init(item.lines[1])).themeText(.title).lineLimit(2, reservesSpace: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        if item.insightId != nil, item.lines.count > 1 {
            Text(.init(item.lines[1])).themeText(.body).lineLimit(5)
                .padding(.leading, theme.space(3))
                .overlay(alignment: .leading) { Rectangle().fill(Color.secondary.opacity(0.3)).frame(width: 2) }
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // Loaded edits, or as many placeholders of the same size as the feed said there are.
    private var diffZone: some View {
        VStack(alignment: .leading, spacing: theme.space(2.5)) {
            Text(UIText.t("수정 제안 \(item.place != nil ? 1 : item.notion)건", "Edits · \(item.place != nil ? 1 : item.notion)"))
                .themeText(.badge)
                .foregroundStyle(.secondary)
            if let place = item.place {
                SuggestionDiff(suggestion: place, busy: deciding.contains(item.insightId ?? ""), maxLines: 4) {
                    onVerdict(place, true)
                } onReject: {
                    onVerdict(place, false)
                }
            } else if let suggestions {
                ForEach(Array(suggestions.prefix(2).enumerated()), id: \.offset) { _, suggestion in
                    SuggestionDiff(suggestion: suggestion,
                                   busy: deciding.contains((suggestion["_id"] as? String) ?? ""),
                                   maxLines: 4) {
                        onVerdict(suggestion, true)
                    } onReject: {
                        onVerdict(suggestion, false)
                    }
                }
            } else {
                ForEach(0..<diffCount, id: \.self) { _ in
                    SuggestionDiff(suggestion: SuggestionDiff.placeholder, busy: false, maxLines: 4, onApply: {}, onReject: {})
                        .loadingPlaceholder()
                }
            }
            Group {
                if item.notion > 2 {
                    Button(action: onOpen) {
                        Text(UIText.t("나머지 \(item.notion - 2)건은 열어서 보기", "Open to see the other \(item.notion - 2)")).themeText(.meta).underline()
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.link)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// Lucid's six roles and colours, each read whole.
private struct RoleLines: View {
    @Environment(\.appearanceTokens) private var theme
    let roles: [(key: String, text: String)]
    private static var meta: [String: (String, Color)] { [
        "problem": (UIText.t("문제", "Problem"), Color(red: 79 / 255, green: 124 / 255, blue: 196 / 255)),
        "motivation": (UIText.t("동기", "Motivation"), Color(red: 222 / 255, green: 152 / 255, blue: 24 / 255)),
        "insight": (UIText.t("통찰", "Insight"), Color(red: 224 / 255, green: 69 / 255, blue: 123 / 255)),
        "solution": (UIText.t("방법", "Solution"), Color(red: 26 / 255, green: 150 / 255, blue: 132 / 255)),
        "result": (UIText.t("결과", "Result"), Color(red: 104 / 255, green: 170 / 255, blue: 52 / 255)),
        "observation": (UIText.t("관찰", "Observation"), Color(red: 122 / 255, green: 132 / 255, blue: 150 / 255)),
    ] }

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space(1.25)) {
            ForEach(roles, id: \.key) { role in
                let (label, color) = Self.meta[role.key] ?? (role.key, .secondary)
                HStack(alignment: .firstTextBaseline, spacing: theme.space(2)) {
                    Text(label)
                        .themeText(.badge)
                        .padding(.horizontal, theme.space(1.25)).padding(.vertical, theme.space(0.5))
                        .background(color.opacity(0.15), in: RoundedRectangle(cornerRadius: theme.value("radiusSmall")))
                        .foregroundStyle(color)
                    Text(.init(role.text)).themeText(.meta).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ReelAction: View {
    @Environment(\.appearanceTokens) private var theme
    let icon: String
    let label: String
    let tint: Color
    var filled = false
    let run: () -> Void

    var body: some View {
        Button(action: run) {
            VStack(spacing: theme.value("actionGap")) {
                if filled {
                    ListIcon(systemName: icon)
                        .foregroundStyle(.white)
                        .frame(width: theme.value("actionBox") * theme.scale, height: theme.value("actionBox") * theme.scale)
                        .background(tint, in: RoundedRectangle(cornerRadius: theme.value("radiusPill")))
                } else {
                    ListIcon(systemName: icon)
                        .frame(width: theme.value("actionBox") * theme.scale, height: theme.value("actionBox") * theme.scale)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: theme.value("radiusPill")))
                }
                Text(label).themeText(.action)
            }
            .padding(theme.value("actionPadding"))
            .foregroundStyle(tint)
        }
        .buttonStyle(.plain)
    }
}

// parity: shorts
private struct VideoReelPage: View {
    @Environment(\.appearanceTokens) private var theme
    let item: FeedItem
    let active: Bool
    let onDecide: (Bool) -> Void
    @StateObject private var loop: LoopingPlayer
    @State private var paused = false

    init(item: FeedItem, url: URL, active: Bool, onDecide: @escaping (Bool) -> Void) {
        self.item = item
        self.active = active
        self.onDecide = onDecide
        _loop = StateObject(wrappedValue: LoopingPlayer(url: url))
    }

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            Color.black
            PlayerLayerView(player: loop.player)
                .contentShape(Rectangle())
                .onTapGesture { paused.toggle() }
            if paused {
                ListIcon(systemName: "play.fill")
                    .foregroundStyle(.white.opacity(0.85))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .allowsHitTesting(false)
            }
            VStack(alignment: .leading, spacing: theme.space(1.5)) {
                HStack(alignment: .firstTextBaseline, spacing: theme.space(1.5)) {
                    IslandMark(key: item.island, inline: true)
                    Text(item.meta).themeText(.meta, design: .monospaced).lineLimit(1)
                }
                .foregroundStyle(.white.opacity(0.8))
                Text(item.title).themeText(.title).foregroundStyle(.white).lineLimit(3)
            }
            .padding(.leading, theme.space(4.5))
            .padding(.trailing, theme.space(17.5))
            .padding(.bottom, theme.space(30))
            VStack(spacing: theme.space(5)) {
                if item.status == "draft" {
                    ReelAction(icon: "checkmark", label: UIText.t("공개 승인", "Approve publishing"), tint: .green, filled: true) { onDecide(true) }
                    ReelAction(icon: "xmark", label: UIText.t("거절", "Reject"), tint: .red, filled: true) { onDecide(false) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.trailing, theme.space(3.5))
            .padding(.bottom, theme.space(30))
        }
        .onAppear { sync() }
        .onChange(of: active) { _, _ in sync() }
        .onChange(of: paused) { _, _ in sync() }
        .onDisappear { loop.player.pause() }
    }

    private func sync() {
        if active && !paused { loop.player.play() } else { loop.player.pause() }
    }
}

final class LoopingPlayer: ObservableObject {
    let player = AVQueuePlayer()
    private var looper: AVPlayerLooper?

    init(url: URL) {
        looper = AVPlayerLooper(player: player, templateItem: AVPlayerItem(url: url))
    }
}

private struct PlayerLayerView: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context: Context) -> LayerView {
        let view = LayerView()
        view.playerLayer.videoGravity = .resizeAspect
        view.playerLayer.player = player
        return view
    }

    func updateUIView(_ view: LayerView, context: Context) {
        view.playerLayer.player = player
    }

    final class LayerView: UIView {
        override static var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }
}

private struct ZoomTarget: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

// A feed picture at full screen: pinch to zoom, tap or the button to close.
private struct PhotoViewer: View {
    @Environment(\.dismiss) private var dismiss
    let url: URL
    @State private var scale: CGFloat = 1
    @GestureState private var pinch: CGFloat = 1

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            AsyncImage(url: url) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFit()
                } else {
                    ProgressView().tint(.white)
                }
            }
            .scaleEffect(scale * pinch)
            .gesture(MagnificationGesture().updating($pinch) { value, state, _ in state = value }
                .onEnded { scale = max(1, min(5, scale * $0)) })
            .onTapGesture(count: 2) { scale = scale > 1 ? 1 : 2.5 }
            .onTapGesture { dismiss() }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.title3.weight(.semibold)).foregroundStyle(.white)
                    .padding(12).background(.ultraThinMaterial, in: Circle())
            }
            .padding()
        }
    }
}

// One row of Home as feed:list sends it.
struct FeedItem: Identifiable {
    let key: String
    let kind: String
    let island: String
    let at: Double
    let title: String
    let subtitle: String?
    let badge: String?
    let lines: [String]
    let tab: String?
    let jobId: String?
    let inputSource: [String: Any]?
    let insightId: String?
    let video: (url: URL, width: Double, height: Double)?
    let videoId: String?
    let status: String?
    let notion: Int
    /// A paper's figure, with its size when known so its frame is held before it loads.
    let figure: (url: URL, width: Double?, height: Double?, caption: String?)?
    let formula: String?
    let formulaNote: String?
    /// A paper's argument in Lucid's six roles, in order, and its picture's caption.
    let roles: [(key: String, text: String)]
    let visualCaption: String?
    let image: URL?
    /// An insight's proposed Notion placement, in the shape SuggestionDiff reads.
    let place: [String: Any]?
    /// The card the server composed, block by block; empty draws from the fields above.
    let card: [CardBlock]
    var id: String { key }

    init?(_ row: [String: Any]) {
        guard let key = row["key"] as? String, let kind = row["kind"] as? String,
              let island = row["island"] as? String, let title = row["title"] as? String else { return nil }
        self.key = key
        self.kind = kind
        self.island = island
        self.title = title
        at = (row["at"] as? Double) ?? 0
        subtitle = row["subtitle"] as? String
        badge = row["badge"] as? String
        lines = (row["lines"] as? [String]) ?? []
        tab = (row["open"] as? [String: Any])?["tab"] as? String
        jobId = row["jobId"] as? String
        inputSource = row["inputSource"] as? [String: Any]
        insightId = row["insightId"] as? String
        videoId = row["videoId"] as? String
        status = row["status"] as? String
        notion = (row["notion"] as? NSNumber)?.intValue ?? 0
        if let f = row["figure"] as? [String: Any], let link = (f["url"] as? String).flatMap(URL.init(string:)) {
            figure = (link, f["width"] as? Double, f["height"] as? Double, f["caption"] as? String)
        } else {
            figure = nil
        }
        formula = row["formula"] as? String
        formulaNote = row["formulaNote"] as? String
        let r = row["roles"] as? [String: Any] ?? [:]
        // Argument order ending on the takeaway; an older card's observation joins its result.
        roles = ["problem", "motivation", "solution", "result", "insight"].compactMap { k in
            guard let text = r[k] as? String else { return nil }
            if k == "result", let seen = r["observation"] as? String { return (k, "\(text) \(seen)") }
            return (k, text)
        }
        visualCaption = row["visualCaption"] as? String
        image = (row["image"] as? String).flatMap(URL.init(string:))
        if let p = row["place"] as? [String: Any] {
            place = p.merging(["status": "pending"]) { old, _ in old }
        } else {
            place = nil
        }
        if let clip = row["video"] as? [String: Any], let link = (clip["url"] as? String).flatMap(URL.init(string:)) {
            video = (link, (clip["width"] as? Double) ?? 16, (clip["height"] as? Double) ?? 9)
        } else {
            video = nil
        }
        card = (row["card"] as? [[String: Any]])?.compactMap(CardBlock.init) ?? []
    }

    var meta: String {
        let when = at > 0 ? UIText.relativeTime(at) : nil
        return [Island.label(island), subtitle, when].compactMap { $0 }.joined(separator: " · ")
    }
}

@MainActor
final class FeedModel: ObservableObject {
    @Published var upcoming: [FeedItem] = []
    @Published var items: [FeedItem] = []
    @Published var more = false
    @Published var loaded = false
    @Published var error: String?
    // A small first page paints at once; the rest come a page at a time.
    private static let firstPage = 8
    private static let nextPage = 12
    private var cursor: String?
    private var pages = 0
    private var paging = false
    /// The page the reel shows, whose row and its neighbours' stay as drawn.
    var current: String?
    private let shuffled: Bool
    private var rank: [String: Double] = [:]
    private var batch = 0.0

    init(shuffled: Bool = false) {
        self.shuffled = shuffled
    }

    func load(island: String?, reshuffle: Bool = false) async {
        do {
            if DemoMode.isEnabled && loaded {
                try await Task.sleep(for: .milliseconds(800))
            }
            let value = try await ConvexHTTP.feed(today: feedDay(), island: island, limit: Self.firstPage, mix: shuffled)
            upcoming = (value["upcoming"] as? [[String: Any]] ?? []).compactMap(FeedItem.init)
            var fresh = (value["items"] as? [[String: Any]] ?? []).compactMap(FeedItem.init)
            // The page in view and its neighbours keep the row they were drawn
            // from: a card whose Notion edit landed meanwhile turned from text
            // into a diff under the reader. Every other page takes the latest.
            if shuffled && !reshuffle, let at = items.firstIndex(where: { $0.key == current }) {
                let held = Set(items[max(0, at - 1)...min(items.count - 1, at + 1)].map(\.key))
                let shown = Dictionary(items.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
                fresh = fresh.map { latest in
                    guard held.contains(latest.key), var kept = shown[latest.key] else { return latest }
                    return kept
                }
            }
            // Rows that came with later pages stay until the reel starts over.
            let later = reshuffle || pages <= 1 ? [] : items.filter { row in !fresh.contains { $0.key == row.key } }
            if later.isEmpty {
                cursor = value["cursor"] as? String
                pages = 1
            }
            fresh += later
            items = shuffled && !DemoMode.isEnabled ? arrange(fresh, reshuffle: reshuffle) : fresh
            more = cursor != nil
            error = nil
        } catch is CancellationError {
            retry(island: island, reshuffle: reshuffle)
            return
        } catch let failure as URLError where failure.code == .cancelled {
            retry(island: island, reshuffle: reshuffle)
            return
        } catch {
            self.error = error.localizedDescription
        }
        // A visible first page can paint before an empty stream follows its
        // cursor. Keep skeletons only when there is genuinely nothing yet.
        loaded = !items.isEmpty || !upcoming.isEmpty || cursor == nil || error != nil
        if items.isEmpty, cursor != nil { await loadMore(island: island) }
        loaded = true
    }

    private func retry(island: String?, reshuffle: Bool) {
        Task {
            try? await Task.sleep(for: .milliseconds(400))
            await load(island: island, reshuffle: reshuffle)
        }
    }

    // The next page; one that brought nothing to show is followed at once by
    // the one after it, so the reel never ends on a page of nothing.
    func loadMore(island: String?) async {
        guard !paging else { return }
        paging = true
        defer { paging = false }
        while let after = cursor {
            guard let value = try? await ConvexHTTP.feed(today: feedDay(), island: island, limit: Self.nextPage,
                                                         mix: shuffled, cursor: after) else { return }
            let known = Set(items.map(\.key))
            let fresh = (value["items"] as? [[String: Any]] ?? []).compactMap(FeedItem.init).filter { !known.contains($0.key) }
            cursor = value["cursor"] as? String
            pages += 1
            more = cursor != nil
            items = shuffled ? arrange(items + fresh, reshuffle: false) : items + fresh
            if !fresh.isEmpty { return }
        }
    }

    private func arrange(_ fresh: [FeedItem], reshuffle: Bool) -> [FeedItem] {
        if reshuffle {
            rank = [:]
            batch = 0
        }
        let unseen = fresh.filter { rank[$0.key] == nil }
        for item in unseen { rank[item.key] = batch + Double.random(in: 0..<1) }
        if !unseen.isEmpty { batch += 1 }
        return fresh.sorted { rank[$0.key, default: 0] < rank[$1.key, default: 0] }
    }

    func archive(_ item: FeedItem) async {
        guard let id = item.jobId else { return }
        items.removeAll { $0.key == item.key }
        try? await ConvexHTTP.archive(jobId: id)
    }

    func dismiss(_ item: FeedItem) async {
        guard let id = item.insightId else { return }
        items.removeAll { $0.key == item.key }
        try? await ConvexHTTP.dismissInsight(id: id)
    }
}

// The phone's own calendar day, which is the day the feed's upcoming rows are read for.
func feedDay(_ date: Date = Date()) -> String {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = .current
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: date)
}
