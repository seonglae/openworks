import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";

// Count distinct times the project's phase has been pre_submit_check. New
// rows get the next iteration number; subsequent ticks on the same iteration
// update in place.
async function currentIteration(ctx: { db: any }, researchSlug: string): Promise<number> {
  const transitions = await ctx.db
    .query("researchTimeline")
    .withIndex("by_research_state", (q: any) => q.eq("researchSlug", researchSlug).eq("state", "pre_submit_check"))
    .collect();
  return Math.max(1, transitions.length);
}

export const currentIterationFor = query({
  args: { researchSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await currentIteration(ctx, args.researchSlug);
  },
});

export const listForIteration = query({
  args: { researchSlug: v.string(), iterationN: v.optional(v.number()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const iter = args.iterationN ?? (await currentIteration(ctx, args.researchSlug));
    const rows = await ctx.db
      .query("researchChecklists")
      .withIndex("by_research_iter", (q) => q.eq("researchSlug", args.researchSlug).eq("iterationN", iter))
      .collect();
    return { iterationN: iter, items: rows };
  },
});

export const listAllIterations = query({
  args: { researchSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const rows = await ctx.db
      .query("researchChecklists")
      .withIndex("by_research_iter", (q) => q.eq("researchSlug", args.researchSlug))
      .collect();
    // Group by iterationN so the UI can render one column per iteration.
    const byIter = new Map<number, typeof rows>();
    for (const r of rows) {
      const arr = byIter.get(r.iterationN) ?? [];
      arr.push(r);
      byIter.set(r.iterationN, arr);
    }
    return Array.from(byIter.entries())
      .map(([iterationN, items]) => ({ iterationN, items }))
      .sort((a, b) => b.iterationN - a.iterationN);
  },
});

// One-shot migration for projects whose phase is one of the retired FSM
// states (iterate / ai_review / bib_check / desk_check). Maps each to its
// closest new state. Idempotent.
export const migrateLegacyPhases = mutation({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const mapping: Record<string, string> = {
      iterate: "setup",
      ai_review: "pre_submit_check",
      bib_check: "pre_submit_check",
      desk_check: "pre_submit_check",
      // even older labels that existed before the current FSM
      execution: "run",
      experiment: "run",
      experiments: "run",
      analyze: "analysis",
      paper: "writing",
      submitted: "submit_main",
      submit: "submit_main",
    };
    const projects = await ctx.db.query("researchProjects").collect();
    let migrated = 0;
    for (const p of projects) {
      const next = mapping[p.phase];
      if (!next) continue;
      await ctx.db.patch(p._id, { phase: next, updatedAt: Date.now() });
      // Record the migration in the timeline so it's auditable.
      await ctx.db.insert("researchTimeline", {
        researchSlug: p.slug,
        state: next,
        at: Date.now(),
        note: `migrated from legacy phase '${p.phase}'`,
      });
      migrated++;
    }
    return { migrated };
  },
});

export const setItem = mutation({
  args: {
    researchSlug: v.string(),
    iterationN: v.optional(v.number()),
    itemKey: v.string(),
    checked: v.boolean(),
    note: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const iter = args.iterationN ?? (await currentIteration(ctx, args.researchSlug));
    const existing = await ctx.db
      .query("researchChecklists")
      .withIndex("by_research_iter_item", (q) =>
        q.eq("researchSlug", args.researchSlug).eq("iterationN", iter).eq("itemKey", args.itemKey),
      )
      .first();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        checked: args.checked,
        checkedAt: args.checked ? now : undefined,
        note: args.note ?? existing.note,
      });
      return { id: existing._id, iterationN: iter };
    }
    const id = await ctx.db.insert("researchChecklists", {
      researchSlug: args.researchSlug,
      iterationN: iter,
      itemKey: args.itemKey,
      checked: args.checked,
      checkedAt: args.checked ? now : undefined,
      note: args.note,
    });
    return { id, iterationN: iter };
  },
});
