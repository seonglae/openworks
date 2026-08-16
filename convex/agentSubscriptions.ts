import { v } from "convex/values";
import { AGENT_EVENT_TYPES, ENTITY_TYPES, SUBSCRIPTION_SCOPES } from "@openworks/domain";
import { mutation, query } from "./_generated/server";
import { getUserId, requireOwner } from "./auth";
import { literals } from "./validators";

const EVENT = literals(AGENT_EVENT_TYPES);

const ENTITY = literals(ENTITY_TYPES);

const SCOPE = literals(SUBSCRIPTION_SCOPES);

export const subscribe = mutation({
  args: {
    agentId: v.string(),
    eventType: EVENT,
    targetType: v.optional(ENTITY),
    scope: SCOPE,
    scopeId: v.optional(v.string()),
    config: v.optional(v.string()),
    enabled: v.optional(v.boolean()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const createdBy = (await getUserId(ctx)) ?? undefined;
    const now = Date.now();
    const id = await ctx.db.insert("agentSubscriptions", {
      agentId: args.agentId,
      eventType: args.eventType,
      targetType: args.targetType,
      scope: args.scope,
      scopeId: args.scopeId,
      config: args.config,
      enabled: args.enabled ?? true,
      createdBy,
      createdAt: now,
      updatedAt: now,
    });
    return { id };
  },
});

export const setEnabled = mutation({
  args: { id: v.id("agentSubscriptions"), enabled: v.boolean(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.id, { enabled: args.enabled, updatedAt: Date.now() });
  },
});

export const unsubscribe = mutation({
  args: { id: v.id("agentSubscriptions"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.delete(args.id);
    return { removed: true };
  },
});

export const listAll = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const all = await ctx.db.query("agentSubscriptions").collect();
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const listByAgent = query({
  args: { agentId: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("agentSubscriptions")
      .withIndex("by_agent", (q) => q.eq("agentId", args.agentId))
      .collect();
  },
});

export const listByScope = query({
  args: { scope: SCOPE, scopeId: v.optional(v.string()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("agentSubscriptions")
      .withIndex("by_scope", (q) => q.eq("scope", args.scope).eq("scopeId", args.scopeId))
      .collect();
  },
});

export const listRuns = query({
  args: {
    status: v.optional(v.union(v.literal("pending"), v.literal("running"), v.literal("done"), v.literal("error"))),
    researchSlug: v.optional(v.string()),
    agentId: v.optional(v.string()),
    limit: v.optional(v.number()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    let runs;
    if (args.researchSlug) {
      runs = await ctx.db
        .query("agentRuns")
        .withIndex("by_research", (q) => q.eq("researchSlug", args.researchSlug))
        .collect();
    } else if (args.agentId && args.status) {
      runs = await ctx.db
        .query("agentRuns")
        .withIndex("by_agent_status", (q) => q.eq("agentId", args.agentId!).eq("status", args.status!))
        .collect();
    } else if (args.status) {
      runs = await ctx.db
        .query("agentRuns")
        .withIndex("by_status_createdAt", (q) => q.eq("status", args.status!))
        .collect();
    } else {
      runs = await ctx.db.query("agentRuns").collect();
    }
    runs.sort((a, b) => b.createdAt - a.createdAt);
    return runs.slice(0, args.limit ?? 100);
  },
});

// Worker calls this to claim a pending run, then updates status when done.
export const claimRun = mutation({
  args: { id: v.id("agentRuns"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const run = await ctx.db.get(args.id);
    if (!run || run.status !== "pending") return null;
    const now = Date.now();
    await ctx.db.patch(args.id, { status: "running", startedAt: now });
    return run;
  },
});

// A run is claimed by patching it to "running", so a worker that dies between
// the claim and completeRun leaves the row claimed forever: no later worker
// will touch it, because only "pending" rows are listed. Two rows sat like that
// for three months. The spawn itself is capped at SPAWN_TIMEOUT_MS (5 min), so
// anything still "running" after half an hour has no process behind it.
//
// These are marked "error", not returned to "pending". A trigger describes a
// moment ("this experiment changed"), and re-running a stale one posts an agent
// comment about an event nobody remembers. Failing it visibly is the honest
// outcome; re-triggering is a decision for whoever reads it.
export const STALE_RUN_MS = 30 * 60_000;

export const reapStaleRuns = mutation({
  args: { now: v.optional(v.number()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const now = args.now ?? Date.now();
    const running = await ctx.db
      .query("agentRuns")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "running"))
      .collect();
    const reaped: string[] = [];
    for (const run of running) {
      // Rows claimed before startedAt existed fall back to createdAt.
      const since = run.startedAt ?? run.createdAt;
      if (now - since < STALE_RUN_MS) continue;
      await ctx.db.patch(run._id, {
        status: "error",
        error: `abandoned: still running ${Math.round((now - since) / 60_000)}min after it was claimed, no worker holds it`,
        completedAt: now,
      });
      reaped.push(run._id);
    }
    return { reaped: reaped.length, ids: reaped };
  },
});

export const completeRun = mutation({
  args: {
    id: v.id("agentRuns"),
    status: v.union(v.literal("done"), v.literal("error")),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const now = Date.now();
    await ctx.db.patch(args.id, {
      status: args.status,
      result: args.result,
      error: args.error,
      completedAt: now,
    });
  },
});
