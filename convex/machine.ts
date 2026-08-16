import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";

export const get = query({
  args: { machineId: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("machineConfig")
      .withIndex("by_machine", (q) => q.eq("machineId", args.machineId))
      .first();
  },
});

export const upsert = mutation({
  args: {
    machineId: v.string(),
    projectRoots: v.array(v.object({ slug: v.string(), path: v.string() })),
    prRoot: v.optional(v.string()),
    reviewRoot: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const { serviceKey: _serviceKey, ...config } = args;
    const existing = await ctx.db
      .query("machineConfig")
      .withIndex("by_machine", (q) => q.eq("machineId", config.machineId))
      .first();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { ...config, updatedAt: now });
      return existing._id;
    }
    return await ctx.db.insert("machineConfig", { ...config, updatedAt: now });
  },
});
