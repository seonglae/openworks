# Openworks native client (Tauri v2)

Native desktop + iOS shell that reuses your deployed Openworks web app. The
window loads a URL rather than a bundled build, so:

- 100% component reuse (it is the exact same React app that ships to the web)
- Clerk auth works unchanged. A Clerk `pk_live` key is domain-locked to its own
  site, and loading that origin keeps the WebView on an allowed one. Bundling
  the local `dist` instead would put the WebView on `tauri://localhost`, which
  Clerk rejects.

Point `app.windows[0].url` in `tauri.conf.json` at your own deployment. It
ships set to `http://localhost:6001`, the dev server, so a fresh checkout runs
without any hosting.

The app is online-only by design for now. A bundled-offline variant would need
the `tauri://localhost` (and `capacitor://`) origins added to Clerk's allowed
origins and the Convex/Clerk env baked into the local build.

## Layout

- `tauri.conf.json` — app config. `app.windows[0].url` is the site the window
  loads. `build.beforeBuildCommand` builds `browser/` (vite only, skipping the
  `tsc` step that trips on the convex type stubs).
- `src/lib.rs`, `src/main.rs` — minimal Rust entry point (logging plugin only).
- `icons/` — generated from `browser/public/icon-512.png` via `tauri icon`.
- `gen/apple/` — generated Xcode project (`tauri ios init`).

## Run / build

From the repo root:

```bash
npm run desktop:dev      # run the native window against production
npm run desktop:build    # build + bundle the desktop app
npm run ios:dev          # run in the iOS Simulator (no signing needed)
npm run ios:build        # build a device .ipa (needs a signing team)
```

Desktop builds work today (verified: `target/release/openworks`).

## Remaining one-time setup for iOS (requires user action)

The Tauri scaffold, icons, CocoaPods, and the Xcode project are all in place.
Two things still need a human because they cannot be installed headlessly:

1. **Full Xcode** (Command Line Tools alone are not enough — `xcodebuild` and
   the iOS SDK/Simulators ship only with Xcode.app):

   ```bash
   # App Store, or:
   brew install xcodes && xcodes install --latest
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   sudo xcodebuild -license accept
   xcodebuild -downloadPlatform iOS
   ```

   After that, `npm run ios:dev` runs Openworks in the Simulator with no Apple
   account required.

2. **Apple Developer signing team** (only for running on a physical device or
   producing an `.ipa`). Set it via env or config:

   ```bash
   export APPLE_DEVELOPMENT_TEAM=XXXXXXXXXX   # from `tauri info` once a cert exists
   npm run ios:build
   ```

   or add `bundle.iOS.developmentTeam` to `tauri.conf.json`.

If `gen/apple` ever drifts, regenerate it with `npm run tauri -- ios init`.
