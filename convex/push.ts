import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireOwner } from "./auth";

// The VAPID public key the browser needs to create a push subscription. Safe to
// expose (it is the public half); gated only because the whole app is single-owner.
export const vapidPublicKey = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return process.env.VAPID_PUBLIC_KEY ?? null;
  },
});

// Store (or refresh) a browser's push subscription. Keyed by endpoint so the
// same install re-subscribing just updates its keys instead of duplicating.
export const subscribe = mutation({
  args: {
    endpoint: v.string(),
    keys: v.object({ p256dh: v.string(), auth: v.string() }),
    label: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { keys: args.keys, label: args.label, userId });
      return existing._id;
    }
    return await ctx.db.insert("pushSubscriptions", {
      endpoint: args.endpoint,
      keys: args.keys,
      label: args.label,
      userId,
      createdAt: Date.now(),
    });
  },
});

export const unsubscribe = mutation({
  args: { endpoint: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});

// Whether the current install (by endpoint) is subscribed, plus the total count.
export const status = query({
  args: { endpoint: v.optional(v.string()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const all = await ctx.db.query("pushSubscriptions").collect();
    const subscribed = args.endpoint ? all.some((s) => s.endpoint === args.endpoint) : false;
    return { subscribed, total: all.length };
  },
});

// Owner-triggered test push (used by the Settings "send test" button).
export const sendTest = action({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ sent: number; failed: number }> => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.runAction(internal.pushNode.broadcast, {
      title: "Openworks",
      body: "Notifications are on — recommended reads will land here.",
      url: "/",
    });
  },
});

// --- internal plumbing used by the node sender ---

export const listSubscriptions = internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query("pushSubscriptions").collect(),
});

// Drop a subscription that the push service reported as gone (404/410).
export const removeByEndpoint = internalMutation({
  args: { endpoint: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});
