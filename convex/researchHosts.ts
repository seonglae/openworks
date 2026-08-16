import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";

const hostShape = { machineId: v.string(), rootPath: v.string(), bibRelPath: v.optional(v.string()) };

// Upsert a host entry by machineId; preserves other machines' hosts.
export const setHost = mutation({
  args: { ...hostShape, serviceKey: v.optional(v.string()) },
  // researchSlug is passed alongside hostShape — extract via a wrapper handler
  // would be cleaner, but matching the upsert pattern used elsewhere we just
  // accept slug + host props together.
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    throw new Error("use setHostForResearch — this stub kept to lock the host shape");
  },
});

export const setHostForResearch = mutation({
  args: {
    researchSlug: v.string(),
    machineId: v.string(),
    rootPath: v.string(),
    bibRelPath: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const project = await ctx.db
      .query("researchProjects")
      .withIndex("by_slug", (q) => q.eq("slug", args.researchSlug))
      .first();
    if (!project) throw new Error(`unknown project: ${args.researchSlug}`);
    const hosts = (project.hosts ?? []).slice();
    const idx = hosts.findIndex((h) => h.machineId === args.machineId);
    const entry = { machineId: args.machineId, rootPath: args.rootPath, bibRelPath: args.bibRelPath };
    if (idx >= 0) hosts[idx] = entry;
    else hosts.push(entry);
    await ctx.db.patch(project._id, { hosts, updatedAt: Date.now() });
    return { ok: true, count: hosts.length };
  },
});

export const removeHost = mutation({
  args: { researchSlug: v.string(), machineId: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const project = await ctx.db
      .query("researchProjects")
      .withIndex("by_slug", (q) => q.eq("slug", args.researchSlug))
      .first();
    if (!project) throw new Error(`unknown project: ${args.researchSlug}`);
    const hosts = (project.hosts ?? []).filter((h) => h.machineId !== args.machineId);
    await ctx.db.patch(project._id, { hosts, updatedAt: Date.now() });
    return { removed: (project.hosts ?? []).length - hosts.length };
  },
});

export const listHosts = query({
  args: { researchSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const project = await ctx.db
      .query("researchProjects")
      .withIndex("by_slug", (q) => q.eq("slug", args.researchSlug))
      .first();
    return project?.hosts ?? [];
  },
});

export const hostFor = query({
  args: { researchSlug: v.string(), machineId: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const project = await ctx.db
      .query("researchProjects")
      .withIndex("by_slug", (q) => q.eq("slug", args.researchSlug))
      .first();
    return (project?.hosts ?? []).find((h) => h.machineId === args.machineId) ?? null;
  },
});
