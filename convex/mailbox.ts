import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";

// Frontend asks for an inbox listing; worker.mjs picks this up via gws.
export const requestList = mutation({
  args: { query: v.optional(v.string()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const id = await ctx.db.insert("mailboxRequests", {
      kind: "list",
      status: "pending",
      query: args.query,
      createdAt: Date.now(),
    });
    return { id };
  },
});

// Frontend asks the worker to mark a single email read via gws batchModify.
export const requestMarkRead = mutation({
  args: { emailId: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const id = await ctx.db.insert("mailboxRequests", {
      kind: "markRead",
      status: "pending",
      emailId: args.emailId,
      createdAt: Date.now(),
    });
    return { id };
  },
});

// Worker polls pending requests.
export const getPendingRequest = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("mailboxRequests")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "pending"))
      .order("asc")
      .first();
  },
});

export const claimRequest = mutation({
  args: { id: v.id("mailboxRequests"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const req = await ctx.db.get(args.id);
    if (!req || req.status !== "pending") return null;
    // Worker has just picked this up — keep it visibly in-flight so the UI
    // doesn't flash "no unread newsletters" between claim and completion.
    await ctx.db.patch(args.id, { status: "running" });
    return req;
  },
});

export const completeRequest = mutation({
  args: {
    id: v.id("mailboxRequests"),
    status: v.union(v.literal("done"), v.literal("error")),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.id, {
      status: args.status,
      result: args.result,
      error: args.error,
      completedAt: Date.now(),
    });
  },
});

// Frontend polls a specific request it just created — avoids the stale-
// previous-result flash when reopening the modal.
export const getRequest = query({
  args: { id: v.id("mailboxRequests"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db.get(args.id);
  },
});

// Frontend reads the most recent completed `list` result.
export const latestList = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const items = await ctx.db
      .query("mailboxRequests")
      .withIndex("by_kind_createdAt", (q) => q.eq("kind", "list"))
      .order("desc")
      .take(10);
    return items.find((r) => r.status === "done" || r.status === "error") ?? items[0] ?? null;
  },
});
