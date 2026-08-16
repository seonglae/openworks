// Keeps `jobs.summaryCount` / `jobs.summaryScores` in step with the job's
// actual `summaries` rows. Lives in its own module so both summaries.ts and
// jobs.ts can call it without an import cycle.

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, type MutationCtx } from "./_generated/server";
import { requireOwner } from "./auth";
import { JOB_TYPES } from "@openworks/domain";
import { literals } from "./validators";

// Always a full recompute from the summaries rows, never an increment, so a
// call site that gets missed leaves the job merely stale until its next write
// rather than permanently wrong. Cheap: one index query scoped to one job.
export async function syncSummaryAggregates(ctx: MutationCtx, jobId: Id<"jobs">) {
  const job = await ctx.db.get(jobId);
  if (!job) return;
  const rows = await ctx.db
    .query("summaries")
    .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
    .collect();
  const scores: number[] = [];
  for (const r of rows) {
    const overall =
      job.type === "paper" ? r.scores?.overall : job.type === "article" ? r.articleScores?.overall : undefined;
    if (typeof overall === "number") scores.push(overall);
  }
  scores.sort((a, b) => a - b);
  const prev = job.summaryScores ?? [];
  const scoresChanged = prev.length !== scores.length || prev.some((s, i) => s !== scores[i]);
  const patch: { summaryCount?: number; summaryScores?: number[] } = {};
  if (job.summaryCount !== rows.length) patch.summaryCount = rows.length;
  if (scoresChanged) patch.summaryScores = scores;
  // Skip the write when nothing moved — these run inside mutations the worker
  // fires constantly, and a no-op patch would still invalidate every reactive
  // query reading this row.
  if (patch.summaryCount === undefined && patch.summaryScores === undefined) return;
  await ctx.db.patch(jobId, patch);
}

// Backfill / repair pass. Recomputing a job's rollup reads all of its summary
// rows, and those carry a 384-d embedding plus the full summary prose, so a
// whole job type at once blows the 16MB per-transaction read limit — hence the
// batch. Call repeatedly until `remaining` is 0.
//
// Default `onlyMissing` mode skips jobs that already have a rollup, which makes
// the loop converge and makes re-runs cheap. Pass onlyMissing: false to re-derive
// rows that already have one; `repaired` is then the drift count, and a healthy
// deployment reports 0.
export const repair = mutation({
  args: {
    type: literals(JOB_TYPES),
    archived: v.optional(v.boolean()),
    batch: v.optional(v.number()),
    onlyMissing: v.optional(v.boolean()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const archived = args.archived ?? false;
    const batch = Math.min(Math.max(args.batch ?? 60, 1), 200);
    const onlyMissing = args.onlyMissing ?? true;
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_type_archived_createdAt", (q) => q.eq("type", args.type).eq("archived", archived))
      .collect();
    const todo = onlyMissing ? jobs.filter((j) => j.summaryCount === undefined) : jobs;
    let repaired = 0;
    for (const j of todo.slice(0, batch)) {
      const before = `${j.summaryCount ?? -1}:${(j.summaryScores ?? []).join(",")}`;
      await syncSummaryAggregates(ctx, j._id);
      const after = await ctx.db.get(j._id);
      if (after && `${after.summaryCount ?? -1}:${(after.summaryScores ?? []).join(",")}` !== before) repaired++;
    }
    return {
      type: args.type,
      archived,
      scanned: Math.min(todo.length, batch),
      repaired,
      remaining: Math.max(0, todo.length - batch),
    };
  },
});
