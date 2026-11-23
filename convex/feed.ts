import { v } from "convex/values";
import { asUiLanguage, feedCard, type CardBlock } from "@openworks/domain";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { requireOwner } from "./auth";

// One page of the Feed: a summarized item that still waits on the owner, or an
// insight whose Notion placement does. `open` is where the full item lives; the
// feed carries only enough to read it on one screen.
export type FeedItem = {
  key: string;
  kind: "job" | "insight";
  island: string;
  at: number;
  title: string;
  subtitle?: string;
  lines?: string[];
  open?: { tab: string; item?: string };
  jobId?: Id<"jobs">;
  insightId?: Id<"insights">;
  inputSource?: { emailId?: string; url: string };
  // Notion edits still pending on the item.
  notion?: number;
  place?: { pageName: string; content: string; contextBefore?: string; contextAfter?: string };
  card?: CardBlock[];
};

const KINDS: Record<string, { label: string; island: string }> = {
  paper: { label: "Paper", island: "research" },
  article: { label: "Article", island: "productivity" },
  newsletter: { label: "Newsletter", island: "productivity" },
};

const firstLine = (text: string) =>
  text
    .split("\n")
    .find((l) => l.trim())
    ?.trim()
    .slice(0, 160) ?? "";

export const list = query({
  args: {
    today: v.optional(v.string()),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
    mix: v.optional(v.boolean()),
    island: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const limit = Math.max(1, Math.min(args.limit ?? 12, 40));
    // The cursor is the creation time the previous page ended on.
    const before = args.cursor ? Number(args.cursor) : Number.MAX_SAFE_INTEGER;
    const settings = await ctx.db.query("appSettings").first();
    const lang = asUiLanguage(settings?.uiLanguage);
    const want = (island: string) => !args.island || args.island === island;

    // Archived and unsummarized rows are skipped after the read, so more are read than shown.
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", before))
      .order("desc")
      .take(limit * 4);
    const insights = await ctx.db
      .query("insights")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "suggested").lt("createdAt", before))
      .order("desc")
      .take(limit);

    const items: FeedItem[] = [];
    for (const j of jobs) {
      const kind = j.type ? KINDS[j.type] : undefined;
      if (!kind || j.archived || !j.tldr?.length || !want(kind.island)) continue;
      items.push(await jobRow(ctx, j, kind));
    }
    for (const r of insights) {
      if (!want("productivity")) break;
      items.push({
        key: `insight:${r._id}`,
        kind: "insight",
        island: "productivity",
        at: r.createdAt,
        title: firstLine(r.text) || "[image]",
        subtitle: r.source ?? "Insight",
        lines: [r.text, r.interpretation].filter((x): x is string => Boolean(x)),
        open: { tab: "insights" },
        insightId: r._id,
        ...(r.notionPageId && r.notionContent
          ? {
              place: {
                pageName: r.notionPageName ?? "Notion",
                content: r.notionContent,
                contextBefore: r.notionContextBefore,
                contextAfter: r.notionContextAfter,
              },
            }
          : {}),
      });
    }

    items.sort((a, b) => b.at - a.at);
    const page = items.slice(0, limit);
    const more = items.length > limit || jobs.length === limit * 4;
    return {
      upcoming: [] as FeedItem[],
      items: page.map((item) => {
        const card = feedCard(item, lang);
        return card ? { ...item, card } : item;
      }),
      shorts: [] as FeedItem[],
      more,
      cursor: more && page.length ? String(page[page.length - 1].at) : null,
    };
  },
});

async function jobRow(ctx: QueryCtx, j: Doc<"jobs">, kind: { label: string; island: string }): Promise<FeedItem> {
  const edits = await ctx.db
    .query("suggestions")
    .withIndex("by_jobId", (q) => q.eq("jobId", j._id))
    .collect();
  return {
    key: `job:${j._id}`,
    kind: "job",
    island: kind.island,
    at: j.createdAt,
    title: j.title || j.url,
    subtitle: kind.label,
    lines: j.tldr?.slice(0, 3),
    open: { tab: j.type!, item: j._id },
    jobId: j._id,
    inputSource: { emailId: j.emailId, url: j.url },
    notion: edits.filter((s) => s.status === "pending").length,
  };
}
