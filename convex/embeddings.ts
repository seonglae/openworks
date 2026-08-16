import { v } from "convex/values";
import { activeEmbedModel, embedScope, EMBED_TARGETS, type EmbedTarget } from "@openworks/domain";
import { action, mutation, query, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireOwner } from "./auth";

const targetValidator = v.union(v.literal("summaries"), v.literal("researchProjects"), v.literal("planItems"));

// The model this deployment searches with. Rows written by any other model
// stay in the table and are simply filtered out of search.
const activeModel = (): string => activeEmbedModel(process.env);

// A vector index fixes its dimensions, so a vector's width decides which field
// holds it and which index answers for it. An unrecognised width is refused at
// the write rather than stored somewhere no search will ever look.
type Slot = { field: "vec" | "vec640"; index: "by_vec" | "by_vec640" };
const WIDTHS: Record<number, Slot> = {
  384: { field: "vec", index: "by_vec" },
  640: { field: "vec640", index: "by_vec640" },
};

function slotFor(width: number): Slot {
  const slot = WIDTHS[width];
  if (!slot) {
    throw new Error(
      `no vector index for ${width} dimensions: add a field and a vectorIndex in schema.ts, since width cannot be configured`,
    );
  }
  return slot;
}

// Upsert one vector for one subject under one model. Re-embedding the same row
// with the same model replaces rather than accumulates, so a re-run after a
// crash is safe.
//
// It also stamps `embeddedAt` on the subject. That field is what the to-embed
// listings read to find work, and it is deliberately left on the subject rather
// than derived from this table: "has no row here" is an absence, and absence is
// not indexable, so deriving it would mean reading every subject to find the
// few that are pending.
export const setEmbedding = mutation({
  args: {
    model: v.optional(v.string()),
    targetTable: targetValidator,
    targetId: v.string(),
    vec: v.array(v.float64()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const model = args.model ?? activeModel();

    const existing = await ctx.db
      .query("embeddings")
      .withIndex("by_target_model", (q) =>
        q.eq("targetTable", args.targetTable).eq("targetId", args.targetId).eq("model", model),
      )
      .unique();

    const { field } = slotFor(args.vec.length);
    // Both width fields are cleared and the one matching this vector is set, so
    // re-embedding a row with a wider model cannot leave the narrow vector
    // behind for the old index to keep answering with.
    const widths = { vec: undefined, vec640: undefined, [field]: args.vec };

    const id = existing
      ? (await ctx.db.patch(existing._id, {
          ...widths,
          scope: embedScope(model, args.targetTable),
          createdAt: Date.now(),
        }),
        existing._id)
      : await ctx.db.insert("embeddings", {
          model,
          targetTable: args.targetTable,
          targetId: args.targetId,
          scope: embedScope(model, args.targetTable),
          ...widths,
          createdAt: Date.now(),
        });

    // Only the active model advances the queue. A second model backfilling the
    // corpus must not convince the worker that the model it searches with is
    // done.
    if (model === activeModel()) {
      const subjectId = ctx.db.normalizeId(args.targetTable, args.targetId);
      if (subjectId) await ctx.db.patch(subjectId, { embeddedAt: Date.now() });
    }
    return id;
  },
});

// Move the inline vectors into the side table and clear the originals, which is
// what takes the bytes off every future read of the subject row.
//
// It walks creation order rather than `by_embedded`. That index is keyed on
// `embeddedAt`, so unembedded rows (undefined) sort first and a page of them
// carries nothing to move: reading "this page moved nothing" as "the table is
// finished" would strand every embedded row behind them. Creation order also
// gives a cursor that survives the row being rewritten, which `embeddedAt`
// cannot once the vector it described is gone.
//
// Thread `after` back in from the previous call and stop when `done`. Safe to
// re-run: a vector already copied under this model is not copied twice.
export const migrateInlineVectors = mutation({
  args: {
    table: targetValidator,
    after: v.optional(v.number()),
    model: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const model = args.model ?? activeModel();
    const after = args.after;
    const rows = await ctx.db
      .query(args.table)
      .withIndex("by_creation_time", (q) => (after === undefined ? q : q.gt("_creationTime", after)))
      .take(50);

    let moved = 0;
    for (const r of rows) {
      if (r.embedding === undefined) continue;
      const already = await ctx.db
        .query("embeddings")
        .withIndex("by_target_model", (q) =>
          q
            .eq("targetTable", args.table)
            .eq("targetId", r._id as string)
            .eq("model", model),
        )
        .unique();
      if (!already) {
        await ctx.db.insert("embeddings", {
          model,
          targetTable: args.table,
          targetId: r._id as string,
          scope: embedScope(model, args.table),
          // Inline vectors predate the side table and are all 384-wide.
          vec: r.embedding,
          createdAt: Date.now(),
        });
      }
      await ctx.db.patch(r._id, { embedding: undefined });
      moved++;
    }

    const last = rows.length > 0 ? rows[rows.length - 1] : null;
    return {
      scanned: rows.length,
      moved,
      // Null rather than undefined: Convex drops undefined-valued properties on
      // serialize, which would take the field out of the caller's type.
      nextAfter: last ? last._creationTime : null,
      done: rows.length === 0,
    };
  },
});

// Put a table back in the worker's queue, one bounded page per call. Changing
// the active model is the reason this exists: the queue marker records "carries
// a vector from the model we search with", so a new model means every row is
// pending again. The previous model's vectors are left alone and keep answering
// until the replacements land.
//
// Walks creation order for the same reason the migration does: `by_embedded`
// puts already-pending rows first, so a page of them would look like nothing
// left to do.
export const requeueForActiveModel = mutation({
  args: { table: targetValidator, after: v.optional(v.number()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const after = args.after;
    const rows = await ctx.db
      .query(args.table)
      .withIndex("by_creation_time", (q) => (after === undefined ? q : q.gt("_creationTime", after)))
      .take(200);

    let cleared = 0;
    for (const r of rows) {
      if (r.embeddedAt === undefined) continue;
      await ctx.db.patch(r._id, { embeddedAt: undefined });
      cleared++;
    }
    const last = rows.length > 0 ? rows[rows.length - 1] : null;
    return { scanned: rows.length, cleared, nextAfter: last ? last._creationTime : null, done: rows.length === 0 };
  },
});

// Bounded on purpose. Convex has no count aggregate, so this reads the rows it
// counts, and those rows are the vectors themselves; an unbounded version of
// this diagnostic would cost more than the reads the side table just saved.
export const countEmbeddings = query({
  args: { model: v.optional(v.string()), cap: v.optional(v.number()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const model = args.model ?? activeModel();
    const cap = Math.min(args.cap ?? 500, 2000);
    const counts: Record<string, { n: number; atCap: boolean }> = {};
    for (const t of EMBED_TARGETS) {
      const rows = await ctx.db
        .query("embeddings")
        .withIndex("by_model_target", (q) => q.eq("model", model).eq("targetTable", t))
        .take(cap);
      counts[t] = { n: rows.length, atCap: rows.length === cap };
    }
    return { model, counts };
  },
});

// Resolve vector hits back to the rows they describe. A hit identifies an
// `embeddings` row, and every caller wants the subject, so this is the seam
// between the two.
// One subject's stored vector, used as the query vector for "what is like
// this". Reads the side table, so it keeps working once the inline field is
// gone.
export const vectorForSubject = internalQuery({
  args: { targetTable: targetValidator, targetId: v.string(), model: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("embeddings")
      .withIndex("by_target_model", (q) =>
        q
          .eq("targetTable", args.targetTable)
          .eq("targetId", args.targetId)
          .eq("model", args.model ?? activeEmbedModel(process.env)),
      )
      .unique();
    // Whichever width this model writes; only one of the two is ever set.
    return row ? (row.vec ?? row.vec640 ?? null) : null;
  },
});

export const subjectsOf = internalQuery({
  args: { ids: v.array(v.id("embeddings")) },
  handler: async (ctx, args) => {
    const out: { embeddingId: string; targetTable: string; targetId: string }[] = [];
    for (const id of args.ids) {
      const row = await ctx.db.get(id);
      if (row) {
        out.push({ embeddingId: row._id as string, targetTable: row.targetTable, targetId: row.targetId });
      }
    }
    return out;
  },
});

// Vector search over one kind of subject, under the active model. Returns
// subject ids and scores, so callers hydrate exactly as they did before.
async function searchSubjects(
  ctx: { vectorSearch: any; runQuery: any },
  target: EmbedTarget,
  vector: number[],
  limit: number,
): Promise<{ _id: string; _score: number }[]> {
  // The query vector's own width picks the index, so a search can never be run
  // against vectors of a different shape.
  const hits = await ctx.vectorSearch("embeddings", slotFor(vector.length).index, {
    vector,
    limit,
    filter: (q: { eq: (f: "scope", v: string) => unknown }) => q.eq("scope", embedScope(activeModel(), target)),
  });
  if (hits.length === 0) return [];
  const subjects = await ctx.runQuery(internal.embeddings.subjectsOf, {
    ids: hits.map((h: { _id: string }) => h._id),
  });
  const byEmbeddingId = new Map(subjects.map((s: { embeddingId: string; targetId: string }) => [s.embeddingId, s]));
  return hits
    .map((h: { _id: string; _score: number }) => {
      const s = byEmbeddingId.get(h._id) as { targetId: string } | undefined;
      return s ? { _id: s.targetId, _score: h._score } : null;
    })
    .filter((x: unknown): x is { _id: string; _score: number } => x !== null);
}

// To-embed listings read ONLY rows still missing their vector, via the
// by_embedded index (embeddedAt undefined = not yet embedded). Embedded rows
// carry a ~3KB vector each, so any listing that touches them burns megabytes
// per call; the index keeps the steady-state cost at (pending rows) bytes,
// i.e. ~zero once the backlog is drained. Legacy rows embedded before
// embeddedAt existed are stamped once by backfillEmbeddedAt.
const EMBED_BATCH = 64;

export const listResearchToEmbed = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const rows = await ctx.db
      .query("researchProjects")
      .withIndex("by_embedded", (q) => q.eq("embeddedAt", undefined))
      .take(EMBED_BATCH);
    return rows
      .filter((r) => !r.embedding)
      .map((r) => ({
        id: r._id,
        text: [r.title, r.notes ?? "", (r.keywords ?? []).join(" ")].join(". ").slice(0, 4000),
      }));
  },
});

