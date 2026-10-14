import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";
import { fanOut } from "./agentTriggers";
import { writeArgs, prepareWrite, finishWrite, withRevision, contentEqual, headToken } from "./contentStore";

export const save = mutation({
  args: {
    researchSlug: v.string(),
    memoSlug: v.string(),
    title: v.optional(v.string()),
    content: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    notes: v.optional(v.string()),
    ...writeArgs,
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const identity = { kind: "memo" as const, researchSlug: args.researchSlug, key: args.memoSlug };
    const existing = await ctx.db
      .query("researchMemos")
      .withIndex("by_research_slug", (q) => q.eq("researchSlug", args.researchSlug).eq("memoSlug", args.memoSlug))
      .unique();
    const head = await prepareWrite(ctx, identity, existing, args);
    const now = Date.now();
    const patch = Object.fromEntries(
      Object.entries({ title: args.title, content: args.content, tags: args.tags, notes: args.notes }).filter(
        ([, value]) => value !== undefined,
      ),
    );
    if (existing) {
      const next = { ...existing, ...patch, updatedAt: now };
      if (contentEqual(existing, next))
        return { id: existing._id, memoSlug: existing.memoSlug, created: false, ...headToken(head!) };
      await ctx.db.patch(existing._id, { ...patch, updatedAt: now });
      const token = await finishWrite(ctx, identity, head, "update", next, args);
      await fanOut(ctx, {
        eventType: "entity.updated",
        entityType: "memo",
        entityKey: args.memoSlug,
        researchSlug: args.researchSlug,
        sourceRevisionIds: [token.revisionId],
        runId: args.runId,
      });
      return { id: existing._id, memoSlug: existing.memoSlug, created: false, ...token };
    }
    const payload = {
      researchSlug: args.researchSlug,
      memoSlug: args.memoSlug,
      title: args.title ?? args.memoSlug,
      content: args.content ?? "",
      tags: args.tags,
      notes: args.notes,
      createdAt: now,
      updatedAt: now,
    };
    const id = await ctx.db.insert("researchMemos", payload);
    const token = await finishWrite(ctx, identity, head, "create", payload, args);
    await fanOut(ctx, {
      eventType: "entity.created",
      entityType: "memo",
      entityKey: args.memoSlug,
      researchSlug: args.researchSlug,
      sourceRevisionIds: [token.revisionId],
      runId: args.runId,
    });
    return { id, memoSlug: args.memoSlug, created: true, ...token };
  },
});
export const get = query({
  args: { researchSlug: v.string(), memoSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return withRevision(
      ctx,
      { kind: "memo" as const, researchSlug: args.researchSlug, key: args.memoSlug },
      await ctx.db
        .query("researchMemos")
        .withIndex("by_research_slug", (q) => q.eq("researchSlug", args.researchSlug).eq("memoSlug", args.memoSlug))
        .unique(),
    );
  },
});
export const remove = mutation({
  args: { researchSlug: v.string(), memoSlug: v.string(), ...writeArgs, serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const identity = { kind: "memo" as const, researchSlug: args.researchSlug, key: args.memoSlug };
    const existing = await ctx.db
      .query("researchMemos")
      .withIndex("by_research_slug", (q) => q.eq("researchSlug", args.researchSlug).eq("memoSlug", args.memoSlug))
      .unique();
    const head = await prepareWrite(ctx, identity, existing, args);
    if (!existing) return { removed: false, ...(head ? headToken(head) : { revision: 0 }) };
    await ctx.db.delete(existing._id);
    const token = await finishWrite(ctx, identity, head, "delete", existing, args);
    return { removed: true, ...token };
  },
});
export const list = query({
  args: { researchSlug: v.string(), tag: v.optional(v.string()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const all = await ctx.db
      .query("researchMemos")
      .withIndex("by_research", (q) => q.eq("researchSlug", args.researchSlug))
      .collect();
    const filtered = args.tag ? all.filter((row) => (row.tags ?? []).includes(args.tag!)) : all;
    return Promise.all(
      filtered
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((row) => withRevision(ctx, { kind: "memo", researchSlug: row.researchSlug, key: row.memoSlug }, row)),
    );
  },
});
