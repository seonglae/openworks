# Openworks (iOS)

A native SwiftUI client over the same Convex backend the browser reads. This
replaces the Tauri shell that used to live in `src-tauri/`, which was a window
pointing at the deployed web app rather than an app.

The phone gets the three surfaces worth having in a pocket. The desktop keeps
the ones that need a keyboard and a large canvas: the drawing surface, LaTeX,
the reorderable tab graph, the PR and insight views.

| Tab | Reads | Shows |
| --- | --- | --- |
| Reading | `jobs:list`, `jobs:count`, `summaries:listByJob` | newsletters, papers and articles with the agent's tldr on the row, so the list reads without opening anything. Infinite scroll, swipe to archive, an archive toggle |
| Plan | `plans:allItems`, `plans:toggleDone` | the plan from today forward, grouped by day, tap to tick a todo. Past days are behind a toggle rather than dropped |
| Research | `research:listAllProjects`, `research:getTimeline` | projects by how recently they moved, and the state transitions behind each one |
| Settings | `jobs:count` | the connection, proved with a counted query |

## Auth

`OPENWORKS_SERVICE_KEY`, the same single-owner key the CLI workers and the MCP
server present to `requireOwner`. The phone is one more owner-side caller, so
it needs no Clerk session and no allowed browser origin, which is what made the
old WebView shell awkward.

`settings:whoami` is deliberately not the connection test: it answers about the
Clerk identity, and a service-key caller has none, so it would report "not
authenticated" over a perfectly good connection.

The key is stored in `UserDefaults` on the device and sent only to the
deployment it came from.

## Build

```bash
cp Secrets.xcconfig.example Secrets.xcconfig   # fill in URL, key, team id
xcodegen generate
open Openworks.xcodeproj
```

`Secrets.xcconfig`, the generated `Openworks.xcodeproj` and `Info.plist` are
gitignored, so a clone carries no deployment and no key. Values baked in at
build time are only defaults: both are overridable on the Settings screen, on
that device alone.

Simulator build without signing:

```bash
xcodebuild -project Openworks.xcodeproj -scheme Openworks \
  -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO
```

## Source layout

```
project.yml               XcodeGen spec: one target, xcconfig-driven Info.plist
Shared/ConvexHTTP.swift   Convex function API client, including paginated queries
Shared/Models.swift       row decoders for jobs, summaries, plan, projects, timeline
Shared/Theme.swift        the browser's ink/slate/sage palette, shared load states
App/OpenworksApp.swift    @main TabView shell
App/ReadingView.swift     the queue and one job's summaries
App/PlanView.swift        the plan by day, with the done toggle
App/ResearchView.swift    projects and their timelines
App/SettingsView.swift    connection
```

Deployment target iOS 17. No third-party dependencies.

## Push

The phone registers an APNs token with the deployment, and the same broadcast
that already sends Web Push on a summary landing sends to it. The app does not
ask on launch: a notification prompt before the app has shown anything worth
being notified about is the one that gets denied, and iOS only asks once, so
the switch is on the Settings screen.

Three values on the deployment, from an APNs auth key:

```bash
npx convex env set APNS_KEY_ID   ABC123DEFG
npx convex env set APNS_TEAM_ID  YOURTEAMID
npx convex env set APNS_AUTH_KEY "$(cat AuthKey_ABC123DEFG.p8)"
```

The key is one `.p8` for the whole team, made once at
**developer.apple.com → Certificates, Identifiers & Profiles → Keys → +**, with
Apple Push Notifications service (APNs) ticked. Apple lets you download it
exactly once; the key id is in the filename. Unset, the backend sends Web Push
and skips the phones rather than failing, which is the right behaviour for a
deployment nobody has built this app for.

The bundle id needs Push Notifications enabled on its App ID, and
`aps-environment` is in `project.yml` as `development`: a build installed from
Xcode gets a sandbox token, and the app reads the entitlement back out of its
own provisioning profile so the backend knows which APNs host to send to.
