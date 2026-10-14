import { contentList, nonempty } from "./contracts.ts";
import type { Content, ContentList, ContentSource, OutputAdapter } from "./contracts.ts";

export type PreparedOutput =
  | { readonly kind: "notion"; readonly pageId: string; readonly contents: ContentList }
  | { readonly kind: "feed"; readonly title: string; readonly items: readonly FeedItem[] };
export interface FeedItem {
  readonly id: string;
  readonly title: string;
  readonly content_text: string;
  readonly source: ContentSource;
  readonly completeness: Content["completeness"];
  readonly processing: Content["processing"];
}

/** An explicit export plan, NOT a Notion API call or an approval to publish. */
export function notionOutput(pageId: string): OutputAdapter<Extract<PreparedOutput, { kind: "notion" }>> {
  nonempty(pageId, "Notion page id");
  return {
    stage: "output",
    name: "notion",
    prepare: (contents) => Object.freeze({ kind: "notion", pageId, contents: contentList(contents) }),
  };
}

/** Portable feed data. Hosting, transport and audience authorization belong to callers. */
export function feedOutput(title: string): OutputAdapter<Extract<PreparedOutput, { kind: "feed" }>> {
  nonempty(title, "feed title");
  return {
    stage: "output",
    name: "feed",
    prepare: (contents) =>
      Object.freeze({
        kind: "feed",
        title,
        items: Object.freeze(
          contentList(contents).map((item) =>
            Object.freeze({
              id: item.id,
              title: item.title,
              content_text: item.text,
              source: item.source,
              completeness: item.completeness,
              processing: item.processing,
            }),
          ),
        ),
      }),
  };
}
