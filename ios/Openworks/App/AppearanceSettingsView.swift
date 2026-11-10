import SwiftUI

struct AppearanceSettingsView: View {
    @ObservedObject private var store = AppearanceStore.shared
    @AppStorage(UIText.storageKey) private var uiLanguage = UIText.lang
    @State private var loaded = false
    @State private var busy = false
    @State private var saved = false
    @State private var error: String?
    @State private var confirmingReset = false

    var body: some View {
        Form {
            Section {
                Text(UIText.t("저장하면 이 기기에 적용돼요.", "Changes apply on this device when you save."))
                    .themeText(.meta).foregroundStyle(Theme.secondary)
                if !loaded {
                    if let error {
                        Text(UIText.settings(error)).foregroundStyle(Theme.failure)
                        Button(UIText.settings("Retry")) { Task { await load() } }
                    }
                }
            }
            if loaded || error == nil {
                ForEach(AppearanceEditorSpec.shared.groups, id: \.label) { group in
                    Section(UIText.settings(group.label)) {
                        ForEach(group.tokens, id: \.self) { key in
                            NavigationLink {
                                AppearanceTokenEditor(key: key)
                            } label: {
                                LabeledContent(UIText.settings(key), value: appearanceValue(store.tokens.values[key]))
                            }
                            .accessibilityIdentifier("appearance.token.\(key)")
                            .loadingPlaceholder(!loaded)
                        }
                    }
                }
                Section {
                    Button(UIText.settings("Reset all to defaults"), role: .destructive) { confirmingReset = true }
                        .disabled(busy || store.overrides.isEmpty)
                        .accessibilityIdentifier("appearance.resetAll")
                        .loadingPlaceholder(!loaded)
                    SettingsSaveStatus(busy: busy, saved: saved, error: error)
                }
            }
        }
        .disabled(busy)
        .navigationTitle(UIText.settings("Appearance"))
        .liquidSurface().inlineNavigationTitle()
        .task { await load() }
        .confirmationDialog(UIText.t("이 기기의 모든 화면 값을 초기화할까요?", "Reset every appearance value on this device?"),
                            isPresented: $confirmingReset, titleVisibility: .visible) {
            Button(UIText.settings("Reset all to defaults"), role: .destructive) {
                Task { await resetAll() }
            }
            Button(UIText.settings("Cancel"), role: .cancel) {}
        }
    }

    private func load() async {
        error = nil
        do {
            try await store.load()
            loaded = true
        } catch {
            self.error = "Settings could not be loaded. Try again."
        }
    }

    private func resetAll() async {
        busy = true
        saved = false
        error = nil
        defer { busy = false }
        do {
            let patch = Dictionary(uniqueKeysWithValues: AppearanceTokens.defaults.keys.map { ($0, NSNull() as Any) })
            try await store.save(patch)
            saved = true
        } catch {
            self.error = "Appearance could not be saved. Try again."
        }
    }
}

private func appearanceValue(_ value: Any?) -> String {
    if let icon = value as? String { return UIText.settings("appearanceIcon.\(icon)") }
    return (value as? NSNumber)?.stringValue ?? ""
}

private struct AppearanceTokenEditor: View {
    @Environment(\.appearanceTokens) private var theme
    @ObservedObject private var store = AppearanceStore.shared
    @AppStorage(UIText.storageKey) private var uiLanguage = UIText.lang
    let key: String
    @State private var draft = ""
    @State private var busy = false
    @State private var saved = false
    @State private var error: String?

