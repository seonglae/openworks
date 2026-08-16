import { v } from "convex/values";
import { action, internalMutation } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { requireOwner } from "./auth";

// Notion accepts a page/database id either hyphenated or bare, but its REST
// paths want it bare. Stripping it inline was written out at every call site.
const bareId = (id: string): string => id.replace(/-/g, "");

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

function parseContentToBlocks(content: string) {
  const lines = content.split("\n").filter((l) => l.trim());
  const blocks: Record<string, unknown>[] = [];

  for (const line of lines) {
    if (line.startsWith("### ")) {
      blocks.push({
        object: "block",
        type: "heading_3",
        heading_3: {
          rich_text: [{ type: "text", text: { content: line.slice(4) } }],
        },
      });
    } else if (line.startsWith("## ")) {
      blocks.push({
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [{ type: "text", text: { content: line.slice(3) } }],
        },
      });
    } else if (line.startsWith("> ")) {
      blocks.push({
        object: "block",
        type: "quote",
        quote: {
          rich_text: [{ type: "text", text: { content: line.slice(2) } }],
        },
      });
    } else if (line.match(/^\[.+\]\(.+\)$/)) {
      const match = line.match(/^\[(.+)\]\((.+)\)$/);
      if (match) {
        blocks.push({
          object: "block",
          type: "bookmark",
          bookmark: { url: match[2] },
        });
      }
    } else {
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: line } }],
        },
      });
    }
  }
  return blocks;
}

