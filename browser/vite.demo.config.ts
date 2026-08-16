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
  cacheDir: path.resolve(__dirname, ".vite-temp-demo"),
  resolve: {
    alias: [
      { find: /^convex\/react$/, replacement: path.resolve(__dirname, "demo/convex-stub.tsx") },
      { find: "convex", replacement: path.resolve(__dirname, "node_modules/convex") },
    ],
  },
});
