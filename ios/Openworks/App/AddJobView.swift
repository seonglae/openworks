import SwiftUI

struct AddJobView: View {
    let type: String
    var onCreated: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var asURL: String? {
        guard !trimmed.contains(where: \.isNewline) else { return nil }
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased() else { return nil }
        guard scheme == "http" || scheme == "https", url.host != nil else { return nil }
        return trimmed
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $text).accessibilityIdentifier("jobs.editor.text")
                        .frame(minHeight: 160)
                        .focused($focused)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text(UIText.t("링크 또는 텍스트", "Link or text"))
                } footer: {
                    Text(asURL == nil
                         ? UIText.t("\(UIText.tab(type)) 요약을 위한 내용으로 보내요.", "Sent as content for \(type) summarising.")
                         : UIText.t("링크로 보내면 Openworks가 내용을 가져와요.", "Sent as a link; Openworks fetches it." ))
                }

                if let error {
                    Section { LoadFailure(message: error) }
                }
            }
            .navigationTitle(UIText.t("\(UIText.tab(type))에 추가", "Add to \(UIText.tab(type))"))
            .liquidSurface().inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(UIText.t("취소", "Cancel")) { dismiss() }.accessibilityIdentifier("jobs.editor.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(UIText.t("추가", "Add")) { Task { await submit() } }
                        .disabled(trimmed.isEmpty || busy)
                        .accessibilityIdentifier("jobs.editor.add")
                }
            }
            .task { focused = true }
        }
    }

    private func submit() async {
        busy = true
        defer { busy = false }
        do {
            try await ConvexHTTP.createJob(url: asURL ?? "", content: asURL == nil ? trimmed : "", type: type)
            onCreated()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
