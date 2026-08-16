import { describe, expect, it } from "vitest";
import { anchorNeedle, blockSearchText, resolveAnchorIndex } from "../notion";

// A suggestion's contextBefore is markdown, produced by fetchPageAsMarkdown.
// The insertion anchor is looked up against live Notion blocks. Those are two
// different representations of the same content, and every test here is a
// shape where they disagree: if the two sides are not reduced to a common
// surface, findInsertionBlock returns undefined and Notion appends the
// suggestion at the end of the page instead of at the shown position.
const bookmark = (url: string) => ({ type: "bookmark", bookmark: { url } });
const paragraph = (text: string, href?: string) => ({
  type: "paragraph",
  paragraph: { rich_text: [{ plain_text: text, href: href ?? null }] },
});
const heading = (text: string) => ({ type: "heading_2", heading_2: { rich_text: [{ plain_text: text }] } });
const bullet = (text: string) => ({
  type: "bulleted_list_item",
  bulleted_list_item: { rich_text: [{ plain_text: text }] },
});

// Does the anchor derived from a markdown line find the block it came from?
const finds = (markdownLine: string, block: Record<string, unknown>) => {
  const needle = anchorNeedle(markdownLine);
  const hay = blockSearchText(block);
  return needle.length > 0 && hay.includes(needle);
};

describe("anchoring a suggestion to the block its context came from", () => {
  // The reported bug, with the values observed on dev:example-deployment-123: the
  // whole target page is one bookmark, and a bookmark carries no rich_text at
  // all, so the old text-only comparison saw an empty string and gave up.
  it("anchors a bookmark line to the bookmark block, which has no rich_text", () => {
    const url = "https://github.github.com/gh-stack/introduction/overview/";
    expect(finds(`[Link](${url})`, bookmark(url))).toBe(true);
  });

  it("anchors a linked paragraph, whose markdown carries syntax the block text does not", () => {
    const url = "https://horizon.kias.re.kr/33348/";
    expect(finds(`[Lean overview](${url})`, paragraph("Lean overview", url))).toBe(true);
  });

  it("anchors a list item, whose markdown carries a bullet marker the block text does not", () => {
    expect(finds("- Stacked diffs at GitHub", bullet("Stacked diffs at GitHub"))).toBe(true);
    expect(finds("1. Stacked diffs at GitHub", bullet("Stacked diffs at GitHub"))).toBe(true);
  });

  // Regression guards: the two shapes that already worked must keep working.
  it("still anchors a heading", () => {
    expect(finds("## Today's Papers", heading("Today's Papers"))).toBe(true);
  });

  it("still anchors a plain paragraph", () => {
    expect(finds("Some plain sentence.", paragraph("Some plain sentence."))).toBe(true);
  });

  it("does not anchor to an unrelated block", () => {
    expect(finds("## Today's Papers", heading("Something else entirely"))).toBe(false);
    expect(finds("[Link](https://a.example/one)", bookmark("https://b.example/two"))).toBe(false);
  });

  // Structural markers carry no identity, so they must not become an anchor
  // that matches an arbitrary block.
  it("yields no needle for a marker-only line", () => {
    expect(anchorNeedle("[Database]")).toBe("");
    expect(anchorNeedle("[Breadcrumb]")).toBe("");
    expect(anchorNeedle("---")).toBe("");
  });
});

describe("resolving the insert position", () => {
  // The shape of the real page this was reported on, read back from
  // dev:example-deployment-123: 18 blocks, the anchored bookmark at index 13, a
  // breadcrumb last. Returning undefined here is what sent the insert to the
  // bottom, so the assertion is the index, not merely "found something".
  const realPage = [
    ...Array.from({ length: 4 }, () => paragraph("")),
    paragraph("Leanstral"),
    bookmark("https://mistral.ai/news/leanstral"),
    ...Array.from({ length: 7 }, () => paragraph("")),
    bookmark("https://horizon.kias.re.kr/33348/"),
    ...Array.from({ length: 3 }, () => paragraph("")),
    { type: "breadcrumb", breadcrumb: {} },
  ];

  it("anchors to the bookmark in the middle of the page, not the last block", () => {
    expect(realPage).toHaveLength(18);
    const idx = resolveAnchorIndex(realPage, "[Link](https://horizon.kias.re.kr/33348/)");
    expect(idx).toBe(13);
    expect(idx).not.toBe(realPage.length - 1);
  });

  it("picks the first matching block when a page repeats a URL", () => {
    expect(resolveAnchorIndex(realPage, "[Link](https://mistral.ai/news/leanstral)")).toBe(5);
  });

  it("reports no anchor when the context is absent, so the caller can append", () => {
    expect(resolveAnchorIndex(realPage, undefined)).toBeUndefined();
    expect(resolveAnchorIndex(realPage, "")).toBeUndefined();
  });

  it("reports no anchor when the context names something the page does not have", () => {
    expect(resolveAnchorIndex(realPage, "[Link](https://nowhere.example/missing)")).toBeUndefined();
  });

  // Trailing markers in the context mean the anchor sits that many blocks back.
  it("steps forward past trailing context lines", () => {
    const ctx = "Leanstral\n[Link](https://mistral.ai/news/leanstral)";
    expect(resolveAnchorIndex(realPage, ctx)).toBe(5);
  });
});
