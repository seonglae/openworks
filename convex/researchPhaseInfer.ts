import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { isValidState, RESEARCH_KINDS } from "@openworks/domain";
import { requireOwner } from "./auth";
import { literals } from "./validators";

// Frontend → request inference for a single project (one subagent per row).
export const request = mutation({
  args: {
    researchSlug: v.string(),
    rootPath: v.optional(v.string()),
    machineId: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const id = await ctx.db.insert("researchPhaseRuns", {
      researchSlug: args.researchSlug,
      rootPath: args.rootPath,
      machineId: args.machineId,
      status: "pending",
      createdAt: Date.now(),
    });
    return { id };
  },
});

// Frontend → kick all projects of a kind. Returns the number queued.
export const requestAll = mutation({
  args: { kind: v.optional(literals(RESEARCH_KINDS)), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const projects = args.kind
      ? await ctx.db
          .query("researchProjects")
          .withIndex("by_kind_phase", (q) => q.eq("kind", args.kind!))
          .collect()
      : await ctx.db.query("researchProjects").collect();
    const now = Date.now();
    for (const p of projects) {
      await ctx.db.insert("researchPhaseRuns", {
        researchSlug: p.slug,
        status: "pending",
        createdAt: now,
      });
    }
    return { queued: projects.length };
  },
});

export const listForResearch = query({
  args: { researchSlug: v.string(), limit: v.optional(v.number()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const runs = await ctx.db
      .query("researchPhaseRuns")
      .withIndex("by_research", (q) => q.eq("researchSlug", args.researchSlug))
      .order("desc")
      .take(args.limit ?? 5);
    return runs;
  },
});

export const latestForResearch = query({
  args: { researchSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const runs = await ctx.db
      .query("researchPhaseRuns")
      .withIndex("by_research", (q) => q.eq("researchSlug", args.researchSlug))
      .order("desc")
      .take(1);
    return runs[0] ?? null;
  },
});

// Worker side.
export const getPendingRun = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("researchPhaseRuns")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "pending"))
      .order("asc")
      .first();
  },
});

export const claimRun = mutation({
  args: { id: v.id("researchPhaseRuns"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const r = await ctx.db.get(args.id);
    if (!r || r.status !== "pending") return null;
    const now = Date.now();
    await ctx.db.patch(args.id, { status: "running", startedAt: now });
    return r;
  },
});

export const completeRun = mutation({
  args: {
    id: v.id("researchPhaseRuns"),
    status: v.union(v.literal("done"), v.literal("error")),
    inferredPhase: v.optional(v.string()),
    inferredHistory: v.optional(v.string()),
    rawOutput: v.optional(v.string()),
    error: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const now = Date.now();
    await ctx.db.patch(args.id, {
      status: args.status,
      inferredPhase: args.inferredPhase,
      inferredHistory: args.inferredHistory,
      rawOutput: args.rawOutput,
      error: args.error,
      completedAt: now,
    });
  },
});

// Apply an inferred result to the actual project + timeline. Called by the
// worker after parsing the agent's JSON. History entries that are invalid
// states are skipped silently.
export const applyInferred = mutation({
  args: {
    researchSlug: v.string(),
    phase: v.string(),
    history: v.array(
      v.object({
        state: v.string(),
        at: v.optional(v.number()),
        note: v.optional(v.string()),
      }),
    ),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const project = await ctx.db
      .query("researchProjects")
      .withIndex("by_slug", (q) => q.eq("slug", args.researchSlug))
      .first();
    if (!project) throw new Error(`unknown project: ${args.researchSlug}`);
    if (!isValidState(project.kind, args.phase)) throw new Error(`invalid phase: ${args.phase}`);
    const now = Date.now();
    await ctx.db.patch(project._id, { phase: args.phase, updatedAt: now });

    // Replace timeline with the inferred sequence (mark each entry as
    // inferred so it's distinguishable in audits).
    const oldEntries = await ctx.db
      .query("researchTimeline")
      .withIndex("by_research_at", (q) => q.eq("researchSlug", args.researchSlug))
      .collect();
    for (const e of oldEntries) await ctx.db.delete(e._id);
    for (const h of args.history) {
      if (!isValidState(project.kind, h.state)) continue;
      await ctx.db.insert("researchTimeline", {
        researchSlug: args.researchSlug,
        state: h.state,
        at: h.at ?? now,
        note: h.note ? `(inferred) ${h.note}` : "(inferred)",
        actor: "phase-infer",
      });
    }
    return { ok: true, inserted: args.history.length };
  },
});
