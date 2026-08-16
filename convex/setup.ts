// Setup request queue. UI inserts pending rows for installs / verifies;
// worker.mts claims, shell-execs, completes. Mirrors the mailboxRequests
// pattern. No auth — self-hosted OSS, one deployment = one user.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";
import { defaultTabs } from "./settings";

const KIND = v.union(
  v.literal("install_gh"),
  v.literal("verify_gh"),
  v.literal("oauth_gh"),
  v.literal("install_gws"),
  v.literal("verify_gws"),
);

export const request = mutation({
  args: { kind: KIND, params: v.optional(v.string()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const now = Date.now();
    const id = await ctx.db.insert("setupRequests", {
      kind: args.kind,
      params: args.params,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    return { id };
  },
});

// Worker calls this to atomically claim the next pending request of any
// kind. Returns null if queue empty.
export const claim = mutation({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const next = await ctx.db
      .query("setupRequests")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .first();
    if (!next) return null;
    await ctx.db.patch(next._id, { status: "running", updatedAt: Date.now() });
    return next;
  },
});

// Worker writes intermediate progress for long-running flows (OAuth device
// code, polling state). Status stays "running" — only `complete` flips to
// done/error.
export const setProgress = mutation({
  args: {
    id: v.id("setupRequests"),
    result: v.optional(v.string()),
    stdout: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const row = await ctx.db.get(args.id);
    if (!row) return;
    await ctx.db.patch(args.id, {
      ...(args.result !== undefined ? { result: args.result } : {}),
      ...(args.stdout !== undefined ? { stdout: args.stdout } : {}),
      updatedAt: Date.now(),
    });
  },
});

export const complete = mutation({
  args: {
    id: v.id("setupRequests"),
    status: v.union(v.literal("done"), v.literal("error")),
    result: v.optional(v.string()),
    stdout: v.optional(v.string()),
    error: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const row = await ctx.db.get(args.id);
    if (!row) return;
    await ctx.db.patch(args.id, {
      status: args.status,
      result: args.result,
      stdout: args.stdout,
      error: args.error,
      updatedAt: Date.now(),
    });
    // On successful verify, mirror status into appSettings so the UI can
    // render badges without polling setupRequests per tab.
    if (args.status === "done") {
      const settings = await ctx.db
        .query("appSettings")
        .withIndex("by_slug", (q) => q.eq("slug", "default"))
        .first();
      const result = args.result ? safeJSON(args.result) : null;
      if ((row.kind === "verify_gh" || row.kind === "oauth_gh") && result) {
        const patch = {
          github: {
            ...(settings?.github ?? {}),
            username: result.username ?? settings?.github?.username,
            loggedIn: Boolean(result.loggedIn),
            lastVerifiedAt: Date.now(),
          },
          updatedAt: Date.now(),
        };
        if (settings) await ctx.db.patch(settings._id, patch);
        else
          await ctx.db.insert("appSettings", {
            slug: "default",
            tabs: defaultTabs(),
            ...patch,
          });
      }
      if (row.kind === "verify_gws" && result) {
        const patch = {
          google: {
            ...(settings?.google ?? {}),
            account: result.account ?? settings?.google?.account,
            loggedIn: Boolean(result.loggedIn),
            lastVerifiedAt: Date.now(),
          },
          updatedAt: Date.now(),
        };
        if (settings) await ctx.db.patch(settings._id, patch);
      }
    }
  },
});

export const getRequest = query({
  args: { id: v.id("setupRequests"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db.get(args.id);
  },
});

export const listByStatus = query({
  args: {
    status: v.optional(v.union(v.literal("pending"), v.literal("running"), v.literal("done"), v.literal("error"))),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    if (!args.status) return await ctx.db.query("setupRequests").order("desc").take(50);
    return await ctx.db
      .query("setupRequests")
      .withIndex("by_status", (q) => q.eq("status", args.status!))
      .order("desc")
      .take(50);
  },
});

// Latest result per kind — UI shows badge based on this without scanning
// the whole queue.
export const latestByKind = query({
  args: { kind: KIND, serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const all = await ctx.db
      .query("setupRequests")
      .withIndex("by_kind_status", (q) => q.eq("kind", args.kind))
      .collect();
    if (all.length === 0) return null;
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    return all[0];
  },
});

function safeJSON(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
