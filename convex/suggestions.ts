import { v } from "convex/values";
import { mutation, query, internalQuery, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { requireOwner } from "./auth";

// Reaching a successful terminal owes the same bookkeeping jobs.updateStatus
// does: drop the error a previous failed attempt left behind, so the UI does not
// show it next to a finished run, and stamp the completion the duration readout
// reads. Callers pass the job they already loaded, since a job row carries the
// whole pasted newsletter and is not worth reading twice.
function terminalJobPatch(job: Doc<"jobs">, status: "suggested" | "done") {
  return {
    status,
    ...(job.error !== undefined ? { error: undefined } : {}),
    ...(job.summarizingCompletedAt === undefined ? { summarizingCompletedAt: Date.now() } : {}),
  };
}

export const addBatch = mutation({
  args: {
    jobId: v.id("jobs"),
    suggestions: v.array(
      v.object({
        summaryIndex: v.number(),
        topic: v.string(),
        pageName: v.string(),
        pageId: v.string(),
        pageUrl: v.string(),
        action: v.string(),
        content: v.string(),
        contextBefore: v.optional(v.string()),
        contextAfter: v.optional(v.string()),
      }),
    ),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    for (const s of args.suggestions) {
      await ctx.db.insert("suggestions", {
        jobId: args.jobId,
        status: "pending",
        ...s,
      });
    }
    const job = await ctx.db.get(args.jobId);
    // Deleted mid-run: throw so the inserts above roll back with this mutation
    // instead of leaving suggestion rows pointing at a job that is gone.
    if (!job) throw new Error(`job ${args.jobId} no longer exists`);
    // An empty batch still lands on 'suggested', which does park the job in
    // triage with nothing to triage. Special-casing it here cannot fix that: the
    // live producer (browser AutomationRunner) skips addBatch for a zero-length
    // batch and writes 'suggested' itself, and 'suggested' already counts as an
    // advanced run for the worker, so a 'done' branch here would only split the
    // contract the worker prompt states without closing any real job.
    await ctx.db.patch(args.jobId, terminalJobPatch(job, "suggested"));
  },
});

export const listByJob = query({
  args: { jobId: v.id("jobs"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("suggestions")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
  },
});

export const updateStatus = mutation({
  args: {
    suggestionId: v.id("suggestions"),
    status: v.union(v.literal("pending"), v.literal("approved"), v.literal("rejected"), v.literal("executed")),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const s = await ctx.db.get(args.suggestionId);
    if (!s) return;
    await ctx.db.patch(args.suggestionId, { status: args.status });
    if (args.status === "rejected" || args.status === "executed") {
      await ctx.runMutation(internal.suggestions.markJobDoneIfAllResolved, { jobId: s.jobId });
    }
  },
});

export const approveAll = mutation({
  args: { jobId: v.id("jobs"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const suggestions = await ctx.db
      .query("suggestions")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    for (const s of suggestions) {
      if (s.status === "pending") {
        await ctx.db.patch(s._id, { status: "approved" });
      }
    }
  },
});

export const rejectAll = mutation({
  args: { jobId: v.id("jobs"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const suggestions = await ctx.db
      .query("suggestions")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    for (const s of suggestions) {
      if (s.status === "pending") {
        await ctx.db.patch(s._id, { status: "rejected" });
      }
    }
    await ctx.runMutation(internal.suggestions.markJobDoneIfAllResolved, { jobId: args.jobId });
  },
});

export const getApproved = query({
  args: { jobId: v.id("jobs"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const suggestions = await ctx.db
      .query("suggestions")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    return suggestions.filter((s) => s.status === "approved");
  },
});

export const markExecuted = mutation({
  args: { suggestionId: v.id("suggestions"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    // Same contract as updateStatus(status: "executed"): tolerate a row the user
    // deleted mid-execution, and close the parent job when this was the last
    // unresolved suggestion.
    const s = await ctx.db.get(args.suggestionId);
    if (!s) return;
    await ctx.db.patch(args.suggestionId, { status: "executed" });
    await ctx.runMutation(internal.suggestions.markJobDoneIfAllResolved, { jobId: s.jobId });
  },
});

export const internalGetById = internalQuery({
  args: { suggestionId: v.id("suggestions") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.suggestionId);
  },
});

export const internalGetPendingByJob = internalQuery({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("suggestions")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    return all.filter((s) => s.status === "pending");
  },
});

export const internalSetStatus = internalMutation({
  args: {
    suggestionId: v.id("suggestions"),
    status: v.union(v.literal("pending"), v.literal("approved"), v.literal("rejected"), v.literal("executed")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.suggestionId, { status: args.status });
  },
});

// Mark the parent job 'done' when every suggestion on it is resolved
// (executed or rejected — i.e. no pending/approved row left). Called by
// notion.ts after each approve/execute so the queue closes itself once
// the user finishes triaging, instead of agents flipping status:done
// prematurely.
export const markJobDoneIfAllResolved = internalMutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const sugs = await ctx.db
      .query("suggestions")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    if (sugs.length === 0) return; // no suggestions to resolve — keep job at 'suggested'
    const unresolved = sugs.some((s) => s.status === "pending" || s.status === "approved");
    if (unresolved) return;
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status === "done") return;
    await ctx.db.patch(args.jobId, terminalJobPatch(job, "done"));
  },
});

export const getMissingContext = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    // Scan in batches with early termination instead of full collect
    const results = [];
    const all = await ctx.db.query("suggestions").take(500);
    for (const s of all) {
      // Truthiness, not absence: the consumer of these fields
      // (notion.ts findInsertionBlock) bails on any falsy contextBefore, so ""
      // anchors nothing and the row still needs a backfill. Agents do emit ""
      // instead of notion-fetching, and excluding those rows would send the
      // insert to the bottom of the Notion page.
      if (!s.contextBefore && !s.contextAfter) {
        results.push({
          _id: s._id,
          pageId: s.pageId,
          pageUrl: s.pageUrl,
          pageName: s.pageName,
          content: s.content,
        });
      }
    }
    return results;
  },
});

export const updateContent = mutation({
  args: {
    suggestionId: v.id("suggestions"),
    content: v.optional(v.string()),
    contextBefore: v.optional(v.string()),
    contextAfter: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const patch: Record<string, string> = {};
    if (args.content !== undefined) patch.content = args.content;
    if (args.contextBefore !== undefined) patch.contextBefore = args.contextBefore;
    if (args.contextAfter !== undefined) patch.contextAfter = args.contextAfter;
    await ctx.db.patch(args.suggestionId, patch);
  },
});
