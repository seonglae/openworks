import XCTest

final class PullRefreshTests: XCTestCase {
    func testRefreshOnEveryScrollableArea() {
        continueAfterFailure = false
        let areas = [
            ("newsletter", "jobs.scroll", "jobs.row.sample-newsletter-0"),
            ("paper", "jobs.scroll", "jobs.row.sample-paper-0"),
            ("article", "jobs.scroll", "jobs.row.sample-article-0"),
            ("pr", "pr.scroll", "pr.repository.sample/garden"),
            ("plan", "plans.scroll", "plans.calendar.event.sample-event"),
            ("research", "research.scroll", "research.project.garden-study"),
            ("insights", "insights.scroll", "insights.row.sample-insight-0"),
            ("diet", "diet.scroll", "diet.entry.sample-meal"),
            ("vocab", "vocab.scroll", "vocab.entry.sample-word"),
            ("usage", "usage.scroll", "usage.tab.paper"),
            ("authors", "authors.scroll", "authors.row.sample-author"),
            ("dashboard", "dashboard.scroll", "dashboard.loaded"),
            ("mailbox", "mailbox.scroll", "mailbox.entry.sample-mail"),
            ("drawings", "drawings.scroll", "drawings.title.sample-drawing"),
            ("settings", "settings.scroll", "settings.appearance")
        ]
        for style in ["light", "dark"] {
            for (tab, scrollID, readyID) in areas {
                let app = XCUIApplication()
                // Keep the actual demo request in flight through accessibility
                // snapshots and the screenshot, including XCTest's idle wait.
                app.launchArguments = ["-OpenworksDemo", "-OpenworksDemoTab", tab, "-OpenworksDemoDelay", "4", "-appearance", style, "-uiLanguage", "en"]
                app.launch()
                defer { app.terminate() }
                let ready = app.descendants(matching: .any).matching(identifier: readyID).firstMatch
                XCTAssertTrue(ready.waitForExistence(timeout: 20), "Content must load before refresh: \(tab) (\(readyID))")
                let list = app.collectionViews.matching(identifier: scrollID).firstMatch
                let scroll = list.exists ? list : app.scrollViews.matching(identifier: scrollID).firstMatch
                XCTAssertTrue(scroll.waitForExistence(timeout: 5), "Scroll container must exist before refresh: \(tab) (\(scrollID))")
                let readyInScroll = scroll.descendants(matching: .any).matching(identifier: readyID).firstMatch
                XCTAssertTrue(readyInScroll.isHittable, "Scroll container must be hittable before refresh: \(tab) (\(scrollID))")
                let bar = app.navigationBars.allElementsBoundByIndex.first { $0.isHittable }
                let tabBar = app.tabBars.allElementsBoundByIndex.first { $0.isHittable }
                // Restrict the drag to visible scrolling content. A List may
                // extend underneath the navigation and tab bars.
                let top = max(scroll.frame.minY, bar?.frame.maxY ?? scroll.frame.minY)
                let bottom = min(scroll.frame.maxY, tabBar?.frame.minY ?? scroll.frame.maxY)
                let height = bottom - top
                let origin = app.coordinate(withNormalizedOffset: .zero)
                let x = scroll.frame.midX - app.frame.minX
                let start = origin.withOffset(CGVector(dx: x, dy: top + height * 0.2 - app.frame.minY))
                let end = origin.withOffset(CGVector(dx: x, dy: top + height * 0.85 - app.frame.minY))
                XCTAssertGreaterThan(height * 0.65, 200, "Pull needs room to cross the 72-point rubber-banded threshold: \(tab)")
                start.press(forDuration: 0.1, thenDragTo: end, withVelocity: XCUIGestureVelocity(rawValue: 120), thenHoldForDuration: 4)
                let spinner = app.descendants(matching: .any).matching(identifier: "refresh.spinner").firstMatch
                XCTAssertTrue(spinner.waitForExistence(timeout: 3), "Refresh spinner must appear after pulling: \(tab)")
                // The hosted anchor retains its identifier while idle or
                // pulling. Only this value proves that finger-up ran refresh.
                let refreshing = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    spinner.exists && spinner.value as? String == "refreshing"
                }, object: nil)
                XCTAssertEqual(XCTWaiter.wait(for: [refreshing], timeout: 5), .completed, "Pull must start refresh: \(tab)")
                XCTAssertEqual(spinner.value as? String, "refreshing", tab)
                let observed = Date()
                XCTAssertGreaterThanOrEqual(spinner.frame.minY, top - 1, tab)
                let shot = XCTAttachment(screenshot: app.screenshot())
                shot.name = "\(style)-\(tab)-refresh"
                shot.lifetime = .keepAlways
                add(shot)
                let finished = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false OR value != 'refreshing'"), object: spinner)
                XCTAssertEqual(XCTWaiter.wait(for: [finished], timeout: 20), .completed, tab)
                XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(observed), 0.6, tab)
                XCTAssertTrue(ready.waitForExistence(timeout: 20), "Content must return after refresh: \(tab)")
            }
        }
    }
}
