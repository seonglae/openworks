import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// Static output with no adapter: every page is prerendered and Cloudflare
// Pages serves dist/ as files. Nothing here is dynamic, and an adapter would
// only buy server rendering nobody asked for.
//
// `typecheck` is the build rather than `astro check`, which needs TypeScript's
// programmatic API. The native 7.x compiler this repo is on does not ship it.
// The build is still type-aware over the content collection and the .astro
// files, so a broken doc reference fails here.
export default defineConfig({
  site: "https://openworksai.app",
  output: "static",
  build: { inlineStylesheets: "always" },
  integrations: [sitemap({ filter: (page) => !page.endsWith("/404/") })],
  markdown: {
    // smartypants rewrites `--` in the source as an em dash on the page, so
    // source that greps clean still ships them. Off: what is written ships.
    smartypants: false,
    shikiConfig: { themes: { light: "github-light", dark: "github-dark" }, defaultColor: false },
  },
});
