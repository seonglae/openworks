import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { isValidState, RESEARCH_KINDS } from "@openworks/domain";
import { requireOwner } from "./auth";
import { literals } from "./validators";
import { writeProjectState, checkStateVersion } from "./researchState";

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
    const project = await ctx.db
      .query("researchProjects")
      .withIndex("by_slug", (q) => q.eq("slug", args.researchSlug))
      .unique();
    if (!project) throw new Error("Project not found");
    if (project.deletionStartedAt !== undefined) throw new Error("Project deletion is in progress");
    const id = await ctx.db.insert("researchPhaseRuns", {
      researchSlug: args.researchSlug,
      projectId: project._id,
      stateVersion: project.stateVersion ?? 0,
      kindSnapshot: project.kind,
      phaseSnapshot: project.phase,
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
    const active = projects.filter((p) => p.deletionStartedAt === undefined);
    for (const p of active) {
      await ctx.db.insert("researchPhaseRuns", {
        researchSlug: p.slug,
        projectId: p._id,
        stateVersion: p.stateVersion ?? 0,
        kindSnapshot: p.kind,
        phaseSnapshot: p.phase,
        status: "pending",
        createdAt: now,
      });
    }
    return { queued: active.length };
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
    const run = await ctx.db.get(args.id);
    if (!run || run.status !== "running") throw new Error("Run must be running before completion");
    if (args.status === "done" && (!run.projectId || run.appliedAt === undefined))
      throw new Error("Inference must be applied before successful completion");
    if (args.status === "done" && run.appliedPhase !== undefined && args.inferredPhase !== run.appliedPhase)
      throw new Error("Inference result does not match the applied state");
    const now = Date.now();
    await ctx.db.patch(args.id, {
      status: args.status,
      inferredPhase: run.appliedPhase ?? args.inferredPhase,
      inferredHistory: run.appliedHistory ?? args.inferredHistory,
      rawOutput: args.rawOutput,
      error: args.error,
      completedAt: now,
    });
  },
});

// Inference adds evidence; it never deletes or rewrites prior human history.
export const applyInferred = mutation({
  args: {
    researchSlug: v.string(),
    phase: v.string(),
    runId: v.optional(v.id("researchPhaseRuns")),
    expectedStateVersion: v.optional(v.number()),
    history: v.array(v.object({ state: v.string(), at: v.optional(v.number()), note: v.optional(v.string()) })),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const project = await ctx.db
      .query("researchProjects")
      .withIndex("by_slug", (q) => q.eq("slug", args.researchSlug))
      .unique();
    if (!project) throw new Error("Project not found");
    if (project.deletionStartedAt !== undefined) throw new Error("Project deletion is in progress");
    if (!isValidState(project.kind, args.phase)) throw new Error("Invalid inferred phase");
    if (args.history.length > 256) throw new Error("Inferred history exceeds the entry limit");
    const appliedHistory = JSON.stringify(args.history);
    if (new TextEncoder().encode(appliedHistory).length > 128 * 1024)
      throw new Error("Inferred history exceeds the byte limit");
    const now = Date.now();
    let previousAt = -1;
    for (const item of args.history) {
      if (!isValidState(project.kind, item.state)) throw new Error("Invalid inferred history state");
      if (item.at !== undefined) {
        if (!Number.isSafeInteger(item.at) || item.at < 0 || item.at > now || item.at < previousAt)
          throw new Error("Invalid inferred history timestamp");
        previousAt = item.at;
      }
    }
    if (args.history.length && args.history[args.history.length - 1]!.state !== args.phase)
      throw new Error("Inferred history must end at the inferred phase");
    const run = args.runId ? await ctx.db.get(args.runId) : null;
    if (args.runId) {
      if (!run || run.researchSlug !== args.researchSlug || run.projectId !== project._id)
        throw new Error("Inference run does not match this project");
      if (run.appliedAt !== undefined) {
        if (run.appliedPhase !== args.phase) throw new Error("Inference run has already applied a different result");
        return { ok: true, inserted: 0, changed: false };
      }
      if (run.status !== "running") throw new Error("Inference run must be running");
      if (run.stateVersion === undefined || run.kindSnapshot !== project.kind || run.phaseSnapshot !== project.phase)
        throw new Error("Stale inference input; request a new run");
      checkStateVersion(project, run.stateVersion);
    }
    checkStateVersion(project, args.expectedStateVersion);
    let inserted = 0;
    for (const item of args.history) {
      if (item.state === args.phase && item.at === undefined) continue;
      const rows = ctx.db
        .query("researchTimeline")
        .withIndex("by_research_state", (q) => q.eq("researchSlug", args.researchSlug).eq("state", item.state));
      const existing =
        item.at === undefined ? await rows.first() : await rows.filter((q) => q.eq(q.field("at"), item.at)).first();
      if (existing) continue;
      await ctx.db.insert("researchTimeline", {
        researchSlug: args.researchSlug,
        state: item.state,
        at: item.at ?? now,
        note: item.note ? `(inferred) ${item.note}` : "(inferred)",
        actor: "phase-infer",
        inferred: true,
        runId: args.runId,
      });
      inserted++;
    }
    const result = await writeProjectState(ctx, project, {
      phase: args.phase,
      actor: "phase-infer",
      note: "(inferred)",
      runId: args.runId,
    });
    if (result.changed) inserted++;
    if (run) await ctx.db.patch(run._id, { appliedAt: now, appliedPhase: args.phase, appliedHistory });
    return { ok: true, inserted, changed: result.changed };
  },
});
