import { v } from "convex/values";
import { EXPERIMENT_STATUSES, EXPERIMENT_STATUS_DEFAULT } from "@openworks/domain";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";
import { fanOut } from "./agentTriggers";
import { writeArgs, prepareWrite, finishWrite, withRevision, contentEqual, headToken } from "./contentStore";
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
    ...writeArgs,
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const identity = { kind: "experiment" as const, researchSlug: args.researchSlug, key: args.expSlug };
    const existing = await ctx.db
      .query("researchExperiments")
      .withIndex("by_research_slug", (q) => q.eq("researchSlug", args.researchSlug).eq("expSlug", args.expSlug))
      .unique();
    const head = await prepareWrite(ctx, identity, existing, args);
    const now = Date.now();
    const patch = Object.fromEntries(
      Object.entries({
        name: args.name,
        description: args.description,
        status: args.status,
        params: args.params,
        metrics: args.metrics,
        artifactRef: args.artifactRef,
        notes: args.notes,
      }).filter(([, value]) => value !== undefined),
    );
    if (existing) {
      const next = { ...existing, ...patch, updatedAt: now };
      if (contentEqual(existing, next))
        return { id: existing._id, expSlug: existing.expSlug, created: false, ...headToken(head!) };
      await ctx.db.patch(existing._id, { ...patch, updatedAt: now });
      const token = await finishWrite(ctx, identity, head, "update", next, args);
      await fanOut(ctx, {
        eventType: "entity.updated",
        entityType: "experiment",
        entityKey: args.expSlug,
        researchSlug: args.researchSlug,
        sourceRevisionIds: [token.revisionId],
      });
      return { id: existing._id, expSlug: existing.expSlug, created: false, ...token };
    }
    const payload = {
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
    };
    const id = await ctx.db.insert("researchExperiments", payload);
    const token = await finishWrite(ctx, identity, head, "create", payload, args);
    await fanOut(ctx, {
      eventType: "entity.created",
      entityType: "experiment",
      entityKey: args.expSlug,
      researchSlug: args.researchSlug,
      sourceRevisionIds: [token.revisionId],
    });
    return { id, expSlug: args.expSlug, created: true, ...token };
  },
});
export const get = query({
  args: { researchSlug: v.string(), expSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return withRevision(
      ctx,
      { kind: "experiment" as const, researchSlug: args.researchSlug, key: args.expSlug },
      await ctx.db
        .query("researchExperiments")
        .withIndex("by_research_slug", (q) => q.eq("researchSlug", args.researchSlug).eq("expSlug", args.expSlug))
        .unique(),
    );
  },
});
export const remove = mutation({
  args: { researchSlug: v.string(), expSlug: v.string(), ...writeArgs, serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const identity = { kind: "experiment" as const, researchSlug: args.researchSlug, key: args.expSlug };
    const existing = await ctx.db
      .query("researchExperiments")
      .withIndex("by_research_slug", (q) => q.eq("researchSlug", args.researchSlug).eq("expSlug", args.expSlug))
      .unique();
    const head = await prepareWrite(ctx, identity, existing, args);
    if (!existing) return { removed: false, ...(head ? headToken(head) : { revision: 0 }) };
    await ctx.db.delete(existing._id);
    const token = await finishWrite(ctx, identity, head, "delete", existing, args);
    return { removed: true, ...token };
  },
});
export const list = query({
  args: {
    researchSlug: v.string(),
    status: v.optional(STATUS),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const all = await ctx.db
      .query("researchExperiments")
      .withIndex("by_research", (q) => q.eq("researchSlug", args.researchSlug))
      .collect();
    const filtered = args.status ? all.filter((row) => row.status === args.status) : all;
    return Promise.all(
      filtered
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((row) => withRevision(ctx, { kind: "experiment", researchSlug: row.researchSlug, key: row.expSlug }, row)),
    );
  },
});
