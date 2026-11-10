import SwiftUI

struct SegmentedButtons<Value: Hashable>: View {
    struct Option: Identifiable {
        let id: String
        let value: Value
        let title: String
        var systemImage: String? = nil
    }

    let title: String
    @Binding var selection: Value
    let options: [Option]
    @Environment(\.appearanceTokens) private var theme
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        HStack(spacing: 0) {
            ForEach(options) { option in
                let selected = selection == option.value
                Button {
                    if !selected { selection = option.value }
                } label: {
                    Group {
                        if let symbol = option.systemImage {
                            Image(systemName: symbol)
                        } else {
                            Text(option.title)
                        }
                    }
                    .font(theme.font(.action))
                    .foregroundStyle(Theme.ink)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .frame(maxWidth: .infinity, minHeight: 28)
                    .background {
                        if selected {
                            RoundedRectangle(cornerRadius: 7)
                                .fill(Theme.card)
                                .shadow(color: .black.opacity(0.12), radius: 2, y: 1)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(option.title)
                .accessibilityIdentifier(option.id)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(2)
        .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 9))
        .opacity(isEnabled ? 1 : 0.5)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
    }
}
