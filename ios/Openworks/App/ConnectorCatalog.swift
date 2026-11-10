import SwiftUI

enum ConnectorCatalog {
    static var types: [ConnectorType] {
        [
            ["key": "links", "label": UIText.t("링크와 글", "Links & text"), "directions": ["input"], "auth": ["none"], "blurb": ["ko": "링크, 글, 붙여 넣은 뉴스레터", "en": "Links, text and pasted newsletters"]],
            ["key": "iphone", "label": "iPhone", "directions": ["input"], "auth": ["app"], "blurb": ["ko": "이 기기에서 내용을 읽고 추가합니다", "en": "Read and add content from this phone"]],
            ["key": "gmail", "label": "Gmail", "directions": ["input", "output"], "auth": ["cli"], "blurb": ["ko": "뉴스레터를 받고 요약 메일을 보냅니다", "en": "Receive newsletters and send digests"]],
            ["key": "github", "label": "GitHub", "directions": ["input"], "auth": ["cli"], "blurb": ["ko": "내 PR과 리뷰 요청", "en": "Your pull requests and review requests"]],
            ["key": "notion", "label": "Notion", "directions": ["output"], "auth": ["oauth", "token", "env"], "blurb": ["ko": "페이지에 수정 제안을 적용합니다", "en": "Apply proposed edits to pages"]],
            ["key": "obsidian", "label": "Obsidian", "directions": ["input", "output"], "auth": ["path"], "connectOnly": true, "blurb": ["ko": "컴퓨터의 vault 폴더 연결 확인", "en": "Check the connection to a vault folder"]]
        ].compactMap(ConnectorType.init)
    }
}

struct Island: Identifiable, Hashable {
    let key: String
    let korean: String
    let english: String
    var id: String { key }
    static let all = [
        Island(key: "productivity", korean: "생산성", english: "Productivity"),
        Island(key: "research", korean: "연구", english: "Research"),
        Island(key: "hobby", korean: "취미", english: "Hobby"),
        Island(key: "family", korean: "가족", english: "Family"),
        Island(key: "friends", korean: "친구", english: "Friends"),
        Island(key: "invest", korean: "투자", english: "Investing"),
        Island(key: "work", korean: "업무", english: "Work")
    ]
    static func label(_ key: String) -> String {
        all.first { $0.key == key }.map { UIText.t($0.korean, $0.english) } ?? key
    }
}

struct IslandMark: View {
    @Environment(\.appearanceTokens) private var theme
    let key: String
    var inline = false
    var body: some View {
        if inline {
            Image(systemName: theme.icon("island", key)).font(theme.font(.meta)).foregroundStyle(Theme.secondary)
        } else { ListIcon(island: key).foregroundStyle(Theme.ink) }
    }
}
