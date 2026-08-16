import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// Static output with no adapter: every page is prerendered and Cloudflare
// Pages serves dist/ as files. Nothing here is dynamic, and an adapter would
// only buy server rendering nobody asked for.
export default defineConfig({
  site: "https://openworksai.app",
  output: "static",
  build: { inlineStylesheets: "always" },
  integrations: [sitemap({ filter: (page) => !page.endsWith("/404/") })],
  markdown: {
    // smartypants rewrites `--` in the source as an em dash on the page, so
    // source that greps clean still ships them. Off: what is written ships.
    // Deprecated upstream, and the replacement is a processor option rather
    // than a flag, so an Astro major has to re-point this, not drop it.
    smartypants: false,
    shikiConfig: { themes: { light: "github-light", dark: "github-dark" }, defaultColor: false },
  },
});
