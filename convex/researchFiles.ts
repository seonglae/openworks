import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";

export const listByResearch = query({
  args: { researchSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("researchFiles")
      .withIndex("by_research", (q) => q.eq("researchSlug", args.researchSlug))
      .collect();
  },
});

const fileObj = v.object({
  relPath: v.string(),
  fileType: v.union(
    v.literal("code"),
    v.literal("doc"),
    v.literal("paper"),
    v.literal("config"),
    v.literal("data"),
    v.literal("other"),
  ),
  language: v.optional(v.string()),
  size: v.number(),
  excerpt: v.string(),
  hash: v.string(),
});

export const clearResearch = mutation({
  args: { researchSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db
      .query("researchFiles")
      .withIndex("by_research", (q) => q.eq("researchSlug", args.researchSlug))
      .collect();
    for (const f of existing) await ctx.db.delete(f._id);
  },
});

export const insertBatch = mutation({
  args: { researchSlug: v.string(), files: v.array(fileObj), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const now = Date.now();
    for (const f of args.files) {
      await ctx.db.insert("researchFiles", { researchSlug: args.researchSlug, ...f, syncedAt: now });
    }
  },
});

export const finalizeSync = mutation({
  args: { researchSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const proj = await ctx.db
      .query("researchProjects")
      .withIndex("by_slug", (q) => q.eq("slug", args.researchSlug))
      .first();
    if (proj) await ctx.db.patch(proj._id, { lastSyncedAt: Date.now() });
  },
});

export const summary = query({
  args: { researchSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const files = await ctx.db
      .query("researchFiles")
      .withIndex("by_research", (q) => q.eq("researchSlug", args.researchSlug))
      .collect();
    const byType: Record<string, number> = {};
    for (const f of files) byType[f.fileType] = (byType[f.fileType] ?? 0) + 1;
    return { total: files.length, byType };
  },
});
