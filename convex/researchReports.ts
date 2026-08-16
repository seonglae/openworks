import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";

// A day's standup for one project, written by the agent that worked on it.
// Upsert on (project, day, author), matching every other research write: an
// agent that reports twice in a day is correcting itself, not filing twice.
export const save = mutation({
  args: {
    researchSlug: v.string(),
    day: v.string(),
    author: v.string(),
    body: v.string(),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db
      .query("researchReports")
      .withIndex("by_research_day_author", (q) =>
        q.eq("researchSlug", args.researchSlug).eq("day", args.day).eq("author", args.author),
      )
      .first();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { body: args.body, updatedAt: now });
      return { id: existing._id, created: false };
    }
    const id = await ctx.db.insert("researchReports", {
      researchSlug: args.researchSlug,
      day: args.day,
      author: args.author,
      body: args.body,
      createdAt: now,
      updatedAt: now,
    });
    return { id, created: true };
  },
});

export const listByResearch = query({
  args: { researchSlug: v.string(), limit: v.optional(v.number()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const rows = await ctx.db
      .query("researchReports")
      .withIndex("by_research_day", (q) => q.eq("researchSlug", args.researchSlug))
      .order("desc")
      .take(args.limit ?? 30);
    return rows;
  },
});

// The window the weekly mail asks for. `day` is a sortable string, so the
// range is an index scan rather than a table read filtered afterwards.
export const listRange = query({
  args: {
    since: v.string(),
    until: v.string(),
    limit: v.optional(v.number()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("researchReports")
      .withIndex("by_day", (q) => q.gte("day", args.since).lte("day", args.until))
      .take(args.limit ?? 200);
  },
});

export const remove = mutation({
  args: { id: v.id("researchReports"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.delete(args.id);
    return { ok: true };
  },
});
