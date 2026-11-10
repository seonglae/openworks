import XCTest
import SwiftUI
import UIKit
@testable import Openworks

@MainActor
final class DesignAndDemoTests: XCTestCase {
    func testTextColorsMeetContrastOnBothSurfaces() {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let traits = UITraitCollection(userInterfaceStyle: style)
            for background in [Theme.paper, Theme.card] {
                let bg = components(UIColor(background).resolvedColor(with: traits))
                for foreground in [Theme.ink, Theme.secondary, Theme.link, Theme.success, Theme.warning, Theme.failure] {
                    let fg = components(UIColor(foreground).resolvedColor(with: traits))
                    XCTAssertGreaterThanOrEqual(contrast(fg, bg), 4.5)
                    let badge = zip(fg, bg).map { $0 * 0.15 + $1 * 0.85 }
                    XCTAssertGreaterThanOrEqual(contrast(fg, badge), 4.5, "Badge text also needs contrast")
                }
            }
        }
    }

    func testBundledFontsAndAllEditableDefaultsAreValid() throws {
        for weight in ["Thin", "ExtraLight", "Light", "Regular", "Medium", "SemiBold", "Bold", "ExtraBold", "Black"] {
            XCTAssertNotNil(UIFont(name: "Pretendard-\(weight)", size: 17), weight)
            XCTAssertNotNil(Bundle.main.url(forResource: "Pretendard-\(weight)", withExtension: "ttf"))
        }
        for group in AppearanceEditorSpec.shared.groups {
            for key in group.tokens {
                let value = try XCTUnwrap(AppearanceTokens.defaults[key], key)
                if let icon = value as? String { XCTAssertNotNil(AppearanceTokens.symbols[icon], key) }
                else { XCTAssertTrue(AppearanceEditorSpec.shared.limits(key).contains((value as! NSNumber).doubleValue), key) }
            }
        }
        let invalid = AppearanceTokens(["textTitleSize": Double.nan, "iconBox": true, "kindPaperIcon": "invalid"])
        let defaults = AppearanceTokens()
        XCTAssertEqual(invalid.value("textTitleSize"), defaults.value("textTitleSize"))
        XCTAssertEqual(invalid.value("iconBox"), defaults.value("iconBox"))
        XCTAssertEqual(invalid.icon("kind", "paper"), defaults.icon("kind", "paper"))
    }

    func testMixedKoreanAndMathKeepsBothKindsOfContent() {
        XCTAssertEqual(parseRich("변화량은 $x_2-x_1$입니다. $$y=x^2$$"), [
            .text("변화량은 "), .math("x_2-x_1", display: false), .text("입니다. "), .math("y=x^2", display: true)
        ])
        XCTAssertEqual(parseRich(#"Price \$5 and an unfinished $formula"#), [.text("Price $5 and an unfinished $formula")])
    }

    func testScoreBandUsesReturnedSummaryScoresAndKeepsTheTopBoundary() {
        XCTAssertTrue(jobMatchesScoreBand([:], band: nil))
        XCTAssertFalse(jobMatchesScoreBand([:], band: 7...8))
        XCTAssertTrue(jobMatchesScoreBand(["summaryScores": [7.0, 8.5]], band: 7...8))
        XCTAssertFalse(jobMatchesScoreBand(["summaryScores": [8.0]], band: 7...8))
        XCTAssertTrue(jobMatchesScoreBand(["summaryScores": [10.0]], band: 9...10))
    }

    func testPushReadsTheBackendWebPath() {
        XCTAssertEqual(pushDestination(["url": "/?item=sample-paper-0"]).item, "sample-paper-0")
        XCTAssertEqual(pushDestination(["url": "/?tab=research"]).tab, "research")
        XCTAssertNil(pushDestination(["url": "/?tab=unsupported"]).tab)
        XCTAssertNil(pushDestination(["url": "/?item="]).item)
    }

    func testNotificationRevealClearsStaleFilterAndUnhidesList() {
        let shell = Shell()
        shell.apply(kind: "paper", band: 8...10)
        shell.hiddenTabs = ["paper"]
        XCTAssertTrue(shell.reveal(job: ["_id": "sample-test", "type": "paper", "archived": true, "status": "done"]))
        XCTAssertEqual(shell.tab, "paper")
        XCTAssertNil(shell.band("paper"))
        XCTAssertFalse(shell.hiddenTabs.contains("paper"))
        XCTAssertEqual(shell.listTarget?.archived, true)
        XCTAssertFalse(shell.reveal(job: ["_id": "other", "type": "unsupported"]))
    }

    func testDemoArchiveCountAndAppliedSuggestionStayConsistent() async throws {
        let args: [String: Any] = ["type": "newsletter", "archived": false]
        let before = try await DemoMode.response(kind: "query", path: "jobs:count", args: args) as! Int
        _ = try await DemoMode.response(kind: "mutation", path: "jobs:archive", args: ["jobId": "sample-newsletter-0"])
        let after = try await DemoMode.response(kind: "query", path: "jobs:count", args: args) as! Int
        XCTAssertEqual(after, before - 1)
        _ = try await DemoMode.response(kind: "mutation", path: "jobs:unarchive", args: ["jobId": "sample-newsletter-0"])
        _ = try await DemoMode.response(kind: "action", path: "notion:approveAndExecute", args: ["suggestionId": "suggestion-sample-newsletter-0"])
        let suggestions = try await DemoMode.response(kind: "query", path: "suggestions:listByJob", args: ["jobId": "sample-newsletter-0"]) as! [[String: Any]]
        XCTAssertEqual(suggestions.first?["status"] as? String, "executed")
        XCTAssertNotNil(suggestions.first?["pageUrl"] as? String)
        do {
            _ = try await DemoMode.response(kind: "query", path: "missing:operation", args: [:])
            XCTFail("An unknown operation must fail instead of pretending to return an empty list")
        } catch { XCTAssertTrue(error.localizedDescription.contains("missing:operation")) }
    }

    func testDemoDrawingsFinishLoadingWithContent() async throws {
        guard DemoMode.isEnabled else { return XCTFail("This test requires the scheme's OPENWORKS_DEMO=1 environment") }
        let model = DrawingsModel()
        XCTAssertFalse(model.loaded)
        await model.load()
        XCTAssertTrue(model.loaded)
        XCTAssertNil(model.error)
        let drawing = try XCTUnwrap(model.rows.first { $0["_id"] as? String == "sample-drawing" })
        XCTAssertFalse(try XCTUnwrap(drawing["title"] as? String).isEmpty)
        let thumbnail = try XCTUnwrap(drawing["thumbnail"] as? String)
        let encoded = try XCTUnwrap(thumbnail.split(separator: ",").last)
        let data = try XCTUnwrap(Data(base64Encoded: String(encoded)))
        XCTAssertNotNil(UIImage(data: data))
    }

    func testDemoUsageRangesHaveDistinctConsistentHistories() async throws {
        var previousVisits = 0
        var previousActiveMs = 0
        var previousFirstDay: String?
        for range in [7, 30, 90] {
            let response = try await DemoMode.response(kind: "query", path: "usage:overview", args: ["days": range])
            let overview = try XCTUnwrap(response as? [String: Any])
            let days = try XCTUnwrap(overview["days"] as? [[String: Any]])
            let tabs = try XCTUnwrap(overview["tabs"] as? [[String: Any]])
            let totals = try XCTUnwrap(overview["totals"] as? [String: Int])
            let dates = try days.map { try XCTUnwrap($0["day"] as? String) }
            let visits = try days.map { try XCTUnwrap($0["visits"] as? Int) }
            let activeMs = try days.map { try XCTUnwrap($0["activeMs"] as? Int) }
            XCTAssertEqual(days.count, range)
            XCTAssertEqual(Set(dates).count, range)
            XCTAssertEqual(dates, dates.sorted())
            XCTAssertGreaterThan(Set(activeMs).count, 1)
            XCTAssertEqual(totals["visits"], visits.reduce(0, +))
            XCTAssertEqual(totals["activeMs"], activeMs.reduce(0, +))
            XCTAssertEqual(totals["visits"], try tabs.map { try XCTUnwrap($0["visits"] as? Int) }.reduce(0, +))
            XCTAssertEqual(totals["activeMs"], try tabs.map { try XCTUnwrap($0["activeMs"] as? Int) }.reduce(0, +))
            let totalVisits = try XCTUnwrap(totals["visits"])
            let totalMs = try XCTUnwrap(totals["activeMs"])
            XCTAssertGreaterThan(totalVisits, previousVisits)
            XCTAssertGreaterThan(totalMs, previousActiveMs)
            let firstDay = try XCTUnwrap(dates.first)
            if let previousFirstDay { XCTAssertLessThan(firstDay, previousFirstDay) }
            previousVisits = totalVisits
            previousActiveMs = totalMs
            previousFirstDay = firstDay
        }
    }

    func testDemoDietHasFourteenVaryingDaysAndRespectsDates() async throws {
        let response = try await DemoMode.response(kind: "query", path: "diet:dailyTotals", args: [:])
        let days = try XCTUnwrap(response as? [[String: Any]])
        XCTAssertEqual(days.count, 14)
        let dates = try days.map { try XCTUnwrap($0["date"] as? String) }
        let calories = try days.map { try XCTUnwrap(($0["kcal"] as? NSNumber)?.doubleValue) }
        XCTAssertEqual(Set(dates).count, 14)
        XCTAssertEqual(dates, dates.sorted())
        XCTAssertGreaterThan(Set(calories).count, 1)
        let date = try XCTUnwrap(dates.first)
        let filtered = try await DemoMode.response(kind: "query", path: "diet:dailyTotals", args: ["from": date, "to": date])
        let oneDay = try XCTUnwrap(filtered as? [[String: Any]])
        XCTAssertEqual(oneDay.count, 1)
        XCTAssertEqual(oneDay.first?["date"] as? String, date)
        let dailyResponse = try await DemoMode.response(kind: "query", path: "diet:listByDate", args: ["date": date])
        let daily = try XCTUnwrap(dailyResponse as? [String: Any])
        let entries = try XCTUnwrap(daily["entries"] as? [[String: Any]])
        XCTAssertFalse(entries.isEmpty)
        XCTAssertTrue(entries.allSatisfy { $0["date"] as? String == date })
        let totals = try XCTUnwrap(daily["totals"] as? [String: Double])
        XCTAssertEqual(totals["kcal"], calories.first)
    }

    private func components(_ color: UIColor) -> [Double] {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        XCTAssertTrue(color.getRed(&r, green: &g, blue: &b, alpha: &a))
        return [Double(r), Double(g), Double(b)]
    }
    private func luminance(_ rgb: [Double]) -> Double {
        let linear = rgb.map { $0 <= 0.04045 ? $0 / 12.92 : pow(($0 + 0.055) / 1.055, 2.4) }
        return zip(linear, [0.2126, 0.7152, 0.0722]).map(*).reduce(0, +)
    }
    private func contrast(_ a: [Double], _ b: [Double]) -> Double {
        let x = luminance(a), y = luminance(b)
        return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }
}
