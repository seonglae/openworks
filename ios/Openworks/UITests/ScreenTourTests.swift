import XCTest

final class ScreenTourTests: XCTestCase {
    private var app: XCUIApplication!
    private var appearance = ""
    private var language = "en"
    private var captured: Set<String> = []

    override func tearDown() {
        app?.terminate()
        app = nil
        super.tearDown()
    }

    func testReadingListsAndDetails() {
        tour {
            for kind in ["newsletter", "paper", "article"] {
                launch(kind)
                capture("\(kind)-list", "jobs.row.sample-\(kind)-0")
                XCTAssertTrue(element("jobs.total").exists)
                XCTAssertGreaterThan(element("jobs.scroll").frame.height, 200)
                XCTAssertFalse(app.staticTexts["Total · 0"].exists)
                tap("jobs.add")
                capture("\(kind)-add", "jobs.editor.text")
                tap("jobs.editor.cancel")
                menu("jobs.stats", in: "jobs.more")
                capture("\(kind)-statistics", "stats.loaded")
                tap("stats.close")
                tap("jobs.row.sample-\(kind)-0")
                capture("\(kind)-detail", "suggestion.apply")
                tap("suggestion.apply")
                capture("\(kind)-applied", "suggestion.applied")
                XCTAssertTrue(element("suggestion.link").exists)
                XCTAssertFalse(element("suggestion.apply").exists)
                XCTAssertFalse(element("suggestion.reject").exists)
                back()
                menu("jobs.archive", in: "jobs.more")
                capture("\(kind)-archive", "jobs.row.sample-\(kind)-7")
            }
        }
    }

    func testPlansAndResearch() {
        tour {
            launch("plan")
            wait("plans.calendar.event.sample-event")
            let initialEvent = element("plans.calendar.event.sample-event")
            guard let initialDate = initialEvent.value as? String, !initialDate.isEmpty else { return XCTFail("Missing initial calendar date") }
            let todayCard = element("plans.calendar.day.\(initialDate)")
            let positioned = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                let header = self.app.otherElements.matching(identifier: "plans.controls").firstMatch
                let scroll = self.app.collectionViews.matching(identifier: "plans.scroll").firstMatch
                return todayCard.exists && header.exists && scroll.exists
                    && todayCard.frame.minY >= header.frame.maxY - 1
                    && todayCard.frame.minY >= scroll.frame.minY - 1
                    && todayCard.frame.maxY <= scroll.frame.maxY
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [positioned], timeout: 5), .completed,
                           "Today's entire card must start below the fixed controls without a manual scroll")
            capture("plans-calendar", "plans.calendar.event.sample-event")
            select("plans.mode.list")
            capture("plans-agenda", "plans.agenda.summary.sample-day")
            select("plans.mode.calendar")
            let event = element("plans.calendar.event.sample-event")
            reveal(event)
            guard let date = event.value as? String, !date.isEmpty else { return XCTFail("Missing calendar date") }
            tap("plans.date.\(date)")
            capture("plans-day", "plans.day.event.sample-event")
            tap("plans.day.event.sample-event")
            capture("plans-edit", "plans.editor.save")
            tap("plans.editor.cancel")
            tap("plans.day.close")
            tap("plans.add")
            capture("plans-new", "plans.editor.create")
            tap("plans.editor.cancel")

