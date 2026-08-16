import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";

export const save = mutation({
  args: {
    researchSlug: v.string(),
    tableSlug: v.string(),
    caption: v.optional(v.string()),
    csv: v.optional(v.string()),
    markdown: v.optional(v.string()),
    latex: v.optional(v.string()),
    expSlug: v.optional(v.string()),
    notes: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db
      .query("researchTables")
      .withIndex("by_research_slug", (q) => q.eq("researchSlug", args.researchSlug).eq("tableSlug", args.tableSlug))
      .first();
    const now = Date.now();
    if (existing) {
      const { researchSlug: _r, tableSlug: _s, serviceKey: _k, ...patch } = args;
      const filtered = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      await ctx.db.patch(existing._id, { ...filtered, updatedAt: now });
      return { id: existing._id, tableSlug: existing.tableSlug, created: false };
    }
    const id = await ctx.db.insert("researchTables", {
      researchSlug: args.researchSlug,
      tableSlug: args.tableSlug,
      caption: args.caption ?? args.tableSlug,
      csv: args.csv,
      markdown: args.markdown,
      latex: args.latex,
      expSlug: args.expSlug,
      notes: args.notes,
      createdAt: now,
      updatedAt: now,
    });
    return { id, tableSlug: args.tableSlug, created: true };
  },
});

export const get = query({
  args: { researchSlug: v.string(), tableSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("researchTables")
      .withIndex("by_research_slug", (q) => q.eq("researchSlug", args.researchSlug).eq("tableSlug", args.tableSlug))
      .first();
  },
});

export const list = query({
  args: { researchSlug: v.string(), expSlug: v.optional(v.string()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    if (args.expSlug !== undefined) {
      const items = await ctx.db
        .query("researchTables")
        .withIndex("by_research_exp", (q) => q.eq("researchSlug", args.researchSlug).eq("expSlug", args.expSlug))
        .collect();
      return items.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    const all = await ctx.db
      .query("researchTables")
      .withIndex("by_research", (q) => q.eq("researchSlug", args.researchSlug))
      .collect();
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const remove = mutation({
  args: { researchSlug: v.string(), tableSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db
      .query("researchTables")
      .withIndex("by_research_slug", (q) => q.eq("researchSlug", args.researchSlug).eq("tableSlug", args.tableSlug))
      .first();
    if (!existing) return { removed: false };
    await ctx.db.delete(existing._id);
    return { removed: true };
  },
});
