import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The demo build: the same app, with `convex/react` swapped for a fixture
// stub, so the UI can be run and screenshotted without a deployment and
// without anyone's data in it. `demo/fixtures.ts` is the whole dataset.
//
// The exact-match alias has to come first. A bare "convex" alias is a prefix
// match, so it would swallow "convex/react" before the stub ever saw it, while
// still being needed for "convex/server" and "convex/values".
// Root stays at browser/ rather than demo/, because Tailwind v4 scans for
// class names from the project root: rooted at demo/ it finds the three files
// there, none of the views, and the page renders with no utilities at all.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 6009, open: "/demo/index.html" },
  // The site serves this build from /demo/, and the default base of "/" makes
  // the bundle ask for /assets/, which is the marketing site's own build.
  base: "/demo/",
  // Its own outDir, because the root stays at browser/ and a default `dist`
  // would overwrite the real app's build with a fixture one. The entry is named
  // here for the same reason: rooted at browser/, vite would otherwise pick up
  // index.html, which is the app.
  build: {
    outDir: "dist-demo",
    emptyOutDir: true,
    rollupOptions: { input: path.resolve(__dirname, "demo/index.html") },
    // public/ is the real app's: its sw.js would install a service worker on
    // the marketing origin the moment the embed loads, and its manifest would
    // offer the fixture app for install.
    copyPublicDir: false,
  },
  cacheDir: path.resolve(__dirname, ".vite-temp-demo"),
  resolve: {
    alias: [
      { find: /^convex\/react$/, replacement: path.resolve(__dirname, "demo/convex-stub.tsx") },
      { find: "convex", replacement: path.resolve(__dirname, "node_modules/convex") },
    ],
  },
});
