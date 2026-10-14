import { v } from "convex/values";
import { AGENT_EVENT_TYPES, ENTITY_TYPES, SUBSCRIPTION_SCOPES, normalizeAgentConfig } from "@openworks/domain";
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
    if (args.scope !== "global" && !args.scopeId?.trim())
      throw new Error("scopeId is required for a scoped subscription");
    if (args.scope === "global" && args.scopeId !== undefined)
      throw new Error("Global subscriptions cannot have scopeId");
    let scopeId = args.scopeId;
    if (args.scope === "workspace") {
      const id = ctx.db.normalizeId("workspaces", args.scopeId!);
      const workspace = id
        ? await ctx.db.get(id)
        : await ctx.db
            .query("workspaces")
            .withIndex("by_slug", (q) => q.eq("slug", args.scopeId!))
            .unique();
      if (!workspace) throw new Error("Workspace not found");
      scopeId = workspace._id;
    }
    const config = normalizeAgentConfig(args.config);
    const createdBy = (await getUserId(ctx)) ?? undefined;
    const now = Date.now();
    const id = await ctx.db.insert("agentSubscriptions", {
      agentId: args.agentId,
      eventType: args.eventType,
      targetType: args.targetType,
      scope: args.scope,
      scopeId,
      config,
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
    if (args.scope === "workspace" && args.scopeId) {
      const id = ctx.db.normalizeId("workspaces", args.scopeId);
      const workspace = id
        ? await ctx.db.get(id)
        : await ctx.db
            .query("workspaces")
            .withIndex("by_slug", (q) => q.eq("slug", args.scopeId!))
            .unique();
      if (!workspace) return [];
      const canonical = await ctx.db
        .query("agentSubscriptions")
        .withIndex("by_scope", (q) => q.eq("scope", "workspace").eq("scopeId", workspace._id))
        .collect();
      const legacy = await ctx.db
        .query("agentSubscriptions")
        .withIndex("by_scope", (q) => q.eq("scope", "workspace").eq("scopeId", workspace.slug))
        .collect();
      return [...new Map([...canonical, ...legacy].map((row) => [row._id, row])).values()];
    }
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
    outcome: v.optional(v.union(v.literal("commented"), v.literal("no_action"))),
    sourceRevisionIds: v.optional(v.array(v.id("contentRevisions"))),
    error: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const run = await ctx.db.get(args.id);
    if (!run || run.status !== "running") throw new Error("Run must be running before completion");
    if (args.status === "done") {
      const sources = args.sourceRevisionIds ?? [];
      if (
        sources.length !== (run.sourceRevisionIds ?? []).length ||
        new Set(sources).size !== sources.length ||
        sources.some((id) => !(run.sourceRevisionIds ?? []).includes(id))
      )
        throw new Error("Source revisions must exactly match the run inputs");
      const comment = await ctx.db
        .query("comments")
        .withIndex("by_run", (q) => q.eq("runId", args.id))
        .first();
      if (args.outcome === "commented") {
        if (run.sourceRevisionIds === undefined || !run.triggerSnapshot)
          throw new Error("Legacy run lacks pinned inputs; request a new run or report no action");
        if (!comment || comment.deleted || !comment.body.trim())
          throw new Error("Run has no attributed output comment");
      } else if (args.outcome === "no_action") {
        if (args.result?.trim() !== "NO_ACTION" || comment) throw new Error("Invalid no-action result");
      } else throw new Error("A completed run must declare an output outcome");
    }
    const now = Date.now();
    await ctx.db.patch(args.id, {
      status: args.status,
      outcome: args.outcome,
      result: args.result,
      error: args.error,
      completedAt: now,
    });
  },
});
