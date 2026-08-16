import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";

// venueSlug undefined = standalone/canonical tex source; otherwise scoped to a venue.
export const save = mutation({
  args: {
    researchSlug: v.string(),
    texPath: v.string(),
    venueSlug: v.optional(v.string()),
    content: v.optional(v.string()),
    notes: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db
      .query("researchTex")
      .withIndex("by_research_venue_path", (q) =>
        q.eq("researchSlug", args.researchSlug).eq("venueSlug", args.venueSlug).eq("texPath", args.texPath),
      )
      .first();
    const now = Date.now();
    if (existing) {
      const { researchSlug: _r, texPath: _p, venueSlug: _v, serviceKey: _k, ...patch } = args;
      const filtered = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      await ctx.db.patch(existing._id, { ...filtered, updatedAt: now });
      return { id: existing._id, texPath: existing.texPath, created: false };
    }
    const id = await ctx.db.insert("researchTex", {
      researchSlug: args.researchSlug,
      texPath: args.texPath,
      venueSlug: args.venueSlug,
      content: args.content ?? "",
      notes: args.notes,
      createdAt: now,
      updatedAt: now,
    });
    return { id, texPath: args.texPath, created: true };
  },
});

export const get = query({
  args: {
    researchSlug: v.string(),
    texPath: v.string(),
    venueSlug: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("researchTex")
      .withIndex("by_research_venue_path", (q) =>
        q.eq("researchSlug", args.researchSlug).eq("venueSlug", args.venueSlug).eq("texPath", args.texPath),
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
        .query("researchTex")
        .withIndex("by_research", (q) => q.eq("researchSlug", args.researchSlug))
        .collect();
      return all.sort((a, b) => a.texPath.localeCompare(b.texPath));
    }
    const items = await ctx.db
      .query("researchTex")
      .withIndex("by_research_venue", (q) => q.eq("researchSlug", args.researchSlug).eq("venueSlug", args.venueSlug))
      .collect();
    return items.sort((a, b) => a.texPath.localeCompare(b.texPath));
  },
});

export const fork = mutation({
  args: {
    researchSlug: v.string(),
    texPath: v.string(),
    fromVenueSlug: v.optional(v.string()),
    toVenueSlug: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const source = await ctx.db
      .query("researchTex")
      .withIndex("by_research_venue_path", (q) =>
        q.eq("researchSlug", args.researchSlug).eq("venueSlug", args.fromVenueSlug).eq("texPath", args.texPath),
      )
      .first();
    if (!source) throw new Error(`source tex not found: ${args.texPath}`);
    const now = Date.now();
    const existing = await ctx.db
      .query("researchTex")
      .withIndex("by_research_venue_path", (q) =>
        q.eq("researchSlug", args.researchSlug).eq("venueSlug", args.toVenueSlug).eq("texPath", args.texPath),
      )
      .first();
    const payload = {
      researchSlug: source.researchSlug,
      texPath: source.texPath,
      venueSlug: args.toVenueSlug,
      content: source.content,
      notes: source.notes,
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return { id: existing._id, forked: false };
    }
    const id = await ctx.db.insert("researchTex", { ...payload, createdAt: now });
    return { id, forked: true };
  },
});

export const remove = mutation({
  args: {
    researchSlug: v.string(),
    texPath: v.string(),
    venueSlug: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db
      .query("researchTex")
      .withIndex("by_research_venue_path", (q) =>
        q.eq("researchSlug", args.researchSlug).eq("venueSlug", args.venueSlug).eq("texPath", args.texPath),
      )
      .first();
    if (!existing) return { removed: false };
    await ctx.db.delete(existing._id);
    return { removed: true };
  },
});
