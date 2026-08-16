import { v } from "convex/values";
import { ENTITY_TYPES } from "@openworks/domain";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";
import { literals } from "./validators";

const ENTITY_TYPE = literals(ENTITY_TYPES);

// Match by full identity tuple — venueSlug only meaningful for section/tex.
function sameEdge(
  a: { fromType: string; fromKey: string; fromVenueSlug?: string; toType: string; toKey: string; toVenueSlug?: string },
  b: { fromType: string; fromKey: string; fromVenueSlug?: string; toType: string; toKey: string; toVenueSlug?: string },
) {
  return (
    a.fromType === b.fromType &&
    a.fromKey === b.fromKey &&
    a.fromVenueSlug === b.fromVenueSlug &&
    a.toType === b.toType &&
    a.toKey === b.toKey &&
    a.toVenueSlug === b.toVenueSlug
  );
}

// Add or update a reference (upsert by full identity tuple).
// context can be updated by re-calling with the same edge.
export const add = mutation({
  args: {
    researchSlug: v.string(),
    fromType: ENTITY_TYPE,
    fromKey: v.string(),
    fromVenueSlug: v.optional(v.string()),
    toType: ENTITY_TYPE,
    toKey: v.string(),
    toVenueSlug: v.optional(v.string()),
    context: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const candidates = await ctx.db
      .query("researchRefs")
      .withIndex("by_from", (q) =>
        q.eq("researchSlug", args.researchSlug).eq("fromType", args.fromType).eq("fromKey", args.fromKey),
      )
      .collect();
    const existing = candidates.find((r) => sameEdge(r, args));
    if (existing) {
      if (args.context !== undefined && args.context !== existing.context) {
        await ctx.db.patch(existing._id, { context: args.context });
      }
      return { id: existing._id, created: false };
    }
    const id = await ctx.db.insert("researchRefs", {
      researchSlug: args.researchSlug,
      fromType: args.fromType,
      fromKey: args.fromKey,
      fromVenueSlug: args.fromVenueSlug,
      toType: args.toType,
      toKey: args.toKey,
      toVenueSlug: args.toVenueSlug,
      context: args.context,
      createdAt: Date.now(),
    });
    return { id, created: true };
  },
});

// Outgoing edges from a given entity.
export const listOutgoing = query({
  args: {
    researchSlug: v.string(),
    fromType: ENTITY_TYPE,
    fromKey: v.string(),
    fromVenueSlug: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const all = await ctx.db
      .query("researchRefs")
      .withIndex("by_from", (q) =>
        q.eq("researchSlug", args.researchSlug).eq("fromType", args.fromType).eq("fromKey", args.fromKey),
      )
      .collect();
    return all.filter((r) => r.fromVenueSlug === args.fromVenueSlug);
  },
});

// Incoming edges (backlinks) targeting a given entity.
export const listIncoming = query({
  args: {
    researchSlug: v.string(),
    toType: ENTITY_TYPE,
    toKey: v.string(),
    toVenueSlug: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const all = await ctx.db
      .query("researchRefs")
      .withIndex("by_to", (q) =>
        q.eq("researchSlug", args.researchSlug).eq("toType", args.toType).eq("toKey", args.toKey),
      )
      .collect();
    return all.filter((r) => r.toVenueSlug === args.toVenueSlug);
  },
});

export const remove = mutation({
  args: {
    researchSlug: v.string(),
    fromType: ENTITY_TYPE,
    fromKey: v.string(),
    fromVenueSlug: v.optional(v.string()),
    toType: ENTITY_TYPE,
    toKey: v.string(),
    toVenueSlug: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const candidates = await ctx.db
      .query("researchRefs")
      .withIndex("by_from", (q) =>
        q.eq("researchSlug", args.researchSlug).eq("fromType", args.fromType).eq("fromKey", args.fromKey),
      )
      .collect();
    const existing = candidates.find((r) => sameEdge(r, args));
    if (!existing) return { removed: false };
    await ctx.db.delete(existing._id);
    return { removed: true };
  },
});

// All references for a project (debugging / graph view).
export const listAll = query({
  args: { researchSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("researchRefs")
      .withIndex("by_research", (q) => q.eq("researchSlug", args.researchSlug))
      .collect();
  },
});
