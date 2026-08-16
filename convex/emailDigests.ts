import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";

export const addBatch = mutation({
  args: {
    digests: v.array(
      v.object({
        emailId: v.string(),
        threadId: v.string(),
        from: v.string(),
        subject: v.string(),
        snippet: v.string(),
        labels: v.array(v.string()),
        scores: v.object({
          surprise: v.number(),
          urgency: v.number(),
          positivity: v.number(),
          relevance: v.number(),
        }),
        category: v.string(),
        oneLiner: v.string(),
        digestDate: v.string(),
      }),
    ),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const now = Date.now();
    for (const d of args.digests) {
      const existing = await ctx.db
        .query("emailDigests")
        .withIndex("by_emailId", (q) => q.eq("emailId", d.emailId))
        .first();
      if (!existing) {
        await ctx.db.insert("emailDigests", { ...d, createdAt: now });
      }
    }
  },
});

export const listByDate = query({
  args: { digestDate: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return ctx.db
      .query("emailDigests")
      .withIndex("by_digestDate", (q) => q.eq("digestDate", args.digestDate))
      .collect();
  },
});

export const listRecent = query({
  args: { limit: v.optional(v.number()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return ctx.db
      .query("emailDigests")
      .order("desc")
      .take(args.limit ?? 50);
  },
});