async function fetchAllBlocks(token: string, pageId: string) {
  const all: { id: string; type: string; [k: string]: unknown }[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const params = cursor ? `?page_size=100&start_cursor=${cursor}` : "?page_size=100";
    const data = await notionFetch(token, `/blocks/${pageId}/children${params}`);
    all.push(...(data.results as typeof all));
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return all;
}

async function notionFetch(token: string, path: string, method = "GET", body?: unknown) {
  const res = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API ${res.status}: ${text}`);
  }
  return res.json();
}

// A suggestion's contextBefore is markdown, rendered by fetchPageAsMarkdown,
// but the anchor has to be found among live Notion blocks. Those are two
// representations of the same content and they do not coincide: a bookmark
// renders as `[Link](url)` yet carries no rich_text at all, a linked paragraph
// renders as `[text](href)` against a block whose text is only `text`, and list
// items gain a marker. Comparing the raw forms matched headings and plain
// paragraphs and nothing else, so every other shape fell through to no `after`,
// which makes Notion append at the end of the page. Both sides are reduced to a
// common surface instead.

// Structural markers carry no identity, so they must never become the anchor.
const MARKER_ONLY = /^\[[^\]()]*\]$/;
const MD_LINK = /\[[^\]]*\]\(([^)\s]+)\)/;

export function anchorNeedle(line: string): string {
  const trimmed = line.trim();
  if (!trimmed || /^-{3,}$/.test(trimmed) || MARKER_ONLY.test(trimmed)) return "";
  // A URL survives both representations intact, and for a bookmark it is the
  // only identifying content there is: the rendered label is the word "Link".
  const link = trimmed.match(MD_LINK);
  if (link) return link[1];
  return trimmed
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .trim();
}

// What a block offers for anchoring: everything visible plus every URL it
// carries. Deliberately not extractBlockText, which feeds insight harvesting
// and must stay visible-text-only.
export function blockSearchText(block: Record<string, unknown>): string {
  const type = block.type as string;
  const content = block[type] as Record<string, unknown> | undefined;
  if (!content) return "";
  const parts: string[] = [];
  const richText = content.rich_text as { plain_text?: string; href?: string | null }[] | undefined;
  for (const t of richText ?? []) {
    if (t.plain_text) parts.push(t.plain_text);
    if (t.href) parts.push(t.href);
  }
  // bookmark / embed / link_preview keep their target in `url` and have no
  // rich_text, which is exactly why they used to be invisible here.
  if (typeof content.url === "string") parts.push(content.url);
  const caption = content.caption as { plain_text?: string }[] | undefined;
  for (const c of caption ?? []) if (c.plain_text) parts.push(c.plain_text);
  return parts.join(" ");
}

// Pure half, so the position this resolves to can be tested without Notion:
// position is the whole point of the anchor, and returning undefined here is
// not a soft failure, it silently appends at the end of the page.
export function resolveAnchorIndex(
  blocks: readonly Record<string, unknown>[],
  contextBefore?: string,
): number | undefined {
  if (!contextBefore) return undefined;

  const lines = contextBefore.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return undefined;

  // Walk back to the last line that carries identity; trailing structural
  // markers anchor nothing.
  let anchorLineIdx = -1;
  let needle = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = anchorNeedle(lines[i]);
    if (candidate) {
      anchorLineIdx = i;
      needle = candidate;
      break;
    }
  }
  if (anchorLineIdx === -1) return undefined;

  // Count how many block-type markers follow the anchor line
  const skipAfter = lines.length - 1 - anchorLineIdx;

  for (let i = 0; i < blocks.length; i++) {
    if (blockSearchText(blocks[i]).includes(needle)) {
      // Skip forward past the trailing blocks (bookmarks etc.)
      return Math.min(i + skipAfter, blocks.length - 1);
    }
  }
  return undefined;
}

async function findInsertionBlock(token: string, pageId: string, contextBefore?: string): Promise<string | undefined> {
  if (!contextBefore) return undefined;
  const blocks = await fetchAllBlocks(token, pageId);
  const idx = resolveAnchorIndex(blocks, contextBefore);
  return idx === undefined ? undefined : (blocks[idx].id as string);
}

function extractBlockText(block: Record<string, unknown>): string {
  const type = block.type as string;
  const content = block[type] as Record<string, unknown> | undefined;
  if (!content) return "";
  const richText = content.rich_text as { plain_text?: string }[] | undefined;
  if (!richText) return "";
  return richText.map((t) => t.plain_text ?? "").join("");
}

export const executeNotionInsert = action({
  args: {
    suggestionId: v.id("suggestions"),
    pageId: v.string(),
    content: v.string(),
    contextBefore: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const token = process.env.NOTION_TOKEN;
    if (!token) throw new Error("NOTION_TOKEN not set");

    const cleanPageId = bareId(args.pageId);
    const blocks = parseContentToBlocks(args.content);

    const afterBlockId = await findInsertionBlock(token, cleanPageId, args.contextBefore);

    await notionFetch(token, `/blocks/${cleanPageId}/children`, "PATCH", {
      children: blocks,
      ...(afterBlockId ? { after: afterBlockId } : {}),
    });

    await ctx.runMutation(internal.notion.markExecuted, {
      suggestionId: args.suggestionId,
    });
  },
});

// Push every vocab expression into a Notion database as a page (title = the
// English phrase; jp/reading/meaning/example go in the page body). Works
// against any database — it discovers the title property at runtime.
export const exportVocab = action({
  args: { databaseId: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const token = process.env.NOTION_TOKEN;
    if (!token) throw new Error("NOTION_TOKEN not set");
    const dbId = bareId(args.databaseId);

    const db = await notionFetch(token, `/databases/${dbId}`);
    const props = db.properties as Record<string, { type: string }>;
    const titleProp = Object.keys(props).find((k) => props[k].type === "title") ?? "Name";

    const rows = (await ctx.runQuery(api.expressions.list, {
      serviceKey: process.env.OPENWORKS_SERVICE_KEY,
    })) as Array<{ en: string; jp?: string; reading?: string; meaning?: string; example?: string }>;

    const para = (s: string) => ({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: s } }] },
    });

    let count = 0;
    for (const r of rows) {
      const children = [r.jp, r.reading, r.meaning, r.example]
        .filter((x): x is string => Boolean(x))
        .map((s) => para(s));
      await notionFetch(token, `/pages`, "POST", {
        parent: { database_id: dbId },
        properties: { [titleProp]: { title: [{ text: { content: r.en } }] } },
        children,
      });
      count++;
    }
    return { count };
  },
});

// Import a whole Notion page's vocab into Openworks. The page id can point at a
// container page (e.g. "English Expression" / "Japanese Expression") that holds
// one or more inline databases: every database found inside it is queried and
// each row's title becomes an expression (deduped, marked pendingEnrich so the
// worker fills jp / reading / meaning / example). Also works when the id is a
// database itself. "Include everything in the page, databases and all."
export const importVocabFromNotion = action({
  args: { pageId: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ databases: number; found: number; imported: number; truncated: boolean }> => {
    await requireOwner(ctx, args.serviceKey);
    const token = process.env.NOTION_TOKEN;
    if (!token) throw new Error("NOTION_TOKEN not set");
    const rootId = bareId(args.pageId);

    // Discover databases: child_database blocks under the page, else treat the
    // id as a database directly.
    let dbIds: string[] = [];
    try {
      const blocks = await fetchAllBlocks(token, rootId);
      dbIds = blocks.filter((b) => b.type === "child_database").map((b) => bareId(b.id));
    } catch {
      /* not a page (or no read) — fall through to database fallback */
    }
    if (dbIds.length === 0) dbIds = [rootId];

    const ens: string[] = [];
    let databases = 0;
    let truncated = false;
    const CAP = 3000;
    for (const dbId of dbIds) {
      let db: { properties?: Record<string, { type: string }> };
      try {
        db = await notionFetch(token, `/databases/${dbId}`);
      } catch {
        continue; // block was not actually a queryable database
      }
      databases++;
      const props = db.properties ?? {};
      const titleProp = Object.keys(props).find((k) => props[k].type === "title") ?? "Name";
      let cursor: string | undefined;
      for (let page = 0; page < 40; page++) {
        const res: { results?: any[]; has_more?: boolean; next_cursor?: string } = await notionFetch(
          token,
          `/databases/${dbId}/query`,
          "POST",
          { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
        );
        for (const row of res.results ?? []) {
          const rich = row.properties?.[titleProp]?.title ?? [];
          const en = rich
            .map((x: { plain_text?: string }) => x.plain_text ?? "")
            .join("")
            .trim();
          if (en) ens.push(en);
          if (ens.length >= CAP) {
            truncated = true;
            break;
          }
        }
        if (truncated || !res.has_more) break;
        cursor = res.next_cursor;
      }
      if (truncated) break;
    }

    const r = await ctx.runMutation(api.expressions.addBatchEn, {
      ens,
      serviceKey: process.env.OPENWORKS_SERVICE_KEY,
    });
    return { databases, found: ens.length, imported: r.added, truncated };
  },
});

export const approveAndExecute = action({
  args: { suggestionId: v.id("suggestions"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const suggestion = await ctx.runQuery(internal.suggestions.internalGetById, { suggestionId: args.suggestionId });
    if (!suggestion) throw new Error("Suggestion not found");

    await ctx.runMutation(internal.suggestions.internalSetStatus, {
      suggestionId: args.suggestionId,
      status: "approved",
    });

    const token = process.env.NOTION_TOKEN;
    if (!token) throw new Error("NOTION_TOKEN not set");

    const cleanPageId = bareId(suggestion.pageId);
    const blocks = parseContentToBlocks(suggestion.content);
    const afterBlockId = await findInsertionBlock(token, cleanPageId, suggestion.contextBefore);

    await notionFetch(token, `/blocks/${cleanPageId}/children`, "PATCH", {
      children: blocks,
      ...(afterBlockId ? { after: afterBlockId } : {}),
    });

    await ctx.runMutation(internal.suggestions.internalSetStatus, {
      suggestionId: args.suggestionId,
      status: "executed",
    });
    // Close the job out only after every suggestion on it has been
    // resolved (executed or rejected). No-op while others are still
    // pending/approved.
    await ctx.runMutation(internal.suggestions.markJobDoneIfAllResolved, {
      jobId: suggestion.jobId,
    });
  },
});

export const approveAllAndExecute = action({
  args: { jobId: v.id("jobs"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const pending = await ctx.runQuery(internal.suggestions.internalGetPendingByJob, { jobId: args.jobId });

    const token = process.env.NOTION_TOKEN;
    if (!token) throw new Error("NOTION_TOKEN not set");

    for (const suggestion of pending) {
      await ctx.runMutation(internal.suggestions.internalSetStatus, {
        suggestionId: suggestion._id,
        status: "approved",
      });

      try {
        const cleanPageId = bareId(suggestion.pageId);
        const blocks = parseContentToBlocks(suggestion.content);
        const afterBlockId = await findInsertionBlock(token, cleanPageId, suggestion.contextBefore);

        await notionFetch(token, `/blocks/${cleanPageId}/children`, "PATCH", {
          children: blocks,
          ...(afterBlockId ? { after: afterBlockId } : {}),
        });

        await ctx.runMutation(internal.suggestions.internalSetStatus, {
          suggestionId: suggestion._id,
          status: "executed",
        });
      } catch (e) {
        console.error(`Failed to execute suggestion ${suggestion._id}:`, e);
      }
    }
    // After the batch, flip the job to done if every suggestion is now
    // resolved (executed/rejected). Stays at 'suggested' if any failed
    // attempt left a row in approved/pending state.
    await ctx.runMutation(internal.suggestions.markJobDoneIfAllResolved, {
      jobId: args.jobId,
    });
  },
});

// Import a whole Notion page's text blocks as insights (e.g. a personal memo /
// temp-insights page). Every to-do, quote, list item, toggle, callout and
// paragraph becomes one insight row (status "new", so the worker enriches it
// and proposes its proper home). Attribution lines ("— author") are
// skipped; dedup happens in insights.addBatchTexts.
export const importInsightsFromNotion = action({
  args: { pageId: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ found: number; imported: number; skipped: number }> => {
    await requireOwner(ctx, args.serviceKey);
    const token = process.env.NOTION_TOKEN;
    if (!token) throw new Error("NOTION_TOKEN not set");
    const rootId = bareId(args.pageId);
    const blocks = await fetchAllBlocks(token, rootId);
    const TYPES = new Set([
      "to_do",
      "quote",
      "bulleted_list_item",
      "numbered_list_item",
      "paragraph",
      "toggle",
      "callout",
    ]);
    const texts: string[] = [];
    for (const b of blocks) {
      if (!TYPES.has(b.type)) continue;
      const t = extractBlockText(b).trim();
      if (!t || t.startsWith("—")) continue;
      texts.push(t);
    }
    const r: { added: number; skipped: number } = await ctx.runMutation(api.insights.addBatchTexts, {
      texts,
      origin: "notion",
      serviceKey: process.env.OPENWORKS_SERVICE_KEY,
    });
    return { found: texts.length, imported: r.added, skipped: r.skipped };
  },
});

// Place an enriched insight into its chosen Notion page as a quote
// block (+ attribution paragraph). Mirrors approveAndExecute: build blocks from
// the stored markdown, anchor via contextBefore, append, mark the row placed.
export const placeInsight = action({
  args: { insightId: v.id("insights"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const insight = await ctx.runQuery(internal.insights.internalGetById, { id: args.insightId });
    if (!insight) throw new Error("Insight not found");
    if (!insight.notionPageId || !insight.notionContent) {
      throw new Error("Insight has no Notion target to place");
    }

    const token = process.env.NOTION_TOKEN;
    if (!token) throw new Error("NOTION_TOKEN not set");

    const cleanPageId = bareId(insight.notionPageId);
    const blocks = parseContentToBlocks(insight.notionContent);
    const afterBlockId = await findInsertionBlock(token, cleanPageId, insight.notionContextBefore);

    await notionFetch(token, `/blocks/${cleanPageId}/children`, "PATCH", {
      children: blocks,
      ...(afterBlockId ? { after: afterBlockId } : {}),
    });

    await ctx.runMutation(internal.insights.internalMarkPlaced, { id: args.insightId });
  },
});

export const searchPages = action({
  args: {
    query: v.string(),
    pageSize: v.optional(v.number()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const token = process.env.NOTION_TOKEN;
    if (!token) throw new Error("NOTION_TOKEN not set");

    const data = await notionFetch(token, "/search", "POST", {
      query: args.query,
      filter: { value: "page", property: "object" },
      page_size: args.pageSize ?? 5,
    });

    const results = data.results as Record<string, unknown>[];
    return results.map((page: Record<string, unknown>) => {
      let title = "Untitled";
      // Try properties.title
      const props = page.properties as Record<string, Record<string, unknown>> | undefined;
      if (props) {
        for (const key of Object.keys(props)) {
          const prop = props[key];
          if (prop.type === "title") {
            const titleArr = prop.title as { plain_text?: string }[] | undefined;
            if (titleArr) {
              title = titleArr.map((t) => t.plain_text ?? "").join("") || title;
            }
            break;
          }
        }
      }
      // Fallback: child_page.title
      if (title === "Untitled") {
        const cp = page.child_page as { title?: string } | undefined;
        if (cp?.title) title = cp.title;
      }
      // Fallback: extract from URL
      if (title === "Untitled" && page.url) {
        const urlStr = page.url as string;
        const match = urlStr.match(/notion\.so\/(.+)-[a-f0-9]{32}$/);
        if (match) title = decodeURIComponent(match[1].replace(/-/g, " "));
      }
      const id = page.id as string;
      const url = page.url as string;
      return { title, id, url };
    });
  },
});

export const fetchPageBlocks = action({
  args: {
    pageId: v.string(),
    pageSize: v.optional(v.number()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const token = process.env.NOTION_TOKEN;
    if (!token) throw new Error("NOTION_TOKEN not set");

    const cleanPageId = bareId(args.pageId);
    const blocks = await fetchAllBlocks(token, cleanPageId);
    return blocks.map((block) => {
      const type = block.type as string;
      const text = extractBlockText(block);
      const url = type === "bookmark" ? (((block[type] as Record<string, unknown>)?.url as string) ?? "") : "";
      return { id: block.id as string, type, text, url };
    });
  },
});

export const fetchPageAsMarkdown = action({
  args: {
    pageId: v.string(),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const token = process.env.NOTION_TOKEN;
    if (!token) throw new Error("NOTION_TOKEN not set");

    const cleanPageId = bareId(args.pageId);
    const blocks = (await fetchAllBlocks(token, cleanPageId)) as Record<string, unknown>[];

    let markdown = "";
    for (const block of blocks) {
      const type = block.type as string;
      const content = block[type] as Record<string, unknown> | undefined;

      if (!content) {
        if (type === "divider") {
          markdown += "---\n\n";
        } else if (type === "child_database") {
          markdown += "[Database]\n\n";
        } else if (type === "breadcrumb") {
          markdown += "[Breadcrumb]\n\n";
        }
        continue;
      }

      if (type === "heading_1" && content.rich_text) {
        const text = (content.rich_text as { plain_text?: string }[]).map((t) => t.plain_text ?? "").join("");
        markdown += "# " + text + "\n\n";
      } else if (type === "heading_2" && content.rich_text) {
        const text = (content.rich_text as { plain_text?: string }[]).map((t) => t.plain_text ?? "").join("");
        markdown += "## " + text + "\n\n";
      } else if (type === "heading_3" && content.rich_text) {
        const text = (content.rich_text as { plain_text?: string }[]).map((t) => t.plain_text ?? "").join("");
        markdown += "### " + text + "\n\n";
      } else if (type === "paragraph") {
        if (content.rich_text) {
          const text = (content.rich_text as { plain_text?: string; href?: string | null }[])
            .map((t) => {
              let result = t.plain_text ?? "";
              if (t.href) {
                result = `[${result}](${t.href})`;
              }
              return result;
            })
            .join("");
          if (text.trim()) {
            markdown += text + "\n\n";
          }
        }
      } else if (type === "bookmark" && content.url) {
        markdown += `[Link](${content.url as string})\n\n`;
      } else if (type === "bulleted_list_item" && content.rich_text) {
        const text = (content.rich_text as { plain_text?: string }[]).map((t) => t.plain_text ?? "").join("");
        markdown += "- " + text + "\n";
      } else if (type === "numbered_list_item" && content.rich_text) {
        const text = (content.rich_text as { plain_text?: string }[]).map((t) => t.plain_text ?? "").join("");
        markdown += "1. " + text + "\n";
      }
    }

    return markdown;
  },
});

export const markExecuted = internalMutation({
  args: { suggestionId: v.id("suggestions") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.suggestionId, { status: "executed" });
  },
});

export const getDatabaseDetails = action({
  args: { dbIds: v.array(v.string()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const token = process.env.NOTION_TOKEN;
    if (!token) throw new Error("NOTION_TOKEN not set");
    const results = [];
    for (const dbId of args.dbIds) {
      const cleanId = bareId(dbId);
      try {
        const db = await notionFetch(token, `/databases/${cleanId}`);
        results.push({ id: dbId, title: db.title?.[0]?.plain_text || "Untitled" });
      } catch (e: any) {
        results.push({ id: dbId, error: e.message });
      }
    }
    return results;
  },
});

export const queryDatabasePages = action({
  args: { dbIds: v.array(v.string()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const token = process.env.NOTION_TOKEN;
    if (!token) throw new Error("NOTION_TOKEN not set");
    const results = [];
    for (const dbId of args.dbIds) {
      const cleanId = bareId(dbId);
      try {
        const db = await notionFetch(token, `/databases/${cleanId}`);
        const props = db.properties ?? {};
        const titleProp = Object.keys(props).find((k) => props[k].type === "title") ?? "Name";
        const queryRes = await notionFetch(token, `/databases/${cleanId}/query`, "POST", { page_size: 100 });
        const pages = (queryRes.results || []).map((page: any) => {
          const rich = page.properties?.[titleProp]?.title ?? [];
          const title = rich
            .map((x: any) => x.plain_text ?? "")
            .join("")
            .trim();
          return { id: page.id, title, url: page.url };
        });
        results.push({ databaseId: dbId, title: db.title?.[0]?.plain_text || "Untitled", pages });
      } catch (e: any) {
        results.push({ databaseId: dbId, error: e.message });
      }
    }
    return results;
  },
});

export const getPageParent = action({
  args: {
    pageId: v.string(),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const token = process.env.NOTION_TOKEN;
    if (!token) throw new Error("NOTION_TOKEN not set");
    const cleanId = bareId(args.pageId);
    try {
      const res = await notionFetch(token, `/pages/${cleanId}`);
      return { id: res.id, type: "page", parent: res.parent, properties: res.properties };
    } catch (e: any) {
      const res = await notionFetch(token, `/databases/${cleanId}`);
      return { id: res.id, type: "database", parent: res.parent, title: res.title };
    }
  },
});