export const listSummariesToEmbed = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const rows = await ctx.db
      .query("summaries")
      .withIndex("by_embedded", (q) => q.eq("embeddedAt", undefined))
      .take(EMBED_BATCH);
    return rows
      .filter((s) => !s.embedding)
      .map((s) => ({
        id: s._id,
        text: [s.title, s.summary, s.keywords.join(" ")].join(". ").slice(0, 4000),
      }));
  },
});

export const listPlanItemsToEmbed = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const rows = await ctx.db
      .query("planItems")
      .withIndex("by_embedded", (q) => q.eq("embeddedAt", undefined))
      .take(EMBED_BATCH);
    return rows
      .filter((it) => !it.embedding)
      .map((it) => ({
        id: it._id,
        text: [it.title, it.notes ?? "", it.tags.join(" ")].join(". ").slice(0, 2000),
      }));
  },
});

// One-time migration: stamp embeddedAt on legacy rows that already have their
// vector. Processes one bounded page per call (stays under the read limit);
// run repeatedly until every table reports done. Rows without a vector are
// left unstamped so the worker still finds them via the index.
export const backfillEmbeddedAt = mutation({
  args: {
    table: v.union(v.literal("summaries"), v.literal("researchProjects"), v.literal("planItems")),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const rows = await ctx.db
      .query(args.table)
      .withIndex("by_embedded", (q) => q.eq("embeddedAt", undefined))
      .take(200);
    let stamped = 0;
    for (const r of rows) {
      if (r.embedding) {
        await ctx.db.patch(r._id, { embeddedAt: Date.now() });
        stamped++;
      }
    }
    // done when a full scan of unstamped rows finds nothing left to stamp
    return { scanned: rows.length, stamped, done: stamped === 0 };
  },
});

