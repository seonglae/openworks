# Openworks for iPhone

Openworks is a native SwiftUI client for the same personal content workspace as the browser. It requires iOS 18 or later and uses the existing Convex service-key connection.

The tabs follow the browser's order: Newsletters, Papers, Articles, PRs, Plans, Research, Diet, Vocab, Insights and Usage. The first four enabled modes appear in the tab bar; More contains the remaining modes, Dashboard, Mailbox, Drawings, Search and Settings. Authors opens from the Papers menu. Swipe horizontally across an unobstructed part of a root screen to change tab; row actions and nested navigation keep their own gestures.

| Screen | Available work |
| --- | --- |
| Newsletters, Papers, Articles | Paginated lists, search, add links or text, archive, change type, summaries, scores, images and suggested Notion edits |
| Statistics | Newsletter arrivals and sources; paper and article score distributions with list filters |
| PRs | Repository groups, checks, inline merge/close/update actions and agent conversations |
| Plans | Calendar, agenda, date ranges, event editing, todos and calendar sync |
| Research | Own projects and reviews, phase transitions, visibility, files, linked papers and history |
| Insights | Personal insights, filters, image attachments and suggested output placement |
| Vocab | Expressions, spaced reviews, bulk import and Notion import/export |
| Diet | Daily entries, food photos, nutrition totals and trends |
| Usage | Web activity totals, per-tab time, daily charts and transitions |
| Authors | Ranked authors and their papers |
| Dashboard | Weekly reading activity, research phases and PR status |
| Mailbox | Request unread newsletters and send them for processing |
| Drawings | Thumbnail gallery, rename and delete; drawing creation stays on the web |
| Search | Search newsletter, paper and article titles and content |
| Settings | Service connection, connectors, onboarding, display and agent languages, enabled tabs, notifications and local appearance values |

Pretendard typography, monochrome kind and island icons, light and dark palettes, shared segmented buttons and content-shaped skeletons are used throughout. Images reserve their frame while loading. Pull to refresh preserves the background and shows its spinner below the navigation bar for at least 0.6 seconds. Failed loads are labeled separately from empty results, and applied suggestions show their state and destination link.

The display language is Korean or English. Agent output language is configured separately. Appearance starts from bundled defaults; the Appearance editor previews and saves overrides in this device's UserDefaults. It does not require a server appearance endpoint. Pretendard is bundled under the SIL Open Font License in `Resources/Pretendard-LICENSE.txt`; attribution is also in the root `NOTICE`. SwiftMath is the only Swift package dependency.

## Connection

Set `OPENWORKS_CONVEX_URL`, `OPENWORKS_SERVICE_KEY` and `OPENWORKS_TEAM_ID` in your local `Secrets.xcconfig`, using `Secrets.xcconfig.example` as a template. URL and service key can also be overridden in Settings → Server connection. The app stores those overrides in UserDefaults and sends the key only to the server you configure. The connection test uses `jobs:count`.

`Secrets.xcconfig`, the generated Xcode project and `Info.plist` are ignored by Git. Do not put credentials or a deployment address in tracked source. Connector credentials belong to the configured backend; connecting GitHub, Gmail or Obsidian also depends on its worker being available.

## Build and test

Run from this directory after creating your local configuration:

```sh
xcodegen generate
open Openworks.xcodeproj
xcodebuild -project Openworks.xcodeproj -scheme Openworks -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO
```

The generated scheme includes `OpenworksTests` and `OpenworksUITests`. Choose an installed iPhone simulator for execution; a generic destination builds but cannot run UI tests.

```sh
xcodebuild -project Openworks.xcodeproj -scheme Openworks -destination 'platform=iOS Simulator,name=iPhone 17' test CODE_SIGNING_ALLOWED=NO -resultBundlePath /tmp/OpenworksTests.xcresult
```

`ScreenTourTests` visits the lists, details, editors, statistics, connectors, onboarding and settings in both appearances and both display languages. It attaches a screenshot for each visited state and also covers skeleton, empty and failed states. `PullRefreshTests` checks the refresh spinner and attaches screenshots across scrollable areas in light and dark. Unit tests cover theme contrast, bundled fonts and token defaults, rich text parsing, score filters, notification routing and demo state changes. Screenshots are retained as attachments in the test result bundle.

For a manual demo, add `-OpenworksDemo` to the app's launch arguments. Optional arguments are `-OpenworksDemoTab paper`, `-OpenworksDemoState empty` or `failed`, `-OpenworksDemoDelay 2`, `-appearance light` or `dark`, and `-uiLanguage en` or `ko`. All fixtures are invented, images are generated locally, and the demo intercepts backend transport before reading credentials or making requests. Demo appearance edits do not persist. The test scheme sets `OPENWORKS_DEMO=1` for its app host.

## Backend boundaries

Reading counts use `jobs:count`; score bands filter the `summaryScores` returned by `jobs:listOffset`. Personal insight counts and filters use `insights:list`. Dashboard combines `jobs:jobDateStats`, research and GitHub queries instead of a dedicated summary endpoint; personal citation metrics are omitted because no endpoint supplies them. Research phases come from `research:getStateInfo`, connector types are defined locally from the supported catalog, and Usage reads `usage:overview` and `usage:flow`.

There is no map, city metadata or weather layer because this backend lacks `plans:resolveCities`, and no retry-publishing control because it lacks `notionPush:retry`. Search is limited to reading items because there is no `feed:search`. Notion supports token setup, a root page and the vocabulary database; its settings endpoint has no per-output language or excluded-page arguments, and its OAuth action does not support a native callback. Feed, Home flow, Routine, Friends, Reels, Uploads, Topics and a share extension are outside this client's scope.

## Notifications

Enable notifications in Settings after configuring the connection. The app registers through `push:registerDevice`; tapping an item notification reveals the appropriate reading list and opens that item. The backend needs its APNs key configuration, and a device build needs an App ID and provisioning profile with Push Notifications enabled. The app reads the provisioning entitlement to select the APNs environment. Demo mode does not register a device or request notification permission.

## Source layout

`App/OpenworksApp.swift` and `App/Shell.swift` own navigation and shared selection. Each area has its own view and model under `App`. `Shared/Theme.swift`, `LiquidRefresh.swift`, `SegmentedButtons.swift`, `JobDisplay.swift` and `RichText.swift` provide presentation components; `Shared/ConvexHTTP.swift` owns authenticated transport. `App/DemoMode.swift` provides isolated test data, and `Resources` contains appearance definitions and fonts. `project.yml` is the source of truth for the application and test targets.
