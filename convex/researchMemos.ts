import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";

export const save = mutation({
  args: {
    researchSlug: v.string(),
    memoSlug: v.string(),
    title: v.optional(v.string()),
    content: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    notes: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db
      .query("researchMemos")
      .withIndex("by_research_slug", (q) => q.eq("researchSlug", args.researchSlug).eq("memoSlug", args.memoSlug))
      .first();
    const now = Date.now();
    if (existing) {
      const { researchSlug: _r, memoSlug: _s, serviceKey: _k, ...patch } = args;
      const filtered = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      await ctx.db.patch(existing._id, { ...filtered, updatedAt: now });
      return { id: existing._id, memoSlug: existing.memoSlug, created: false };
    }
    const id = await ctx.db.insert("researchMemos", {
      researchSlug: args.researchSlug,
      memoSlug: args.memoSlug,
      title: args.title ?? args.memoSlug,
      content: args.content ?? "",
      tags: args.tags,
      notes: args.notes,
      createdAt: now,
      updatedAt: now,
    });
    return { id, memoSlug: args.memoSlug, created: true };
  },
});

export const get = query({
  args: { researchSlug: v.string(), memoSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("researchMemos")
      .withIndex("by_research_slug", (q) => q.eq("researchSlug", args.researchSlug).eq("memoSlug", args.memoSlug))
      .first();
  },
});

export const list = query({
  args: { researchSlug: v.string(), tag: v.optional(v.string()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const all = await ctx.db
      .query("researchMemos")
      .withIndex("by_research", (q) => q.eq("researchSlug", args.researchSlug))
      .collect();
    const filtered = args.tag ? all.filter((m) => (m.tags ?? []).includes(args.tag!)) : all;
    return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const remove = mutation({
  args: { researchSlug: v.string(), memoSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db
      .query("researchMemos")
      .withIndex("by_research_slug", (q) => q.eq("researchSlug", args.researchSlug).eq("memoSlug", args.memoSlug))
      .first();
    if (!existing) return { removed: false };
    await ctx.db.delete(existing._id);
    return { removed: true };
  },
});
