import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";

export const send = mutation({
  args: {
    jobId: v.id("jobs"),
    content: v.string(),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.insert("chats", {
      jobId: args.jobId,
      role: "user",
      content: args.content,
      createdAt: Date.now(),
      needsReply: true,
    });
  },
});

// Stamp provider onto the most recent assistant reply for a job. Worker calls
// this after the agent's reply lands, so the UI can show which model authored.
// One-shot backfill: stamp every assistant chat row missing `provider` with
// its job's provider as best guess (older chats predate the per-row field).
export const backfillProviderFromJob = mutation({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const rows = await ctx.db.query("chats").collect();
    let updated = 0;
    for (const r of rows) {
      if (r.role !== "assistant" || r.provider) continue;
      const job = await ctx.db.get(r.jobId);
      if (job?.provider) {
        await ctx.db.patch(r._id, { provider: job.provider });
        updated++;
      }
    }
    return { updated, total: rows.length };
  },
});

export const setProviderOnLatestReply = mutation({
  args: { jobId: v.id("jobs"), provider: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const all = await ctx.db
      .query("chats")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    const sorted = all.filter((c) => c.role === "assistant").sort((a, b) => b.createdAt - a.createdAt);
    if (sorted[0] && !sorted[0].provider) {
      await ctx.db.patch(sorted[0]._id, { provider: args.provider });
    }
  },
});

export const reply = mutation({
  args: {
    jobId: v.id("jobs"),
    content: v.string(),
    provider: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    // Clear needsReply on the user message
    const pending = await ctx.db
      .query("chats")
      .withIndex("by_needsReply", (q) => q.eq("needsReply", true))
      .collect();
    for (const msg of pending) {
      if (msg.jobId === args.jobId) {
        await ctx.db.patch(msg._id, { needsReply: false });
      }
    }
    await ctx.db.insert("chats", {
      jobId: args.jobId,
      role: "assistant",
      content: args.content,
      createdAt: Date.now(),
      ...(args.provider ? { provider: args.provider } : {}),
    });
  },
});

export const listByJob = query({
  args: { jobId: v.id("jobs"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("chats")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
  },
});

export const listByUrl = query({
  args: { url: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    // Find jobs with this URL via the by_url index. Previously this scanned
    // every row in `jobs` for each PR row's subscription — ~60% of the
    // project's database I/O came from this single function.
    const matchingJobs = await ctx.db
      .query("jobs")
      .withIndex("by_url", (q) => q.eq("url", args.url))
      .collect();
    if (matchingJobs.length === 0) return [];

    const allChats: { role: string; content: string; createdAt: number }[] = [];
    for (const job of matchingJobs) {
      const chats = await ctx.db
        .query("chats")
        .withIndex("by_jobId", (q) => q.eq("jobId", job._id))
        .collect();
      allChats.push(...chats.map((c) => ({ role: c.role, content: c.content, createdAt: c.createdAt })));
    }
    return allChats.sort((a, b) => a.createdAt - b.createdAt);
  },
});

export const getPending = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    // Find messages that need a reply using the index
    const needingReply = await ctx.db
      .query("chats")
      .withIndex("by_needsReply", (q) => q.eq("needsReply", true))
      .collect();
    if (needingReply.length === 0) return [];

    // Group by job and fetch full chat history for each
    const jobIds = [...new Set(needingReply.map((c) => c.jobId))];
    const result = [];
    for (const jobId of jobIds) {
      const messages = await ctx.db
        .query("chats")
        .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
        .collect();
      result.push({ jobId, messages: messages.sort((a, b) => a.createdAt - b.createdAt) });
    }
    return result;
  },
});