// Vector search actions. All three go through the side table now, so the shape
// they return is unchanged but the id is the subject's, resolved from the hit.
export const searchSummariesByVector = action({
  args: { embedding: v.array(v.float64()), limit: v.optional(v.number()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ _id: string; _score: number }[]> => {
    await requireOwner(ctx, args.serviceKey);
    return await searchSubjects(ctx, "summaries", args.embedding, args.limit ?? 20);
  },
});

export const searchPlanItemsByVector = action({
  args: { embedding: v.array(v.float64()), limit: v.optional(v.number()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ _id: string; _score: number }[]> => {
    await requireOwner(ctx, args.serviceKey);
    return await searchSubjects(ctx, "planItems", args.embedding, args.limit ?? 20);
  },
});

export const searchResearchByVector = action({
  args: { embedding: v.array(v.float64()), limit: v.optional(v.number()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ _id: string; _score: number }[]> => {
    await requireOwner(ctx, args.serviceKey);
    return await searchSubjects(ctx, "researchProjects", args.embedding, args.limit ?? 10);
  },
});

// Hydrate vector search results
export const hydrateSummaries = query({
  args: { ids: v.array(v.id("summaries")), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const out = [];
    for (const id of args.ids) {
      const s = await ctx.db.get(id);
      if (s) out.push({ _id: s._id, jobId: s.jobId, title: s.title, keywords: s.keywords });
    }
    return out;
  },
});

export const hydratePlanItems = query({
  args: { ids: v.array(v.id("planItems")), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const out = [];
    for (const id of args.ids) {
      const it = await ctx.db.get(id);
      if (it) out.push({ _id: it._id, title: it.title, date: it.date, tags: it.tags });
    }
    return out;
  },
});

// One-shot: take research embedding, find related summaries + planItems
export const findRelatedForResearch = action({
  args: { researchId: v.id("researchProjects"), limit: v.optional(v.number()), serviceKey: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    // `type: string | null` rather than `type?: string`. Convex omits
    // undefined-valued properties when it serializes, so an optional-undefined
    // field disappears from the generated client type entirely and callers
    // cannot read it even though the value is sent.
    summaries: { jobId: string; title: string; keywords: string[]; score: number; type: string | null }[];
    planItems: { itemId: string; title: string; date: string; tags: string[]; score: number }[];
  }> => {
    await requireOwner(ctx, args.serviceKey);
    const vector = await ctx.runQuery(internal.embeddings.vectorForSubject, {
      targetTable: "researchProjects",
      targetId: args.researchId,
      model: activeModel(),
    });
    if (!vector) return { summaries: [], planItems: [] };

    const sumResults = await searchSubjects(ctx, "summaries", vector, args.limit ?? 15);
    const planResults = await searchSubjects(ctx, "planItems", vector, args.limit ?? 15);

    const sumIds = sumResults.map((r) => r._id as Id<"summaries">);
    const planIds = planResults.map((r) => r._id as Id<"planItems">);

    const sumDocs = await ctx.runQuery(internal.embeddings.bulkGetSummaries, { ids: sumIds });
    const planDocs = await ctx.runQuery(internal.embeddings.bulkGetPlanItems, { ids: planIds });

    const sumScored = sumResults
      .map((r) => {
        const doc = sumDocs.find((d) => d._id === r._id);
        if (!doc) return null;
        return {
          jobId: doc.jobId.toString(),
          title: doc.title,
          keywords: doc.keywords,
          score: r._score,
          type: doc.type,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const planScored = planResults
      .map((r) => {
        const doc = planDocs.find((d) => d._id === r._id);
        if (!doc) return null;
        return {
          itemId: doc._id.toString(),
          title: doc.title,
          date: doc.date,
          tags: doc.tags,
          score: r._score,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return { summaries: sumScored, planItems: planScored };
  },
});

export const getResearch = internalQuery({
  args: { researchId: v.id("researchProjects") },
  handler: async (ctx, args) => {
    const r = await ctx.db.get(args.researchId);
    return r ? { embedding: r.embedding } : null;
  },
});

export const bulkGetSummaries = internalQuery({
  args: { ids: v.array(v.id("summaries")) },
  handler: async (ctx, args) => {
    const out = [];
    for (const id of args.ids) {
      const s = await ctx.db.get(id);
      if (!s) continue;
      const job = await ctx.db.get(s.jobId);
      // `null`, not `undefined`: Convex drops undefined-valued properties when it
      // serializes, which takes the whole field out of the generated client type.
      out.push({ _id: s._id, jobId: s.jobId, title: s.title, keywords: s.keywords, type: job?.type ?? null });
    }
    return out;
  },
});

export const bulkGetPlanItems = internalQuery({
  args: { ids: v.array(v.id("planItems")) },
  handler: async (ctx, args) => {
    const out = [];
    for (const id of args.ids) {
      const it = await ctx.db.get(id);
      if (it) out.push({ _id: it._id, title: it.title, date: it.date, tags: it.tags });
    }
    return out;
  },
});
