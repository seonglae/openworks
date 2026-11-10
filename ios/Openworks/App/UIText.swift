import Foundation

enum UIText {
    static let storageKey = "uiLanguage"

    static var lang: String { UserDefaults.standard.string(forKey: storageKey) ?? "ko" }

    static func t(_ ko: String, _ en: String) -> String { lang == "en" ? en : ko }

    typealias Resource = LocalizedStringResource
    static var locale: Locale { Locale(identifier: lang) }

    static func dateTime(_ ms: Double) -> String {
        Date(timeIntervalSince1970: ms / 1000).formatted(
            Date.FormatStyle(date: .abbreviated, time: .shortened).locale(locale)
        )
    }

    static func relativeTime(_ ms: Double, now: Date = Date()) -> String {
        let minutes = Int((now.timeIntervalSince1970 * 1000 - ms) / 60_000)
        if minutes < 1 { return t("방금", "just now") }
        if minutes < 60 { return t("\(minutes)분 전", "\(minutes)m ago") }
        let hours = minutes / 60
        if hours < 24 { return t("\(hours)시간 전", "\(hours)h ago") }
        let days = hours / 24
        if days < 7 { return t("\(days)일 전", "\(days)d ago") }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.setLocalizedDateFormatFromTemplate("MMMd")
        return formatter.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    static func settings(_ key: String, values: [String: String] = [:]) -> String {
        let template = AppearanceEditorSpec.shared.text[key]?[lang] ?? key
        let pattern = try! NSRegularExpression(pattern: #"\{(\w+)\}"#)
        var result = template
        for match in pattern.matches(in: template, range: NSRange(template.startIndex..., in: template)).reversed() {
            guard let nameRange = Range(match.range(at: 1), in: template),
                  let range = Range(match.range, in: result), let value = values[String(template[nameRange])] else { continue }
            result.replaceSubrange(range, with: value)
        }
        return result
    }

    static func tab(_ key: String) -> String {
        let names: [String: (String, String)] = [
            "newsletter": ("뉴스레터", "Newsletters"), "paper": ("논문", "Papers"), "article": ("아티클", "Articles"),
            "pr": ("PR", "PRs"), "plan": ("계획", "Plans"), "research": ("연구", "Research"), "diet": ("식단", "Diet"),
            "vocab": ("단어", "Vocab"), "insights": ("인사이트", "Insights"), 
            "usage": ("사용량", "Usage"), "search": ("검색", "Search"), "settings": ("설정", "Settings"),
            "dashboard": ("대시보드", "Dashboard"), "authors": ("저자", "Authors"), "mailbox": ("메일함", "Mailbox"), "drawings": ("그림", "Drawings"),
        ]
        return names[key].map { t($0.0, $0.1) } ?? key
    }

    static func pull() async {
        guard let s = try? await ConvexHTTP.query("settings:get", args: [:]) as? [String: Any],
              let lang = s["uiLanguage"] as? String else { return }
        await MainActor.run {
            UserDefaults.standard.set(lang == "en" ? "en" : "ko", forKey: storageKey)
        }
    }

    static func shellState() async -> (hidden: Set<String>, onboarding: Bool)? {
        guard let s = try? await ConvexHTTP.query("settings:get", args: [:]) as? [String: Any] else { return nil }
        await MainActor.run {
            if let lang = s["uiLanguage"] as? String { UserDefaults.standard.set(lang, forKey: storageKey) }
        }
        let hidden = (s["tabs"] as? [[String: Any]] ?? []).filter { ($0["enabled"] as? Bool) == false }.compactMap { $0["key"] as? String }
        let open = (s["onboarding"] as? [String: Any])?["doneAt"] == nil
        return (Set(hidden), open)
    }

    static func push(_ lang: String) async {
        UserDefaults.standard.set(lang, forKey: storageKey)
        _ = try? await ConvexHTTP.mutation("settings:setUiLanguage", args: ["uiLanguage": lang])
    }
}
