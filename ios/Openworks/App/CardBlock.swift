import SwiftUI

enum CardBlock {
    case header(title: String, lines: Int)
    case figure(url: URL, width: Double?, height: Double?, caption: String?, minRatio: Double, maxRatio: Double)
    case image(url: URL, height: Double)
    case formula(tex: String, caption: String?, note: String?)
    case roles([(label: String, color: Color, text: String, lines: Int)])
    case quote(text: String, lines: Int)
    case text(text: String, lines: Int, subheadline: Bool)
    case diffs(label: String, show: Int, total: Int, maxLines: Int, more: String?)
    case actions([(kind: String, label: String, icon: String)])

    init?(_ json: [String: Any]) {
        let int = { (key: String, fallback: Int) in (json[key] as? NSNumber)?.intValue ?? fallback }
        let double = { (key: String) in (json[key] as? NSNumber)?.doubleValue }
        let url = { (key: String) in (json[key] as? String).flatMap(URL.init(string:)) }
        switch json["type"] as? String {
        case "header":
            guard let title = json["title"] as? String else { return nil }
            self = .header(title: title, lines: int("lines", 3))
        case "figure":
            guard let link = url("url") else { return nil }
            self = .figure(url: link, width: double("width"), height: double("height"), caption: json["caption"] as? String,
                           minRatio: double("minRatio") ?? 1.3, maxRatio: double("maxRatio") ?? 3.2)
        case "image":
            guard let link = url("url") else { return nil }
            self = .image(url: link, height: double("height") ?? 200)
        case "formula":
            guard let tex = json["tex"] as? String else { return nil }
            self = .formula(tex: tex, caption: json["caption"] as? String, note: json["note"] as? String)
        case "roles":
            let items = (json["items"] as? [[String: Any]] ?? []).compactMap { r -> (String, Color, String, Int)? in
                guard let label = r["label"] as? String, let text = r["text"] as? String else { return nil }
                return (label, Color(hex: r["color"] as? String) ?? .secondary, text, (r["lines"] as? NSNumber)?.intValue ?? 1)
            }
            self = .roles(items.map { (label: $0.0, color: $0.1, text: $0.2, lines: $0.3) })
        case "quote":
            guard let text = json["text"] as? String else { return nil }
            self = .quote(text: text, lines: int("lines", 5))
        case "text":
            guard let text = json["text"] as? String else { return nil }
            self = .text(text: text, lines: int("lines", 3), subheadline: (json["style"] as? String) != "body")
        case "diffs":
            guard let label = json["label"] as? String else { return nil }
            self = .diffs(label: label, show: int("show", 1), total: int("total", 1), maxLines: int("maxLines", 4),
                          more: json["more"] as? String)
        case "actions":
            let items = (json["items"] as? [[String: Any]] ?? []).compactMap { a -> (kind: String, label: String, icon: String)? in
                guard let kind = a["kind"] as? String, let label = a["label"] as? String else { return nil }
                return (kind, label, (a["icon"] as? String) ?? "circle")
            }
            self = .actions(items)
        default:
            return nil
        }
    }
}

extension Color {
    init?(hex: String?) {
        guard let hex, hex.hasPrefix("#"), hex.count == 7, let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255,
                  blue: Double(value & 0xFF) / 255)
    }
}
