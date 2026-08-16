import { v } from "convex/values";
import { EXPERIMENT_STATUSES, EXPERIMENT_STATUS_DEFAULT } from "@openworks/domain";
import { mutation, query } from "./_generated/server";
import { fanOut } from "./agentTriggers";
import { requireOwner } from "./auth";
import { literals } from "./validators";

const STATUS = literals(EXPERIMENT_STATUSES);

export const save = mutation({
  args: {
    researchSlug: v.string(),
    expSlug: v.string(),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    status: v.optional(STATUS),
    params: v.optional(v.string()),
    metrics: v.optional(v.string()),
    artifactRef: v.optional(v.string()),
    notes: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db
      .query("researchExperiments")
      .withIndex("by_research_slug", (q) => q.eq("researchSlug", args.researchSlug).eq("expSlug", args.expSlug))
      .first();
    const now = Date.now();
    if (existing) {
      const { researchSlug: _r, expSlug: _s, serviceKey: _k, ...patch } = args;
      const filtered = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      await ctx.db.patch(existing._id, { ...filtered, updatedAt: now });
      await fanOut(ctx, {
        eventType: "entity.updated",
        entityType: "experiment",
        entityKey: args.expSlug,
        researchSlug: args.researchSlug,
      });
      return { id: existing._id, expSlug: existing.expSlug, created: false };
    }
    const id = await ctx.db.insert("researchExperiments", {
      researchSlug: args.researchSlug,
      expSlug: args.expSlug,
      name: args.name ?? args.expSlug,
      description: args.description,
      status: args.status ?? EXPERIMENT_STATUS_DEFAULT,
      params: args.params,
      metrics: args.metrics,
      artifactRef: args.artifactRef,
      notes: args.notes,
      createdAt: now,
      updatedAt: now,
    });
    await fanOut(ctx, {
      eventType: "entity.created",
      entityType: "experiment",
      entityKey: args.expSlug,
      researchSlug: args.researchSlug,
    });
    return { id, expSlug: args.expSlug, created: true };
  },
});

export const get = query({
  args: { researchSlug: v.string(), expSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("researchExperiments")
      .withIndex("by_research_slug", (q) => q.eq("researchSlug", args.researchSlug).eq("expSlug", args.expSlug))
      .first();
  },
});

export const list = query({
  args: { researchSlug: v.string(), status: v.optional(STATUS), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const all = await ctx.db
      .query("researchExperiments")
      .withIndex("by_research", (q) => q.eq("researchSlug", args.researchSlug))
      .collect();
    const filtered = args.status ? all.filter((e) => e.status === args.status) : all;
    return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const remove = mutation({
  args: { researchSlug: v.string(), expSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db
      .query("researchExperiments")
      .withIndex("by_research_slug", (q) => q.eq("researchSlug", args.researchSlug).eq("expSlug", args.expSlug))
      .first();
    if (!existing) return { removed: false };
    await ctx.db.delete(existing._id);
    return { removed: true };
  },
});
