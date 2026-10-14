import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";
import { fanOut } from "./agentTriggers";
import { writeArgs, prepareWrite, finishWrite, withRevision, contentEqual, headToken, pinSource } from "./contentStore";

export const save = mutation({
  args: {
    researchSlug: v.string(),
    sectionSlug: v.string(),
    venueSlug: v.optional(v.string()),
    title: v.optional(v.string()),
    content: v.optional(v.string()),
    format: v.optional(v.union(v.literal("markdown"), v.literal("latex"))),
    order: v.optional(v.number()),
    notes: v.optional(v.string()),
    ...writeArgs,
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const identity = {
      kind: "section" as const,
      researchSlug: args.researchSlug,
      key: args.sectionSlug,
      venueSlug: args.venueSlug,
    };
    const existing = await ctx.db
      .query("researchSections")
      .withIndex("by_research_venue_section", (q) =>
        q.eq("researchSlug", args.researchSlug).eq("venueSlug", args.venueSlug).eq("sectionSlug", args.sectionSlug),
      )
      .unique();
    const head = await prepareWrite(ctx, identity, existing, args);
    const now = Date.now();
    const patch = Object.fromEntries(
      Object.entries({
        title: args.title,
        content: args.content,
        format: args.format,
        order: args.order,
        notes: args.notes,
      }).filter(([, value]) => value !== undefined),
    );
    if (existing) {
      const next = { ...existing, ...patch, updatedAt: now };
      if (contentEqual(existing, next))
        return { id: existing._id, sectionSlug: existing.sectionSlug, created: false, ...headToken(head!) };
      await ctx.db.patch(existing._id, { ...patch, updatedAt: now });
      const token = await finishWrite(ctx, identity, head, "update", next, args);
      await fanOut(ctx, {
        eventType: "entity.updated",
        entityType: "section",
        entityKey: args.sectionSlug,
        researchSlug: args.researchSlug,
        entityVenueSlug: args.venueSlug,
        sourceRevisionIds: [token.revisionId],
        runId: args.runId,
      });
      return { id: existing._id, sectionSlug: existing.sectionSlug, created: false, ...token };
    }
    const payload = {
      researchSlug: args.researchSlug,
      sectionSlug: args.sectionSlug,
      venueSlug: args.venueSlug,
      title: args.title ?? args.sectionSlug,
      content: args.content ?? "",
      format: args.format ?? "markdown",
      order: args.order,
      notes: args.notes,
      createdAt: now,
      updatedAt: now,
    };
    const id = await ctx.db.insert("researchSections", payload);
    const token = await finishWrite(ctx, identity, head, "create", payload, args);
    await fanOut(ctx, {
      eventType: "entity.created",
      entityType: "section",
      entityKey: args.sectionSlug,
      researchSlug: args.researchSlug,
      entityVenueSlug: args.venueSlug,
      sourceRevisionIds: [token.revisionId],
      runId: args.runId,
    });
    return { id, sectionSlug: args.sectionSlug, created: true, ...token };
  },
});
export const get = query({
  args: {
    researchSlug: v.string(),
    sectionSlug: v.string(),
    venueSlug: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return withRevision(
      ctx,
      { kind: "section" as const, researchSlug: args.researchSlug, key: args.sectionSlug, venueSlug: args.venueSlug },
      await ctx.db
        .query("researchSections")
        .withIndex("by_research_venue_section", (q) =>
          q.eq("researchSlug", args.researchSlug).eq("venueSlug", args.venueSlug).eq("sectionSlug", args.sectionSlug),
        )
        .unique(),
    );
  },
});
export const remove = mutation({
  args: {
    researchSlug: v.string(),
    sectionSlug: v.string(),
    venueSlug: v.optional(v.string()),
    ...writeArgs,
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const identity = {
      kind: "section" as const,
      researchSlug: args.researchSlug,
      key: args.sectionSlug,
      venueSlug: args.venueSlug,
    };
    const existing = await ctx.db
      .query("researchSections")
      .withIndex("by_research_venue_section", (q) =>
        q.eq("researchSlug", args.researchSlug).eq("venueSlug", args.venueSlug).eq("sectionSlug", args.sectionSlug),
      )
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
    venueSlug: v.optional(v.string()),
    includeAllVenues: v.optional(v.boolean()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const all = await ctx.db
      .query("researchSections")
      .withIndex("by_research", (q) => q.eq("researchSlug", args.researchSlug))
      .collect();
    const filtered = args.includeAllVenues ? all : all.filter((row) => row.venueSlug === args.venueSlug);
    return Promise.all(
      filtered
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((row) =>
          withRevision(
            ctx,
            { kind: "section", researchSlug: row.researchSlug, key: row.sectionSlug, venueSlug: row.venueSlug },
            row,
          ),
        ),
    );
  },
});
export const fork = mutation({
  args: {
    researchSlug: v.string(),
    sectionSlug: v.string(),
    fromVenueSlug: v.optional(v.string()),
    toVenueSlug: v.optional(v.string()),
    expectedSourceRevision: v.optional(v.number()),
    ...writeArgs,
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    if (args.fromVenueSlug === args.toVenueSlug)
      throw new Error("Source and target must be different content identities");
    const source = await ctx.db
      .query("researchSections")
      .withIndex("by_research_venue_section", (q) =>
        q.eq("researchSlug", args.researchSlug).eq("venueSlug", args.fromVenueSlug).eq("sectionSlug", args.sectionSlug),
      )
      .unique();
    if (!source) throw new Error("source section not found");
    const sourceRevisionId = await pinSource(
      ctx,
      {
        kind: "section" as const,
        researchSlug: args.researchSlug,
        key: args.sectionSlug,
        venueSlug: args.fromVenueSlug,
      },
      source,
      args.expectedSourceRevision,
    );
    if (args.runId && !args.sourceRevisionIds?.includes(sourceRevisionId))
      throw new Error("Fork source must be pinned to the run inputs");
    const identity = {
      kind: "section" as const,
      researchSlug: args.researchSlug,
      key: args.sectionSlug,
      venueSlug: args.toVenueSlug,
    };
    const existing = await ctx.db
      .query("researchSections")
      .withIndex("by_research_venue_section", (q) =>
        q.eq("researchSlug", args.researchSlug).eq("venueSlug", args.toVenueSlug).eq("sectionSlug", args.sectionSlug),
      )
      .unique();
    const head = await prepareWrite(ctx, identity, existing, args);
    const now = Date.now();
    const payload = {
      researchSlug: args.researchSlug,
      sectionSlug: args.sectionSlug,
      venueSlug: args.toVenueSlug,
      title: source.title,
      content: source.content,
      format: source.format,
      order: source.order,
      notes: source.notes,
      updatedAt: now,
    };
    if (existing && contentEqual(existing, payload)) return { id: existing._id, forked: false, ...headToken(head!) };
    const snapshot = { ...payload, createdAt: existing?.createdAt ?? now };
    const id = existing ? existing._id : await ctx.db.insert("researchSections", snapshot);
    if (existing) await ctx.db.patch(existing._id, payload);
    const token = await finishWrite(ctx, identity, head, "fork", snapshot, {
      ...args,
      sourceRevisionIds: [...new Set([...(args.sourceRevisionIds ?? []), sourceRevisionId])],
    });
    await fanOut(ctx, {
      eventType: existing ? "entity.updated" : "entity.created",
      entityType: "section",
      entityKey: args.sectionSlug,
      entityVenueSlug: args.toVenueSlug,
      researchSlug: args.researchSlug,
      sourceRevisionIds: [token.revisionId],
      runId: args.runId,
    });
    return { id, forked: !existing, ...token };
  },
});
