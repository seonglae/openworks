import SwiftUI

@MainActor
final class DrawingsModel: ObservableObject {
    @Published var rows: [[String: Any]] = []
    @Published var loaded = false
    @Published var error: String?

    func load() async {
        do {
            guard let value = try await ConvexHTTP.query("drawings:list") as? [[String: Any]] else { throw ConvexError.shape }
            try Task.checkCancellation()
            rows = value
            error = nil
        } catch {
            guard !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
        loaded = true
    }

    func change(_ path: String, args: [String: Any]) async {
        do {
            try await ConvexHTTP.mutation(path, args: args)
            await load()
        } catch {
            guard !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }
}

struct DrawingsView: View {
    @Environment(\.appearanceTokens) private var theme
    @StateObject private var model = DrawingsModel()
    @State private var renaming: DrawingTarget?
    @State private var title = ""

    private var columns: [GridItem] { [GridItem(.adaptive(minimum: 150), spacing: theme.space(3))] }

    var body: some View {
        TabNavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    LiquidRefreshHeader()
                    if let error = model.error {
                        LoadFailure(message: error) { Task { await model.load() } }
                            .glassRow().padding(theme.space(4))
                    }
                    if model.loaded && model.rows.isEmpty && model.error == nil {
                        LoadEmpty(message: UIText.t("그림이 없어요. 웹에서 그릴 수 있어요.", "No drawings yet. Draw one on the web."))
                            .glassRow().padding(theme.space(4))
                    }
                    LazyVGrid(columns: columns, spacing: theme.space(3)) {
                        if !model.loaded {
                            ForEach((0..<6).map { "skeleton-\($0)" }, id: \.self) { _ in
                                VStack(alignment: .leading, spacing: theme.space(1.5)) {
                                    Skeleton().frame(height: 110)
                                    SkeletonText(role: .meta, width: 0.75)
                                    SkeletonText(role: .meta, width: 0.5)
                                }
                                .padding(theme.space(2.5))
                                .background(Theme.card, in: RoundedRectangle(cornerRadius: theme.value("radiusCard")))
                                .loadingAccessibility("drawings.loading", label: UIText.t("그림 불러오는 중", "Loading drawings"))
                            }
                        }
                        ForEach(model.rows.map { (id: $0["_id"] as? String ?? "", row: $0) }, id: \.id) { _, row in
                            card(row)
                        }
                    }
                    .padding(theme.space(4))
                }
            }
            .background(Theme.paper)
            .accessibilityIdentifier("drawings.scroll")
            .navigationTitle(UIText.t("그림", "Drawings"))
            .liquidRefreshable { await model.load() }
            .alert(UIText.t("이름 바꾸기", "Rename"), isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField(UIText.t("제목", "Title"), text: $title)
                Button(UIText.t("저장", "Save")) {
                    guard let id = renaming?.id else { return }
                    let next = title.trimmingCharacters(in: .whitespaces)
                    Task {
                        await model.change("drawings:rename", args: ["id": id, "title": next])
                    }
                }
                Button(UIText.t("취소", "Cancel"), role: .cancel) {}
            }
        }
        .task { await model.load() }
    }

    private func card(_ row: [String: Any]) -> some View {
        let id = (row["_id"] as? String) ?? ""
        let name = (row["title"] as? String) ?? ""
        return VStack(alignment: .leading, spacing: theme.space(1.5)) {
            Group {
                if let image = thumbnail(row["thumbnail"] as? String) {
                    Image(uiImage: image).resizable().scaledToFit()
                } else {
                    ListIcon(systemName: "scribble").foregroundStyle(Color(white: 0.1))
                }
            }
            .frame(maxWidth: .infinity, minHeight: 110, maxHeight: 110)
            .background(Color.white, in: RoundedRectangle(cornerRadius: theme.value("radiusControl"), style: .continuous))
            Text(name).themeText(.meta).lineLimit(1)
                .accessibilityIdentifier("drawings.title.\(id)")
            if let at = row["updatedAt"] as? Double {
                Text(UIText.relativeTime(at))
                    .themeText(.meta).foregroundStyle(Theme.secondary)
            }
        }
        .padding(theme.space(2.5))
        .background(Theme.card, in: RoundedRectangle(cornerRadius: theme.value("radiusCard"), style: .continuous))
        .contextMenu {
            Button(UIText.t("이름 바꾸기", "Rename"), systemImage: "pencil") {
                title = name
                renaming = DrawingTarget(id: id)
            }
            .accessibilityIdentifier("drawings.rename.\(id)")
            Button(UIText.t("삭제", "Delete"), systemImage: "trash", role: .destructive) {
                Task {
                    await model.change("drawings:remove", args: ["id": id])
                }
            }
        }
    }

    private func thumbnail(_ value: String?) -> UIImage? {
        guard let value, let comma = value.firstIndex(of: ","),
              let data = Data(base64Encoded: String(value[value.index(after: comma)...])) else { return nil }
        return UIImage(data: data)
    }

}

private struct DrawingTarget: Identifiable {
    let id: String
}
