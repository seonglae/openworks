import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";

export const listByResearch = query({
  args: { researchSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const papers = await ctx.db
      .query("researchPapers")
      .withIndex("by_research", (q) => q.eq("researchSlug", args.researchSlug))
      .collect();
    return papers.sort((a, b) => b.addedAt - a.addedAt);
  },
});

const paperObj = v.object({
  arxivId: v.optional(v.string()),
  title: v.string(),
  authors: v.array(v.string()),
  abstract: v.optional(v.string()),
  url: v.string(),
  source: v.union(v.literal("arxiv"), v.literal("openreview"), v.literal("manual")),
});

export const replaceForResearch = mutation({
  args: { researchSlug: v.string(), papers: v.array(paperObj), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db
      .query("researchPapers")
      .withIndex("by_research", (q) => q.eq("researchSlug", args.researchSlug))
      .collect();
    for (const p of existing) await ctx.db.delete(p._id);
    const now = Date.now();
    for (const p of args.papers) {
      await ctx.db.insert("researchPapers", { researchSlug: args.researchSlug, ...p, addedAt: now });
    }
  },
});

export const addOne = mutation({
  args: { researchSlug: v.string(), paper: paperObj, serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    // Dedup by arxivId
    if (args.paper.arxivId) {
      const existing = await ctx.db
        .query("researchPapers")
        .withIndex("by_arxivId", (q) => q.eq("arxivId", args.paper.arxivId))
        .collect();
      const dup = existing.find((p) => p.researchSlug === args.researchSlug);
      if (dup) return dup._id;
    }
    return await ctx.db.insert("researchPapers", {
      researchSlug: args.researchSlug,
      ...args.paper,
      addedAt: Date.now(),
    });
  },
});
