import { v } from "convex/values";
import { AUTHOR_TYPES, ENTITY_TYPES } from "@openworks/domain";
import { mutation, query } from "./_generated/server";
import { canCommentProject, getUserId, projectBySlug, requireOwner } from "./auth";
import { fanOut } from "./agentTriggers";
import { literals } from "./validators";

const TARGET_TYPE = literals(ENTITY_TYPES);

const AUTHOR_TYPE = literals(AUTHOR_TYPES);

export const post = mutation({
  args: {
    researchSlug: v.string(),
    targetType: TARGET_TYPE,
    targetKey: v.string(),
    targetVenueSlug: v.optional(v.string()),
    parentId: v.optional(v.id("comments")),
    authorType: AUTHOR_TYPE,
    authorId: v.string(),
    authorName: v.optional(v.string()),
    body: v.string(),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    if (args.parentId) {
      const parent = await ctx.db.get(args.parentId);
      if (!parent) throw new Error("parent comment not found");
      if (parent.researchSlug !== args.researchSlug) {
        throw new Error("parent comment is in a different project");
      }
    }
    // Permission check: project must allow commenting from this caller.
    // Agent posts (authorType=agent) bypass auth and rely on the calling
    // CLI/worker holding a service-context (Phase 5 will tighten this with a
    // shared service token).
    if (args.authorType === "user") {
      const userId = await getUserId(ctx);
      if (!userId) throw new Error("auth required for user comments");
      // Server-side enforcement: prevent impersonation.
      if (args.authorId !== userId) throw new Error("authorId must match authenticated user");
      const project = await projectBySlug(ctx, args.researchSlug);
      if (project && !(await canCommentProject(ctx, project, userId))) {
        throw new Error(`forbidden: cannot comment on project ${args.researchSlug}`);
      }
    }
    const now = Date.now();
    const id = await ctx.db.insert("comments", {
      researchSlug: args.researchSlug,
      targetType: args.targetType,
      targetKey: args.targetKey,
      targetVenueSlug: args.targetVenueSlug,
      parentId: args.parentId,
      authorType: args.authorType,
      authorId: args.authorId,
      authorName: args.authorName,
      body: args.body,
      createdAt: now,
      updatedAt: now,
    });
    // Agent-authored comments do NOT fan out. A triggered agent is instructed
    // to post a comment as its output; if that post re-fired comment.posted it
    // would re-enqueue the same subscription and loop until quota is exhausted.
    // Only user comments trigger agent reactions.
    if (args.authorType !== "agent") {
      await fanOut(ctx, {
        eventType: "comment.posted",
        entityType: args.targetType,
        entityKey: args.targetKey,
        entityVenueSlug: args.targetVenueSlug,
        researchSlug: args.researchSlug,
      });
    }
    return { id, createdAt: now };
  },
});

export const edit = mutation({
  args: {
    commentId: v.id("comments"),
    body: v.string(),
    authorType: AUTHOR_TYPE,
    authorId: v.string(),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db.get(args.commentId);
    if (!existing) throw new Error("comment not found");
    if (existing.deleted) throw new Error("comment is deleted");
    if (existing.authorType !== args.authorType || existing.authorId !== args.authorId) {
      throw new Error("not the author");
    }
    const now = Date.now();
    await ctx.db.patch(args.commentId, { body: args.body, editedAt: now, updatedAt: now });
    return { id: args.commentId, editedAt: now };
  },
});

// Soft delete — preserves thread shape. authorId check ensures only the
// author can delete (will be tightened by auth in a later phase).
export const remove = mutation({
  args: {
    commentId: v.id("comments"),
    authorType: AUTHOR_TYPE,
    authorId: v.string(),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db.get(args.commentId);
    if (!existing) return { removed: false };
    if (existing.authorType !== args.authorType || existing.authorId !== args.authorId) {
      throw new Error("not the author");
    }
    const now = Date.now();
    await ctx.db.patch(args.commentId, { deleted: true, body: "", updatedAt: now });
    return { removed: true };
  },
});

// All comments on a single target. Returns full flat list ordered by createdAt;
// caller can build thread tree using parentId. Default excludes deleted; pass
// includeDeleted to keep them as tombstones (preserves reply context in UI).
export const listForTarget = query({
  args: {
    researchSlug: v.string(),
    targetType: TARGET_TYPE,
    targetKey: v.string(),
    targetVenueSlug: v.optional(v.string()),
    includeDeleted: v.optional(v.boolean()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const all = await ctx.db
      .query("comments")
      .withIndex("by_target", (q) =>
        q.eq("researchSlug", args.researchSlug).eq("targetType", args.targetType).eq("targetKey", args.targetKey),
      )
      .collect();
    return all
      .filter((c) => c.targetVenueSlug === args.targetVenueSlug)
      .filter((c) => args.includeDeleted || !c.deleted)
      .sort((a, b) => a.createdAt - b.createdAt);
  },
});

export const listReplies = query({
  args: { parentId: v.id("comments"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("comments")
      .withIndex("by_parent", (q) => q.eq("parentId", args.parentId))
      .order("asc")
      .collect();
  },
});

export const listByAuthor = query({
  args: {
    authorType: AUTHOR_TYPE,
    authorId: v.string(),
    limit: v.optional(v.number()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const items = await ctx.db
      .query("comments")
      .withIndex("by_author", (q) => q.eq("authorType", args.authorType).eq("authorId", args.authorId))
      .order("desc")
      .take(args.limit ?? 100);
    return items.filter((c) => !c.deleted);
  },
});

export const get = query({
  args: { commentId: v.id("comments"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db.get(args.commentId);
  },
});

// Lightweight per-target counts for UI badges. Returns total + per-author-type.
export const countForTarget = query({
  args: {
    researchSlug: v.string(),
    targetType: TARGET_TYPE,
    targetKey: v.string(),
    targetVenueSlug: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const all = await ctx.db
      .query("comments")
      .withIndex("by_target", (q) =>
        q.eq("researchSlug", args.researchSlug).eq("targetType", args.targetType).eq("targetKey", args.targetKey),
      )
      .collect();
    const live = all.filter((c) => c.targetVenueSlug === args.targetVenueSlug && !c.deleted);
    return {
      total: live.length,
      user: live.filter((c) => c.authorType === "user").length,
      agent: live.filter((c) => c.authorType === "agent").length,
    };
  },
});
