import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";

const FORMAT = v.union(v.literal("markdown"), v.literal("latex"));

// venueSlug undefined = standalone/canonical; otherwise scoped to a specific venue.
export const save = mutation({
  args: {
    researchSlug: v.string(),
    sectionSlug: v.string(),
    venueSlug: v.optional(v.string()),
    title: v.optional(v.string()),
    content: v.optional(v.string()),
    format: v.optional(FORMAT),
    order: v.optional(v.number()),
    notes: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db
      .query("researchSections")
      .withIndex("by_research_venue_section", (q) =>
        q.eq("researchSlug", args.researchSlug).eq("venueSlug", args.venueSlug).eq("sectionSlug", args.sectionSlug),
      )
      .first();
    const now = Date.now();
    if (existing) {
      const { researchSlug: _r, sectionSlug: _s, venueSlug: _v, serviceKey: _k, ...patch } = args;
      const filtered = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      await ctx.db.patch(existing._id, { ...filtered, updatedAt: now });
      return { id: existing._id, sectionSlug: existing.sectionSlug, created: false };
    }
    const id = await ctx.db.insert("researchSections", {
      researchSlug: args.researchSlug,
      sectionSlug: args.sectionSlug,
      venueSlug: args.venueSlug,
      title: args.title ?? args.sectionSlug,
      content: args.content ?? "",
      format: args.format ?? "markdown",
      order: args.order,
      notes: args.notes,
      createdAt: now,
      updatedAt: now,
    });
    return { id, sectionSlug: args.sectionSlug, created: true };
  },
});

export const get = query({
  args: {
    researchSlug: v.string(),
    sectionSlug: v.string(),
    venueSlug: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("researchSections")
      .withIndex("by_research_venue_section", (q) =>
        q.eq("researchSlug", args.researchSlug).eq("venueSlug", args.venueSlug).eq("sectionSlug", args.sectionSlug),
      )
      .first();
  },
});

export const list = query({
  args: {
    researchSlug: v.string(),
    venueSlug: v.optional(v.string()),
    includeAllVenues: v.optional(v.boolean()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    if (args.includeAllVenues) {
      const all = await ctx.db
        .query("researchSections")
        .withIndex("by_research", (q) => q.eq("researchSlug", args.researchSlug))
        .collect();
      return all.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }
    const items = await ctx.db
      .query("researchSections")
      .withIndex("by_research_venue", (q) => q.eq("researchSlug", args.researchSlug).eq("venueSlug", args.venueSlug))
      .collect();
    return items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  },
});

// Copy a standalone section into a venue (or copy across venues). Useful when
// adapting a canonical section for a specific venue.
export const fork = mutation({
  args: {
    researchSlug: v.string(),
    sectionSlug: v.string(),
    fromVenueSlug: v.optional(v.string()),
    toVenueSlug: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const source = await ctx.db
      .query("researchSections")
      .withIndex("by_research_venue_section", (q) =>
        q.eq("researchSlug", args.researchSlug).eq("venueSlug", args.fromVenueSlug).eq("sectionSlug", args.sectionSlug),
      )
      .first();
    if (!source) throw new Error(`source section not found: ${args.sectionSlug}`);
    const now = Date.now();
    const existing = await ctx.db
      .query("researchSections")
      .withIndex("by_research_venue_section", (q) =>
        q.eq("researchSlug", args.researchSlug).eq("venueSlug", args.toVenueSlug).eq("sectionSlug", args.sectionSlug),
      )
      .first();
    const payload = {
      researchSlug: source.researchSlug,
      sectionSlug: source.sectionSlug,
      venueSlug: args.toVenueSlug,
      title: source.title,
      content: source.content,
      format: source.format,
      order: source.order,
      notes: source.notes,
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return { id: existing._id, forked: false };
    }
    const id = await ctx.db.insert("researchSections", { ...payload, createdAt: now });
    return { id, forked: true };
  },
});

export const remove = mutation({
  args: {
    researchSlug: v.string(),
    sectionSlug: v.string(),
    venueSlug: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db
      .query("researchSections")
      .withIndex("by_research_venue_section", (q) =>
        q.eq("researchSlug", args.researchSlug).eq("venueSlug", args.venueSlug).eq("sectionSlug", args.sectionSlug),
      )
      .first();
    if (!existing) return { removed: false };
    await ctx.db.delete(existing._id);
    return { removed: true };
  },
});
