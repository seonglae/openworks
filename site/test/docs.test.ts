import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOC_GROUPS, DOC_PAGES, DOC_SLUGS } from "../src/data/docs";
import { DEPLOY_URL, PRODUCT_LEDE } from "../src/data/product";

// The sidebar in `src/data/docs.ts` and the markdown in `docs/` are two lists
// nothing joins: the build renders their intersection. An entry naming a file
// that does not exist is a nav link to a 404, and only running the build
// catches it. This runs in `pnpm test`, which is cheaper to reach.
const files = readdirSync(new URL("../../docs", import.meta.url))
  .filter((name) => name.endsWith(".md"))
  .map((name) => name.slice(0, -".md".length));
const readRepoText = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("docs sidebar", () => {
  it("has a page behind every entry", () => {
    expect(DOC_SLUGS.filter((slug) => !files.includes(slug))).toEqual([]);
  });

  it("lists each slug once", () => {
    expect([...new Set(DOC_SLUGS)]).toEqual(DOC_SLUGS);
  });

  it("gives every entry the title and blurb the index card renders", () => {
    for (const page of DOC_PAGES) {
      expect(page.title.length, page.slug).toBeGreaterThan(0);
      expect(page.blurb.length, page.slug).toBeGreaterThan(0);
    }
  });

  it("resolves published guide links through the sidebar allow-list", () => {
    for (const slug of DOC_SLUGS) {
      const text = readRepoText(`docs/${slug}.md`);
      for (const [, target] of text.matchAll(/\]\(\/docs\/([^/#)]+)\/(?:#[^)]*)?\)/g)) {
        expect(DOC_SLUGS, `${slug} links to ${target}`).toContain(target);
      }
    }
  });
});

// The deploy URL carries the Convex integration that makes the button provision
// a backend. Markdown cannot import the constant, so the two files that paste it
// drift silently: an edit to one leaves the other pointing at a flow that no
// longer provisions anything, and the button still looks fine.
describe("the deploy button", () => {
  for (const file of ["../../README.md", "../../docs/deploy.md"]) {
    it(`is the one canonical URL in ${file.replace("../../", "")}`, () => {
      const text = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(text.match(/https:\/\/vercel\.com\/new\/clone\?[^)\s]*/g)).toEqual([DEPLOY_URL]);
    });
  }
});

describe("personal content product positioning", () => {
  it("keeps every Markdown guide aligned with the personal content scope", () => {
    const guides = [
      ...files.map((name) => `docs/${name}.md`),
      "README.md",
      "site/README.md",
      "convex/README.md",
      "deploy/launchd/README.md",
      "ios/Openworks/README.md",
    ];
    for (const guide of guides) {
      const text = readFileSync(new URL(`../../${guide}`, import.meta.url), "utf8");
      expect(text.toLowerCase(), guide).toContain("personal content");
      expect(text, guide).not.toMatch(/research is the first vertical/i);
      expect(text, guide).not.toMatch(/everything in Openworks is a project/i);
    }
  });

  it("puts content architecture and comparison before the research use case", () => {
    const working = DOC_GROUPS.find((group) => group.label === "Working")?.items.map((page) => page.slug) ?? [];
    expect(working.slice(0, 2)).toEqual(["content-management", "product-comparison"]);
    expect(working.indexOf("research")).toBeGreaterThan(working.indexOf("product-comparison"));
    expect(DOC_PAGES.find((page) => page.slug === "research")?.title).toBe("Research use case");
  });

  it("links both guides from the README and links the published guides to each other", () => {
    for (const slug of ["content-management", "product-comparison"]) {
      expect(readRepoText("README.md")).toContain(`](docs/${slug}.md)`);
      expect(readRepoText("site/src/pages/index.astro")).toContain(`href="/docs/${slug}/"`);
    }
    expect(readRepoText("docs/content-management.md")).toContain("](/docs/product-comparison/)");
    expect(readRepoText("docs/product-comparison.md")).toContain("](/docs/content-management/)");
  });

  it("keeps public page metadata and social-card source aligned with personal content", () => {
    expect(PRODUCT_LEDE).toContain("personal content input/output management");
    for (const path of ["site/src/pages/index.astro", "site/src/layouts/Base.astro", "site/og-card.html"]) {
      const text = readRepoText(path);
      expect(text.toLowerCase(), path).toContain("personal content");
      expect(text, path).not.toMatch(/research is the first vertical|work in progress,<br\s*\/>addressable/i);
    }
    expect(readRepoText("site/src/pages/index.astro")).toContain("<h3>Research use case</h3>");
  });
});
