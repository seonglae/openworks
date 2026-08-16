import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";

export const save = mutation({
  args: {
    researchSlug: v.string(),
    figureSlug: v.string(),
    caption: v.optional(v.string()),
    path: v.optional(v.string()),
    url: v.optional(v.string()),
    format: v.optional(v.string()),
    expSlug: v.optional(v.string()),
    notes: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db
      .query("researchFigures")
      .withIndex("by_research_slug", (q) => q.eq("researchSlug", args.researchSlug).eq("figureSlug", args.figureSlug))
      .first();
    const now = Date.now();
    if (existing) {
      const { researchSlug: _r, figureSlug: _s, serviceKey: _k, ...patch } = args;
      const filtered = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      await ctx.db.patch(existing._id, { ...filtered, updatedAt: now });
      return { id: existing._id, figureSlug: existing.figureSlug, created: false };
    }
    const id = await ctx.db.insert("researchFigures", {
      researchSlug: args.researchSlug,
      figureSlug: args.figureSlug,
      caption: args.caption ?? args.figureSlug,
      path: args.path,
      url: args.url,
      format: args.format,
      expSlug: args.expSlug,
      notes: args.notes,
      createdAt: now,
      updatedAt: now,
    });
    return { id, figureSlug: args.figureSlug, created: true };
  },
});

export const get = query({
  args: { researchSlug: v.string(), figureSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("researchFigures")
      .withIndex("by_research_slug", (q) => q.eq("researchSlug", args.researchSlug).eq("figureSlug", args.figureSlug))
      .first();
  },
});

export const list = query({
  args: { researchSlug: v.string(), expSlug: v.optional(v.string()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    if (args.expSlug !== undefined) {
      const items = await ctx.db
        .query("researchFigures")
        .withIndex("by_research_exp", (q) => q.eq("researchSlug", args.researchSlug).eq("expSlug", args.expSlug))
        .collect();
      return items.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    const all = await ctx.db
      .query("researchFigures")
      .withIndex("by_research", (q) => q.eq("researchSlug", args.researchSlug))
      .collect();
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const remove = mutation({
  args: { researchSlug: v.string(), figureSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db
      .query("researchFigures")
      .withIndex("by_research_slug", (q) => q.eq("researchSlug", args.researchSlug).eq("figureSlug", args.figureSlug))
      .first();
    if (!existing) return { removed: false };
    await ctx.db.delete(existing._id);
    return { removed: true };
  },
});
