import SwiftUI

@MainActor
final class ResearchModel: ObservableObject {
    @Published var kind = "own"
    @Published var states: [String] = []
    @Published var labels: [String: String] = [:]
    @Published var projects: [[String: Any]] = []
    @Published var error: String?
    @Published var loaded = false

    func load() async {
        do {
            guard let list = try await ConvexHTTP.query("research:listByKind", args: ["kind": kind]) as? [[String: Any]] else { throw ConvexError.shape }
            projects = list
            if let slug = list.first?["slug"] as? String,
               let info = try await ConvexHTTP.query("research:getStateInfo", args: ["slug": slug]) as? [String: Any] {
                states = info["allStates"] as? [String] ?? []
            } else {
                states = [kind == "own" ? "ideation" : "setup"]
            }
            for phase in list.compactMap({ $0["phase"] as? String }) where !states.contains(phase) { states.append(phase) }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    func label(_ state: String) -> String {
        let names: [String: (String, String)] = [
            "ideation": ("아이디어", "Idea generation"), "literature": ("문헌 검토", "Literature review"),
            "poc": ("타당성 검증", "Feasibility"), "exp_plan": ("실험 계획", "Experiment plan"),
            "design": ("실험 설계", "Experiment design"), "setup": kind == "own" ? ("실험 준비", "Experiment setup") : ("논문 준비", "Paper setup"),
            "run": ("실험 실행", "Experiment run"), "analysis": ("결과 분석", "Result analysis"),
            "writing": ("논문 작성", "Paper writing"), "pre_submit_check": ("제출 전 점검", "Pre-submit check"),
            "submit_workshop": ("워크숍 제출", "Workshop submission"), "submit_main": ("본 학회 제출", "Main submission"),
            "reviews": ("리뷰 수신", "Reviews received"), "rebuttal": ("저자 답변", "Author rebuttal"),
            "accepted": ("게재 승인", "Accepted"), "rejected": ("게재 거절", "Rejected"),
            "takeaway": ("핵심 정리", "Takeaways"), "slide": ("발표 자료", "Slide deck"), "poster": ("포스터", "Poster"),
            "lit_review": ("문헌 검토", "Literature review"), "drafting": ("초안 작성", "Drafting"),
            "ranking": ("순위 평가", "Ranking"), "submitted": ("제출 완료", "Submitted"),
            "rebuttal_audit": ("답변 검토", "Rebuttal audit"), "final": ("최종 평가", "Final score"),
        ]
        guard let name = names[state] else { return labels[state] ?? state.replacingOccurrences(of: "_", with: " ") }
        return UIText.t(name.0, name.1)
    }

    func inPhase(_ state: String) -> [[String: Any]] {
        projects.filter { ($0["phase"] as? String) == state }
    }
}

struct ResearchView: View {
    @Environment(\.appearanceTokens) private var theme
    @StateObject private var model = ResearchModel()
    @State private var opened: ResearchTarget?
    @State private var adding = false
    @State private var inferNote: String?

    var body: some View {
        TabNavigationStack {
            List {
                LiquidRefreshHeader()
                SegmentedButtons(title: UIText.t("연구", "Research"), selection: Binding(get: { model.kind }, set: { kind in
                    model.kind = kind
                    Task { await model.load() }
                }), options: [
                    .init(id: "research.kind.own", value: "own", title: UIText.t("내 연구", "My research")),
                    .init(id: "research.kind.review", value: "review", title: UIText.t("리뷰", "Reviews")),
                ])
                .glassRowLayout()
                if let error = model.error {
                    LoadFailure(message: error).glassRow().glassRowLayout()
                }
                if let inferNote {
                    Text(inferNote).themeText(.meta).foregroundStyle(Theme.secondary).glassRowLayout()
                }
                if !model.loaded {
                    Section {
                        ForEach((0..<4).map { "skeleton-\($0)" }, id: \.self) { _ in
                            VStack(alignment: .leading, spacing: theme.space(0.75)) {
                                SkeletonText(width: 0.8)
                                SkeletonText(role: .meta, lines: 2, width: 0.6)
                            }
                            .glassRow().glassRowLayout()
                            .loadingAccessibility("research.loading", label: UIText.t("연구 불러오는 중", "Loading research"))
                        }
                    } header: {
                        SkeletonText(role: .meta, width: 0.3)
                    }
                }
                if model.loaded && model.projects.isEmpty && model.error == nil {
                    Text(UIText.t("아직 연구가 없어요", "No research projects yet")).themeText(.title).foregroundStyle(Theme.secondary).glassRow().glassRowLayout()
                }
                ForEach(model.states.filter { !model.inPhase($0).isEmpty }, id: \.self) { state in
                    Section {
                        ForEach(Array(model.inPhase(state).enumerated()), id: \.offset) { _, p in
                            Button { opened = ResearchTarget(id: (p["slug"] as? String) ?? "") } label: { row(p) }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("research.project.\((p["slug"] as? String) ?? "")")
                                .glassRow().glassRowLayout()
                        }
                    } header: {
                        Text(model.label(state)).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary).textCase(nil)
                    }
                }
            }
            .liquidList()
            .accessibilityIdentifier("research.scroll")
            .navigationTitle(UIText.t("연구", "Research"))
            .liquidSurface().inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button(UIText.t("프로젝트 등록", "Register a project"), systemImage: "plus") { adding = true }
                            .accessibilityIdentifier("research.register")
                        Button(UIText.t("모든 단계 추정", "Infer every phase"), systemImage: "wand.and.stars") {
                            Task {
                                do {
                                    let r = try await ConvexHTTP.mutation("researchPhaseInfer:requestAll", args: ["kind": model.kind]) as? [String: Any]
                                    let n = (r?["queued"] as? NSNumber)?.intValue ?? 0
                                    inferNote = UIText.t("프로젝트 \(n)개의 단계를 다시 추정합니다.", "Re-inferring \(n) projects’ phases.")
                                } catch { model.error = error.localizedDescription }
                            }
                        }
                    } label: { ListIcon(systemName: "ellipsis.circle") }
                    .accessibilityLabel(UIText.t("연구 작업", "Research actions"))
                    .accessibilityIdentifier("research.actions")
                }
            }
            .liquidRefreshable { await model.load() }
            .task { if !model.loaded { await model.load() } }
            .sheet(item: $opened, onDismiss: { Task { await model.load() } }) { target in
                ResearchDetail(slug: target.id, model: model)
            }
            .sheet(isPresented: $adding, onDismiss: { Task { await model.load() } }) {
                ResearchRegister(kind: model.kind, phase: model.states.first ?? (model.kind == "own" ? "ideation" : "setup"))
            }
        }
    }

    private func row(_ p: [String: Any]) -> some View {
        let meta = [p["slug"] as? String, p["venue"] as? String, p["deadline"] as? String,
                    (p["updatedAt"] as? Double).map { UIText.relativeTime($0) }]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        return VStack(alignment: .leading, spacing: theme.space(0.75)) {
            Text((p["title"] as? String) ?? "").themeText(.title)
            Text(meta).themeText(.meta).foregroundStyle(Theme.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ResearchTarget: Identifiable {
    let id: String
}

private struct ResearchDetail: View {
    @Environment(\.appearanceTokens) private var theme
    let slug: String
    @ObservedObject var model: ResearchModel
    @Environment(\.dismiss) private var dismiss
    @State private var info: [String: Any] = [:]
    @State private var timeline: [[String: Any]] = []
    @State private var files: [String: Any] = [:]
    @State private var papers: [[String: Any]] = []
    @State private var error: String?
    @State private var confirmDelete = false
    @State private var loaded = false

    private var project: [String: Any]? { model.projects.first { ($0["slug"] as? String) == slug } }
    private var labels: [String: String] { info["labels"] as? [String: String] ?? model.labels }
    private func label(_ s: String) -> String { model.label(s) }

    var body: some View {
        NavigationStack {
            List {
                LiquidRefreshHeader()
                if !loaded {
                    Section {
                        VStack(alignment: .leading, spacing: theme.space(1.5)) {
                            SkeletonText(lines: 2, width: 0.8)
                            SkeletonText(role: .meta, width: 0.4)
                        }.glassRow().glassRowLayout()
                        ForEach(0..<4, id: \.self) { _ in
                            ContentRowSkeleton(titleLines: 1).glassRow().glassRowLayout()
                        }
                    }.loadingAccessibility("research.detail.loading", label: UIText.t("연구 불러오는 중", "Loading research"))
                } else {
                Section {
                    VStack(alignment: .leading, spacing: theme.space(1.5)) {
                        Text((info["title"] as? String) ?? (project?["title"] as? String) ?? slug).themeText(.title)
                        Text(slug).themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary)
                        if let phase = info["phase"] as? String {
                            Text(label(phase)).themeText(.badge)
                                .padding(.horizontal, theme.space(2)).padding(.vertical, theme.space(0.75))
                                .background(Theme.ink.opacity(0.08), in: RoundedRectangle(cornerRadius: theme.value("radiusPill")))
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .glassRow().glassRowLayout()
                }
                let next = info["next"] as? [String] ?? []
                if !next.isEmpty {
                    Section(UIText.t("다음 단계", "Move to")) {
                        ForEach(next, id: \.self) { state in
                            Button { move(state) } label: {
                                Label(label(state), systemImage: "arrow.right.circle")
                                    .themeText(.title)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .glassRow()
                            }
                            .buttonStyle(.plain)
                            .glassRowLayout()
                            .accessibilityIdentifier("research.next.\(state)")
                        }
                    }
                }
                Section(UIText.t("공개 범위", "Visibility")) {
                    Picker(UIText.t("공개 범위", "Visibility"), selection: Binding(
                        get: { (project?["visibility"] as? String) ?? "private" },
                        set: { value in setVisibility(value) }
                    )) {
                        Text(UIText.t("비공개", "Private")).tag("private")
                        Text(UIText.t("작업 공간", "Workspace")).tag("workspace")
                        Text(UIText.t("링크 공개", "Unlisted")).tag("unlisted")
                        Text(UIText.t("공개", "Public")).tag("public")
                    }
                    .themeText(.body)
                    .glassRow().glassRowLayout()
                }
                if let total = (files["total"] as? NSNumber)?.intValue, total > 0 {
                    Section(UIText.t("파일", "Files")) {
                        let byType = (files["byType"] as? [String: Any] ?? [:]).compactMapValues { ($0 as? NSNumber)?.intValue }
                        ForEach(byType.keys.sorted(), id: \.self) { type in
                            LabeledContent(type, value: "\(byType[type] ?? 0)")
                                .themeText(.meta).glassRow().glassRowLayout()
                        }
                    }
                }
                if !papers.isEmpty {
                    Section(UIText.t("논문", "Papers")) {
                        ForEach(Array(papers.enumerated()), id: \.offset) { _, paper in
                            let title = (paper["title"] as? String) ?? (paper["arxivId"] as? String) ?? ""
                            Group {
                                if let url = (paper["url"] as? String).flatMap(URL.init(string:)) {
                                    Link(title, destination: url).foregroundStyle(Theme.link)
                                } else {
                                    Text(title)
                                }
                            }
                            .themeText(.meta)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .glassRow().glassRowLayout()
                        }
                    }
                }
                if !timeline.isEmpty {
                    Section(UIText.t("지나온 단계", "History")) {
                        ForEach(Array(timeline.enumerated()), id: \.offset) { _, entry in
                            HStack(alignment: .firstTextBaseline) {
                                Text(label((entry["state"] as? String) ?? "")).themeText(.meta)
                                if let note = entry["note"] as? String { Text(note).themeText(.meta).foregroundStyle(Theme.secondary).lineLimit(2) }
                                Spacer()
                                if let at = entry["at"] as? Double {
                                    Text(Date(timeIntervalSince1970: at / 1000).formatted(date: .abbreviated, time: .omitted))
                                        .themeText(.meta, design: .monospaced).foregroundStyle(Theme.secondary)
                                }
                            }
                            .glassRow().glassRowLayout()
                        }
                    }
                }
                }
                if let error {
                    LoadFailure(message: error) { Task { await load() } }.glassRow().glassRowLayout()
                }
                Section {
                    Button(role: .destructive) { confirmDelete = true } label: {
                        Text(UIText.t("프로젝트 삭제", "Delete project"))
                            .themeText(.action).foregroundStyle(Theme.failure)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .glassRow()
                    }
                    .buttonStyle(.plain).glassRowLayout()
                }
            }
            .navigationTitle(UIText.t("연구", "Research"))
            .liquidList()
            .accessibilityIdentifier("research.detail.scroll")
            .liquidSurface().inlineNavigationTitle()
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(UIText.t("닫기", "Close")) { dismiss() }.accessibilityIdentifier("research.detail.close") } }
            .task { await load() }
            .liquidRefreshable { await load() }
            .confirmationDialog(
                UIText.t("이 프로젝트와 그 안의 모든 것을 지울까요? 되돌릴 수 없습니다.", "Delete this project and everything in it? This cannot be undone."),
                isPresented: $confirmDelete, titleVisibility: .visible
            ) {
                Button(UIText.t("삭제", "Delete"), role: .destructive) { remove() }
            }
        }
    }

    private func load() async {
        do {
            async let info = ConvexHTTP.query("research:getStateInfo", args: ["slug": slug])
            async let timeline = ConvexHTTP.query("research:getTimeline", args: ["slug": slug, "limit": 30])
            async let files = ConvexHTTP.query("researchFiles:summary", args: ["researchSlug": slug])
            async let papers = ConvexHTTP.query("researchPapers:listByResearch", args: ["researchSlug": slug])
            guard let value = try await info as? [String: Any],
                  let history = try await timeline as? [[String: Any]],
                  let summary = try await files as? [String: Any],
                  let references = try await papers as? [[String: Any]] else { throw ConvexError.shape }
            self.info = value
            self.timeline = history
            self.files = summary
            self.papers = references
            error = nil
        } catch { self.error = error.localizedDescription }
        loaded = true
    }

    private func move(_ state: String) {
        guard let id = project?["_id"] as? String else { return }
        Task {
            do {
                _ = try await ConvexHTTP.mutation("research:updatePhase", args: ["id": id, "phase": state])
                await model.load()
                await load()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func setVisibility(_ value: String) {
        guard let id = project?["_id"] as? String else { return }
        Task {
            do {
                _ = try await ConvexHTTP.mutation("research:setVisibility", args: ["id": id, "visibility": value])
                await model.load()
            } catch { self.error = error.localizedDescription }
        }
    }

    private func remove() {
        guard let id = project?["_id"] as? String else { return }
        Task {
            do {
                for _ in 0..<200 {
                    guard let result = try await ConvexHTTP.mutation("research:remove", args: ["id": id]) as? [String: Any] else { throw ConvexError.shape }
                    if result["done"] as? Bool == true { dismiss(); return }
                }
                throw ConvexError.server(UIText.t("삭제를 완료하지 못했어요. 다시 시도하세요.", "Deletion did not finish. Please retry."))
            } catch { self.error = error.localizedDescription }
        }
    }
}

private struct ResearchRegister: View {
    @Environment(\.appearanceTokens) private var theme
    let kind: String
    let phase: String
    @Environment(\.dismiss) private var dismiss
    @State private var slug = ""
    @State private var title = ""
    @State private var venue = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                TextField(UIText.t("식별자", "Slug"), text: $slug).textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField(UIText.t("제목", "Title"), text: $title)
                    .accessibilityIdentifier("research.register.title")
                TextField(UIText.t("학회·장소", "Venue"), text: $venue).textInputAutocapitalization(.never)
                if let error { LoadFailure(message: error) }
            }
            .navigationTitle(UIText.t("프로젝트 등록", "Register a project"))
            .liquidSurface().inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(UIText.t("취소", "Cancel")) { dismiss() }.accessibilityIdentifier("research.register.cancel") }
                ToolbarItem(placement: .confirmationAction) {
                    Button(UIText.t("등록", "Register")) {
                        var args: [String: Any] = ["slug": slug.trimmingCharacters(in: .whitespaces),
                                                   "title": title.trimmingCharacters(in: .whitespaces),
                                                   "kind": kind, "phase": phase]
                        let v = venue.trimmingCharacters(in: .whitespaces)
                        if !v.isEmpty { args["venue"] = v }
                        Task {
                            do {
                                _ = try await ConvexHTTP.mutation("research:upsert", args: args)
                                dismiss()
                            } catch {
                                self.error = error.localizedDescription
                            }
                        }
                    }
                    .disabled(slug.trimmingCharacters(in: .whitespaces).isEmpty || title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }
}
