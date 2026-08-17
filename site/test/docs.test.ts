import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOC_PAGES, DOC_SLUGS } from "../src/data/docs";
import { DEPLOY_URL } from "../src/data/product";

// The sidebar in `src/data/docs.ts` and the markdown in `docs/` are two lists
// nothing joins: the build renders their intersection. An entry naming a file
// that does not exist is a nav link to a 404, and only running the build
// catches it. This runs in `pnpm test`, which is cheaper to reach.
const files = readdirSync(new URL("../../docs", import.meta.url))
  .filter((name) => name.endsWith(".md"))
  .map((name) => name.slice(0, -".md".length));

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
