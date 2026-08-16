import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";

const citationShape = {
  key: v.string(),
  title: v.optional(v.string()),
  authors: v.optional(v.array(v.string())),
  year: v.optional(v.string()),
  arxivId: v.optional(v.string()),
  doi: v.optional(v.string()),
  url: v.optional(v.string()),
  pdfRelPath: v.optional(v.string()),
  raw: v.optional(v.string()),
};

// Worker calls this after parsing the bib file. Upserts each row by
// (researchSlug, key); rows whose key disappears from the bib are removed
// so the citations list stays in sync with the file.
export const upsertBatch = mutation({
  args: {
    researchSlug: v.string(),
    items: v.array(v.object(citationShape)),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db
      .query("researchCitations")
      .withIndex("by_research", (q) => q.eq("researchSlug", args.researchSlug))
      .collect();
    const byKey = new Map(existing.map((c) => [c.key, c]));
    const incomingKeys = new Set(args.items.map((c) => c.key));
    const now = Date.now();

    let inserted = 0;
    let updated = 0;
    for (const inc of args.items) {
      const prev = byKey.get(inc.key);
      if (prev) {
        await ctx.db.patch(prev._id, { ...inc, syncedAt: now });
        updated++;
      } else {
        await ctx.db.insert("researchCitations", {
          researchSlug: args.researchSlug,
          ...inc,
          syncedAt: now,
        });
        inserted++;
      }
    }

    let removed = 0;
    for (const old of existing) {
      if (!incomingKeys.has(old.key)) {
        await ctx.db.delete(old._id);
        removed++;
      }
    }
    return { inserted, updated, removed };
  },
});

export const list = query({
  args: { researchSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const items = await ctx.db
      .query("researchCitations")
      .withIndex("by_research", (q) => q.eq("researchSlug", args.researchSlug))
      .collect();
    return items.sort((a, b) => (a.year ?? "").localeCompare(b.year ?? ""));
  },
});

export const get = query({
  args: { researchSlug: v.string(), key: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("researchCitations")
      .withIndex("by_research_key", (q) => q.eq("researchSlug", args.researchSlug).eq("key", args.key))
      .first();
  },
});

// Frontend triggers a promote — worker reads the PDF (if any), extracts text,
// then calls completePromote below. For citations without a PDF this skips
// straight to creating the paper row.
export const requestPromote = mutation({
  args: {
    researchSlug: v.string(),
    citationKey: v.string(),
    machineId: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const id = await ctx.db.insert("citationRequests", {
      kind: "promote",
      status: "pending",
      researchSlug: args.researchSlug,
      citationKey: args.citationKey,
      machineId: args.machineId,
      createdAt: Date.now(),
    });
    return { id };
  },
});

export const requestSync = mutation({
  args: { researchSlug: v.string(), machineId: v.optional(v.string()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const id = await ctx.db.insert("citationRequests", {
      kind: "sync",
      status: "pending",
      researchSlug: args.researchSlug,
      machineId: args.machineId,
      createdAt: Date.now(),
    });
    return { id };
  },
});

export const getRequest = query({
  args: { id: v.id("citationRequests"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db.get(args.id);
  },
});

export const latestForResearch = query({
  args: { researchSlug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const items = await ctx.db
      .query("citationRequests")
      .withIndex("by_research", (q) => q.eq("researchSlug", args.researchSlug))
      .order("desc")
      .take(1);
    return items[0] ?? null;
  },
});

// Worker side — poll, claim, complete.
export const getPendingRequest = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("citationRequests")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "pending"))
      .order("asc")
      .first();
  },
});

export const claimRequest = mutation({
  args: { id: v.id("citationRequests"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const req = await ctx.db.get(args.id);
    if (!req || req.status !== "pending") return null;
    await ctx.db.patch(args.id, { status: "done" });
    return req;
  },
});

export const completeRequest = mutation({
  args: {
    id: v.id("citationRequests"),
    status: v.union(v.literal("done"), v.literal("error")),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.id, {
      status: args.status,
      result: args.result,
      error: args.error,
      completedAt: Date.now(),
    });
  },
});

// Worker calls this after parsing the PDF for a single citation.
export const promoteToPaper = mutation({
  args: {
    researchSlug: v.string(),
    citationKey: v.string(),
    arxivId: v.optional(v.string()),
    title: v.string(),
    authors: v.array(v.string()),
    abstract: v.optional(v.string()),
    url: v.string(),
    pdfRelPath: v.optional(v.string()),
    fullText: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    // Dedupe: by_research + (arxivId or title) — if a paper for the same
    // arxivId already exists, update it instead of inserting a duplicate.
    const existing = await ctx.db
      .query("researchPapers")
      .withIndex("by_research", (q) => q.eq("researchSlug", args.researchSlug))
      .collect();
    const dup = existing.find(
      (p) => (args.arxivId && p.arxivId === args.arxivId) || (!args.arxivId && p.title === args.title),
    );
    const now = Date.now();
    if (dup) {
      await ctx.db.patch(dup._id, {
        arxivId: args.arxivId,
        title: args.title,
        authors: args.authors,
        abstract: args.abstract,
        url: args.url,
        source: "bibtex",
        pdfRelPath: args.pdfRelPath,
        fullText: args.fullText,
      });
      return { id: dup._id, created: false };
    }
    const id = await ctx.db.insert("researchPapers", {
      researchSlug: args.researchSlug,
      arxivId: args.arxivId,
      title: args.title,
      authors: args.authors,
      abstract: args.abstract,
      url: args.url,
      source: "bibtex",
      pdfRelPath: args.pdfRelPath,
      fullText: args.fullText,
      addedAt: now,
    });
    return { id, created: true };
  },
});