    private var isIcon: Bool { AppearanceTokens.defaults[key] is String }
    private var limits: AppearanceEditorSpec.Limits { AppearanceEditorSpec.shared.limits(key) }
    private var current: String {
        (store.tokens.values[key] as? String) ?? (store.tokens.values[key] as? NSNumber)?.stringValue ?? ""
    }
    private var editing: Binding<String> {
        Binding(get: { draft }, set: { draft = $0; saved = false; error = nil })
    }
    private var draftValue: Any? {
        if isIcon { return AppearanceTokens.symbols[draft] == nil ? nil : draft }
        guard let number = Double(draft.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: ".")),
              limits.contains(number) else { return nil }
        return number
    }
    private func fits(_ value: Any) -> Bool {
        let size = key == "iconSymbolSize" ? (value as? NSNumber)?.doubleValue : (store.tokens.values["iconSymbolSize"] as? NSNumber)?.doubleValue
        let box = key == "iconBox" ? (value as? NSNumber)?.doubleValue : (store.tokens.values["iconBox"] as? NSNumber)?.doubleValue
        return (size ?? 0) <= (box ?? 0)
    }
    private var preview: AppearanceTokens {
        var values = store.tokens.values
        if let value = draftValue, fits(value) { values[key] = value }
        var tokens = AppearanceTokens(values)
        tokens.scale = theme.scale
        return tokens
    }

    var body: some View {
        Form {
            Section(UIText.settings(key)) {
                if isIcon {
                    Picker(UIText.settings("Value"), selection: editing) {
                        ForEach(AppearanceTokens.symbols.keys.sorted(), id: \.self) { icon in
                            Label(UIText.settings("appearanceIcon.\(icon)"), systemImage: AppearanceTokens.symbols[icon]!)
                                .tag(icon)
                        }
                    }
                } else {
                    TextField(UIText.settings("Value"), text: editing)
                        .keyboardType(.decimalPad)
                        .accessibilityIdentifier("appearance.value")
                    Text(UIText.settings("Range: {min}–{max}, step {step}", values: [
                        "min": NSNumber(value: limits.min).stringValue,
                        "max": NSNumber(value: limits.max).stringValue,
                        "step": NSNumber(value: limits.step).stringValue,
                    ])).themeText(.meta).foregroundStyle(Theme.secondary)
                }
                Text(UIText.settings("Default: {value}", values: ["value": appearanceValue(AppearanceTokens.defaults[key])]))
                    .themeText(.meta).foregroundStyle(Theme.secondary)
                Button(UIText.settings("Save")) { Task { await save(reset: false) } }
                    .disabled(draft == current)
                    .accessibilityIdentifier("appearance.save")
                Button(UIText.settings("Reset to default")) { Task { await save(reset: true) } }
                    .disabled(store.overrides[key] == nil)
                    .accessibilityIdentifier("appearance.reset")
                SettingsSaveStatus(busy: busy, saved: saved, error: error)
            }
            Section(UIText.settings("Appearance preview")) {
                AppearancePreview(token: key)
                    .environment(\.appearanceTokens, preview)
            }
        }
        .disabled(busy)
        .navigationTitle(UIText.settings(key))
        .liquidSurface().inlineNavigationTitle()
        .onAppear { draft = current }
    }

    private func save(reset: Bool) async {
        guard let value = reset ? AppearanceTokens.defaults[key] : draftValue else {
            error = "Choose a value within the allowed range."
            return
        }
        guard fits(value) else { error = "Icon symbol must fit inside its box."; return }
        busy = true
        saved = false
        error = nil
        defer { busy = false }
        do {
            try await store.save([key: reset ? NSNull() : value])
            draft = current
            saved = true
        } catch {
            self.error = "Appearance could not be saved. Try again."
        }
    }
}

private struct AppearancePreview: View {
    @Environment(\.appearanceTokens) private var theme
    let token: String

    var body: some View {
        VStack(alignment: .leading, spacing: theme.value("cardGap")) {
            HStack(alignment: .firstTextBaseline, spacing: theme.value("rowGap")) {
                ListIcon(systemName: AppearanceTokens.symbols[theme.values[token] as? String ?? "bookOpen"])
                VStack(alignment: .leading, spacing: theme.value("rowTextGap")) {
                    Text(UIText.settings("Title")).themeText(.title)
                    Text(UIText.settings("Details")).themeText(.meta).foregroundStyle(Theme.secondary)
                }
                Text(UIText.settings("Preview")).themeText(.badge)
                    .padding(.horizontal, theme.value("badgePaddingX"))
                    .padding(.vertical, theme.value("badgePaddingY"))
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: theme.value("radiusPill")))
            }
            .glassRow()
            Text(UIText.settings("Preview")).themeText(.display)
            Text(UIText.settings("Title")).themeText(.heading)
            Text(UIText.settings("Details")).themeText(.body)
            Button(UIText.t("예시", "Sample")) {}.buttonStyle(ThemeActionStyle()).disabled(true)
        }
        .padding(.horizontal, theme.value("pagePadding"))
        .accessibilityElement(children: .combine)
    }
}

struct SettingsSaveStatus: View {
    let busy: Bool
    let saved: Bool
    let error: String?

    var body: some View {
        if busy { ProgressView(UIText.settings("Saving…")) }
        if saved { Text(UIText.settings("Saved")).themeText(.meta) }
        if let error { Text(UIText.settings(error)).themeText(.meta).foregroundStyle(Theme.failure) }
    }
}