            launch("research")
            capture("research-list", "research.project.garden-study")
            tap("research.project.garden-study")
            capture("research-detail", "research.next.poc")
            tap("research.detail.close")
            menu("research.register", in: "research.actions")
            capture("research-register", "research.register.title")
            tap("research.register.cancel")
            select("research.kind.review")
            capture("research-reviews", "research.project.methods-review")
            tap("research.project.methods-review")
            capture("research-review-detail", "research.next.ranking")
        }
    }

    func testPRsAndInsights() {
        tour {
            launch("pr")
            capture("pr-repositories", "pr.repository.sample/garden")
            tap("pr.repository.sample/garden")
            capture("pr-list", "pr.row.sample/garden.12")
            tap("pr.row.sample/garden.12")
            capture("pr-inline-actions", "pr.chat.0")
            let scroll = element("pr.scroll")
            for id in ["pr.action.merge", "pr.action.rebase", "pr.action.close", "pr.action.github", "pr.agent.ask", "pr.agent.fix", "pr.agent.eval", "pr.prompt"] {
                XCTAssertTrue(scroll.descendants(matching: .any).matching(identifier: id).firstMatch.exists)
            }
            XCTAssertEqual(app.sheets.count, 0)
            XCTAssertFalse(element("pr.agent.ask").isEnabled)
            tap("pr.close")
            tap("pr.task")
            capture("pr-repository-task", "pr.repo.prompt")
            XCTAssertEqual(app.sheets.count, 0)
            tap("pr.repo.cancel")

            launch("insights")
            capture("insights-list", "insights.row.sample-insight-0")
            XCTAssertEqual(element("insights.total").label, language == "en" ? "Active · 2" : "활성 · 2")
            XCTAssertFalse(element("insights.row.sample-harvested").exists)
            tap("insights.row.sample-insight-0")
            capture("insights-detail", "suggestion.apply")
            tap("insights.add")
            capture("insights-composer", "insights.composer.text")
            tap("insights.composer.cancel")
        }
    }

    func testVocabularyDietAndUsage() {
        tour {
            launch("vocab")
            capture("vocab-list", "vocab.entry.sample-word")
            tap("vocab.review")
            capture("vocab-review-front", "vocab.review.answer")
            tap("vocab.review.answer")
            capture("vocab-review-answer", "vocab.review.grade.good")
            tap("vocab.add")
            capture("vocab-add", "vocab.editor.english")
            tap("vocab.editor.close")
            launch("dashboard")
            capture("dashboard", "dashboard.research.garden-study")
            launch("diet")
            capture("diet", "diet.entry.sample-meal")
            launch("usage")
            capture("usage", "usage.tab.paper")
            for days in [7, 30, 90] {
                select("usage.range.\(days)")
                let value = language == "en" ? "\(days) days" : "\(days)일"
                let chart = element("usage.days")
                let updated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    chart.exists && chart.value as? String == value
                }, object: nil)
                XCTAssertEqual(XCTWaiter.wait(for: [updated], timeout: 10), .completed,
                               "The daily chart must update to the selected range")
            }
            capture("usage-90-days", "usage.tab.paper")
        }
    }

    func testAuthorsMailboxDrawingsAndSearch() {
        tour {
            launch("paper")
            wait("jobs.row.sample-paper-0")
            menu("jobs.authors", in: "jobs.more")
            capture("authors", "authors.row.sample-author")
            for id in ["authors.position.first", "authors.position.last", "authors.position.all", "authors.metric.score", "authors.metric.count"] {
                select(id)
            }
            tap("authors.row.sample-author")
            capture("author-papers", "authors.paper.sample-paper-0")
            tap("authors.close")
            gone("authors.scroll")
            wait("jobs.row.sample-paper-0")
            launch("mailbox")
            capture("mailbox", "mailbox.entry.sample-mail")
            launch("drawings")
            capture("drawings", "drawings.title.sample-drawing")
            element("drawings.title.sample-drawing").press(forDuration: 1.2)
            let rename = element("drawings.rename.sample-drawing")
            XCTAssertTrue(rename.waitForExistence(timeout: 3), "Rename item must appear after a long press")
            rename.tap()
            capture("drawing-rename", app.alerts.textFields.firstMatch)
            app.alerts.buttons[language == "en" ? "Cancel" : "취소"].tap()
            launch("search")
            capture("search-empty", "search.scroll")
            let field = app.searchFields.firstMatch
            reveal(field)
            field.tap()
            field.typeText("garden")
            capture("search-results", "search.result.sample-paper-0")
            tap("search.result.sample-paper-0")
            capture("search-detail", "suggestion.apply")
        }
    }

    func testSettingsConnectionsAndOnboarding() {
        tour {
            launch("settings")
            capture("settings", "settings.appearance")
            tap("settings.appearance")
            capture("appearance", "appearance.token.textTitleSize")
            tap("appearance.token.textTitleSize")
            capture("appearance-editor", "appearance.value")
            back()
            back()
            tap("settings.connection")
            capture("service-connection", "connection.url")
            back()
            tap("settings.connections")
            capture("connections", "connection.input.links")
            for (direction, key) in [("input", "iphone"), ("input", "gmail"), ("input", "github"), ("input", "obsidian"), ("output", "gmail"), ("output", "notion"), ("output", "obsidian")] {
                let id = "\(direction).\(key)"
                let card = element("connection.\(id)")
                reveal(card)
                if card.value as? String != (language == "en" ? "Expanded" : "펼침") { tapCardHeader(card) }
                capture("connection-\(id)", "connection.details.\(id)")
                reveal(card)
                tapCardHeader(card)
            }
            back()
            tap("settings.onboarding")
            for step in ["language", "input", "output", "connect", "hobby"] {
                capture("onboarding-\(step)", "onboarding.\(step)")
                tap("onboarding.\(step).next")
            }
            wait("settings.onboarding")
        }
    }

    func testMoreAndTabSwipe() {
        tour {
            launch("newsletter")
            wait("jobs.row.sample-newsletter-0")
            swipeTabLeft(to: language == "en" ? "Papers" : "논문", hiding: "jobs.row.sample-newsletter-0")
            capture("swipe-paper", "jobs.row.sample-paper-0")
            swipeTabLeft(to: language == "en" ? "Articles" : "아티클", hiding: "jobs.row.sample-paper-0")
            capture("swipe-article", "jobs.row.sample-article-0")
            app.tabBars.buttons[language == "en" ? "More" : "더 보기"].tap()
            capture("more", "navigation.plan")
            XCTAssertFalse(element("jobs.row.sample-article-0").exists, "Inactive tab rows must leave accessibility")
            let keys = ["newsletter", "paper", "article", "pr", "plan", "research", "diet", "vocab", "insights", "usage", "dashboard", "mailbox", "drawings", "search", "settings"]
            for key in keys { reveal(element("navigation.\(key)")) }
            XCTAssertFalse(element("navigation.authors").exists)
        }
    }

    func testSkeletonsThenRealCounts() {
        tour(languages: ["en"]) {
            for (tab, loading, loaded) in [
                ("newsletter", "jobs.loading", "jobs.row.sample-newsletter-0"),
                ("paper", "jobs.loading", "jobs.row.sample-paper-0"),
                ("article", "jobs.loading", "jobs.row.sample-article-0"),
                ("insights", "insights.loading", "insights.row.sample-insight-0"),
                ("pr", "pr.loading", "pr.repository.sample/garden"),
                ("plan", "plans.loading", "plans.calendar.event.sample-event"),
                ("research", "research.loading", "research.project.garden-study"),
                ("drawings", "drawings.loading", "drawings.title.sample-drawing"),
                ("diet", "diet.loading", "diet.entry.sample-meal"),
                ("vocab", "vocab.loading", "vocab.entry.sample-word"),
                ("usage", "usage.loading", "usage.tab.paper"),
                ("authors", "authors.loading", "authors.row.sample-author"),
                ("mailbox", "mailbox.loading", "mailbox.entry.sample-mail"),
                ("dashboard", "dashboard.loading", "dashboard.loaded")
            ] {
                launch(tab, delay: 5)
                wait(loading)
                XCTAssertFalse(element(loaded).exists)
                if ["newsletter", "paper", "article"].contains(tab) { XCTAssertTrue(element("jobs.total.loading").exists) }
                if tab == "insights" { XCTAssertTrue(element("insights.total.loading").exists) }
                attach("\(tab)-skeleton")
                gone(loading, timeout: 35)
                capture("\(tab)-loaded", loaded)
            }
        }
    }

    func testEmptyAndFailedLoadsAreDifferent() {
        tour(languages: ["en"]) {
            for tab in ["newsletter", "paper", "article", "pr", "plan", "research", "diet", "vocab", "insights", "usage", "authors", "mailbox", "drawings"] {
                launch(tab, state: "empty")
                let scroll = tab == "plan" ? "plans.scroll" : ["newsletter", "paper", "article"].contains(tab) ? "jobs.scroll" : "\(tab).scroll"
                wait(scroll)
                let emptyLabels = [
                    "newsletter": "No items yet.", "paper": "No items yet.", "article": "No items yet.",
                    "pr": "No open pull requests", "plan": "No plans yet.", "research": "No research projects yet",
                    "diet": "No food logged for this day.", "vocab": "No expressions yet.", "insights": "No active insights.",
                    "usage": "Nothing recorded in this window yet.", "authors": "No authors yet.",
                    "mailbox": "No unread newsletters.", "drawings": "No drawings yet."
                ]
                let empty = tab == "pr" ? element("pr.empty")
                    : app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", emptyLabels[tab]!)).firstMatch
                XCTAssertTrue(empty.waitForExistence(timeout: 20), tab)
                reveal(empty)
                XCTAssertTrue(empty.label.hasPrefix(emptyLabels[tab]!), tab)
                XCTAssertFalse(element("load.failed").exists)
                attach("\(tab)-empty")
                launch(tab, state: "failed")
                capture("\(tab)-failed", "load.failed")
                if ["plan", "pr"].contains(tab) {
                    XCTAssertTrue(app.buttons["load.retry"].exists)
                    XCTAssertTrue(app.buttons["load.retry"].isEnabled)
                    XCTAssertFalse(element("load.empty").exists)
                }
            }
        }
    }

    private func tour(languages: [String] = ["en", "ko"], _ work: () -> Void) {
        continueAfterFailure = false
        for lang in languages {
            language = lang
            var expected: Set<String>?
            for style in ["light", "dark"] {
                appearance = style
                captured = []
                work()
                if let expected { XCTAssertEqual(captured, expected, "Both appearances must cover the same screens") }
                else { expected = captured }
                app?.terminate()
            }
        }
    }

    private func launch(_ tab: String, delay: TimeInterval = 0.15, state: String = "loaded") {
        app?.terminate()
        app = XCUIApplication()
        app.launchArguments = ["-OpenworksDemo", "-OpenworksDemoTab", tab, "-OpenworksDemoDelay", String(delay), "-OpenworksDemoState", state,
                               "-appearance", appearance, "-uiLanguage", language, "-AppleLanguages", "(\(language))", "-AppleLocale", language == "en" ? "en_US" : "ko_KR",
                               "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryL"]
        app.launch()
    }

    private func element(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
    private func wait(_ id: String) { XCTAssertTrue(element(id).waitForExistence(timeout: 35), id) }
    private func gone(_ id: String, timeout: TimeInterval = 10) {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element(id))
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: timeout), .completed, id)
    }
    private func tap(_ id: String) { let target = element(id); reveal(target); target.tap() }
    private func menu(_ item: String, in menu: String) { tap(menu); tap(item) }
    private func tapCardHeader(_ card: XCUIElement) {
        card.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0))
            .withOffset(CGVector(dx: 0, dy: 22)).tap()
    }
    private func swipeTabLeft(to title: String, hiding previousRow: String) {
        let list = app.collectionViews.matching(identifier: "jobs.scroll").firstMatch
        guard let lastRow = list.cells.allElementsBoundByIndex.last else { return XCTFail("Missing reading rows before tab swipe") }
        reveal(lastRow)
        let scroll = list.frame
        // Swipe in the empty list area, halfway between the last cell and
        // the tab bar. Cells and fixed controls retain their own gestures.
        let top = lastRow.frame.maxY
        let bottom = min(scroll.maxY, app.tabBars.firstMatch.frame.minY)
        XCTAssertGreaterThan(bottom, top, "Tab swipe needs an empty gap below the last reading row")
        let origin = app.coordinate(withNormalizedOffset: .zero)
        let y = (top + bottom) / 2 - app.frame.minY
        let start = origin.withOffset(CGVector(dx: scroll.minX + scroll.width * 0.8 - app.frame.minX, dy: y))
        let end = origin.withOffset(CGVector(dx: scroll.minX + scroll.width * 0.2 - app.frame.minX, dy: y))
        start.press(forDuration: 0.1, thenDragTo: end)
        let tab = app.tabBars.buttons[title]
        let selected = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            tab.exists && tab.isSelected
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [selected], timeout: 5), .completed, "Swipe must select \(title)")
        gone(previousRow)
    }
    private func back() { app.navigationBars.buttons.element(boundBy: 0).tap() }
    private func select(_ id: String) {
        let choice = element(id)
        reveal(choice)
        if !choice.isSelected { choice.tap() }
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: choice)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 5), .completed, id)
    }
    private func reveal(_ target: XCUIElement) {
        _ = target.waitForExistence(timeout: 12)
        // A new page can exist before its transition finishes. Give it time
        // to become reachable before scrolling its content out of view.
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            target.exists && target.isHittable
        }, object: nil)
        if XCTWaiter.wait(for: [ready], timeout: 2.5) == .completed { return }
        if app.statusBars.firstMatch.exists { app.statusBars.firstMatch.tap() }
        for _ in 0..<16 {
            if target.exists && target.isHittable { return }
            app.swipeUp(velocity: .slow)
        }
        add(XCTAttachment(string: app.debugDescription))
        XCTFail("Unreachable element: \(target)")
    }
    private func capture(_ name: String, _ id: String) { capture(name, element(id)) }
    private func capture(_ name: String, _ marker: XCUIElement) {
        reveal(marker)
        let hittableBars = app.navigationBars.allElementsBoundByIndex.filter { $0.isHittable }.count
        XCTAssertLessThanOrEqual(hittableBars, 1)
        attach(name)
    }
    private func attach(_ name: String) {
        XCTAssertTrue(captured.insert(name).inserted, name)
        XCTContext.runActivity(named: "\(language)-\(appearance)-\(name)") { activity in
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = "\(language)-\(appearance)-\(name)"
            shot.lifetime = .keepAlways
            activity.add(shot)
        }
    }
}
