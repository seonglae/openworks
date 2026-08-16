import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";

const STATUS = v.union(
  v.literal("drafting"),
  v.literal("submitted"),
  v.literal("accepted"),
  v.literal("rejected"),
  v.literal("withdrawn"),
);

export const save = mutation({
  args: {
    researchSlug: v.string(),
    venueSlug: v.string(),
    name: v.optional(v.string()),
    pageLimit: v.optional(v.number()),
    template: v.optional(v.string()),
    deadline: v.optional(v.string()),
    status: v.optional(STATUS),
    notes: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db
      .query("researchVenues")
      .withIndex("by_research_venue", (q) => q.eq("researchSlug", args.researchSlug).eq("venueSlug", args.venueSlug))
      .first();
    const now = Date.now();
    if (existing) {
      const { researchSlug: _r, venueSlug: _s, serviceKey: _k, ...patch } = args;
      const filtered = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      await ctx.db.patch(existing._id, { ...filtered, updatedAt: now });
      return { id: existing._id, venueSlug: existing.venueSlug, created: false };
    }
    const id = await ctx.db.insert("researchVenues", {
      researchSlug: args.researchSlug,
      venueSlug: args.venueSlug,
      name: args.name ?? args.venueSlug,
      pageLimit: args.pageLimit,
      template: args.template,
      deadline: args.deadline,
      status: args.status ?? "drafting",
      notes: args.notes,
      createdAt: now,
      updatedAt: now,
    });
    return { id, venueSlug: args.venueSlug, created: true };
  },
});

export const get = query({
  args: { researchSlug: v.string(), venueSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("researchVenues")
      .withIndex("by_research_venue", (q) => q.eq("researchSlug", args.researchSlug).eq("venueSlug", args.venueSlug))
      .first();
  },
});

export const list = query({
  args: { researchSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const all = await ctx.db
      .query("researchVenues")
      .withIndex("by_research", (q) => q.eq("researchSlug", args.researchSlug))
      .collect();
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const remove = mutation({
  args: { researchSlug: v.string(), venueSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db
      .query("researchVenues")
      .withIndex("by_research_venue", (q) => q.eq("researchSlug", args.researchSlug).eq("venueSlug", args.venueSlug))
      .first();
    if (!existing) return { removed: false };
    await ctx.db.delete(existing._id);
    return { removed: true };
  },
});
