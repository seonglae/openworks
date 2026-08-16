import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import { auth, withConvex } from "./harness.setup";

type T = ReturnType<typeof withConvex>;

const vec = (seed: number) => Array.from({ length: 384 }, (_, i) => ((seed * 31 + i) % 97) / 97);
// The width the active model produces; the 384 one is what legacy rows carry.
const wide = (seed: number) => Array.from({ length: 640 }, (_, i) => ((seed * 31 + i) % 97) / 97);

// A summary carrying its vector inline, which is the state the migration reads.
async function seedEmbeddedSummary(t: T, i: number) {
  return await t.run(async (ctx) => {
    const jobId = await ctx.db.insert("jobs", {
      url: `https://example.com/${i}`,
      type: "paper",
      status: "done",
      createdAt: Date.now(),
    });
    return await ctx.db.insert("summaries", {
      jobId,
      index: i,
      title: `paper ${i}`,
      url: `https://example.com/${i}`,
      summary: "\uBCF8\uBB38 \uC694\uC57D",
      keywords: ["a"],
      category: "Paper",
      embedding: vec(i),
      embeddedAt: Date.now(),
    });
  });
}

// Rows the worker has not reached yet: no vector, no stamp. These sort first on
// `by_embedded`, which is what made the first version of the migration stop early.
async function seedUnembeddedSummary(t: T, i: number) {
  return await t.run(async (ctx) => {
    const jobId = await ctx.db.insert("jobs", {
      url: `https://example.com/pending-${i}`,
      type: "paper",
      status: "done",
      createdAt: Date.now(),
    });
    return await ctx.db.insert("summaries", {
      jobId,
      index: i,
      title: `pending ${i}`,
      url: `https://example.com/pending-${i}`,
      summary: "\uC544\uC9C1 \uC784\uBCA0\uB529 \uC548 \uB428",
      keywords: [],
      category: "Paper",
    });
  });
}

async function drain(t: T) {
  let after: number | undefined = undefined;
  let moved = 0;
  for (let i = 0; i < 50; i++) {
    const r: { moved: number; nextAfter: number | null; done: boolean } = await t.mutation(
      api.embeddings.migrateInlineVectors,
      { table: "summaries", after, ...auth },
    );
    moved += r.moved;
    if (r.done) return moved;
    after = r.nextAfter ?? undefined;
  }
  throw new Error("migration did not converge");
}

describe("moving vectors out of the subject row", () => {
  it("upserts rather than accumulating when a row is re-embedded", async () => {
    const t = withConvex();
    const id = await seedUnembeddedSummary(t, 1);
    await t.mutation(api.embeddings.setEmbedding, {
      targetTable: "summaries",
      targetId: id,
      vec: vec(1),
      ...auth,
    });
    await t.mutation(api.embeddings.setEmbedding, {
      targetTable: "summaries",
      targetId: id,
      vec: vec(2),
      ...auth,
    });
    const rows = await t.run(async (ctx) => await ctx.db.query("embeddings").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].vec?.[1]).toBeCloseTo(vec(2)[1]);
  });

  it("keeps two models side by side for the same row", async () => {
    const t = withConvex();
    const id = await seedUnembeddedSummary(t, 1);
    for (const model of ["Xenova/all-MiniLM-L6-v2", "onnx-community/harrier-oss-v1-270m-ONNX"]) {
      await t.mutation(api.embeddings.setEmbedding, {
        model,
        targetTable: "summaries",
        targetId: id,
        vec: vec(1),
        ...auth,
      });
    }
    const rows = await t.run(async (ctx) => await ctx.db.query("embeddings").collect());
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.model)).size).toBe(2);
  });

  it("moves every embedded row even when unembedded ones are interleaved", async () => {
    const t = withConvex();
    // Unembedded first, so they lead in both creation and `by_embedded` order.
    for (let i = 0; i < 60; i++) await seedUnembeddedSummary(t, i);
    for (let i = 0; i < 60; i++) await seedEmbeddedSummary(t, i);

    const moved = await drain(t);
    expect(moved).toBe(60);

    const stored = await t.run(async (ctx) => await ctx.db.query("embeddings").collect());
    expect(stored).toHaveLength(60);
  });

  it("leaves no vector behind on the rows it migrated", async () => {
    const t = withConvex();
    for (let i = 0; i < 60; i++) await seedEmbeddedSummary(t, i);
    await drain(t);
    const withVector = await t.run(async (ctx) => {
      const rows = await ctx.db.query("summaries").collect();
      return rows.filter((r) => r.embedding !== undefined).length;
    });
    expect(withVector).toBe(0);
  });

  it("is safe to run twice", async () => {
    const t = withConvex();
    for (let i = 0; i < 10; i++) await seedEmbeddedSummary(t, i);
    await drain(t);
    const again = await drain(t);
    expect(again).toBe(0);
    const stored = await t.run(async (ctx) => await ctx.db.query("embeddings").collect());
    expect(stored).toHaveLength(10);
  });

  it("stamps the subject so the worker stops offering it", async () => {
    const t = withConvex();
    const id = await seedUnembeddedSummary(t, 1);

    const before = await t.query(api.embeddings.listSummariesToEmbed, { ...auth });
    expect(before.map((r) => r.id)).toContain(id);

    await t.mutation(api.embeddings.setEmbedding, {
      targetTable: "summaries",
      targetId: id,
      vec: vec(1),
      ...auth,
    });

    const after = await t.query(api.embeddings.listSummariesToEmbed, { ...auth });
    expect(after.map((r) => r.id)).not.toContain(id);
  });

  it("does not let a second model mark the active model's work as done", async () => {
    const t = withConvex();
    const id = await seedUnembeddedSummary(t, 1);
    await t.mutation(api.embeddings.setEmbedding, {
      model: "some/other-model",
      targetTable: "summaries",
      targetId: id,
      vec: vec(1),
      ...auth,
    });
    const pending = await t.query(api.embeddings.listSummariesToEmbed, { ...auth });
    expect(pending.map((r) => r.id)).toContain(id);
  });

  it("returns the subject's id from a search, not the embedding row's", async () => {
    const t = withConvex();
    const wanted = await seedUnembeddedSummary(t, 1);
    const other = await seedUnembeddedSummary(t, 2);
    await t.mutation(api.embeddings.setEmbedding, {
      targetTable: "summaries",
      targetId: wanted,
      vec: vec(1),
      ...auth,
    });
    await t.mutation(api.embeddings.setEmbedding, {
      targetTable: "summaries",
      targetId: other,
      vec: vec(50),
      ...auth,
    });

    const hits = await t.action(api.embeddings.searchSummariesByVector, { embedding: vec(1), limit: 2, ...auth });
    expect(hits[0]._id).toBe(wanted);
  });

  it("does not return one subject kind's vectors when searching another", async () => {
    const t = withConvex();
    const summaryId = await seedUnembeddedSummary(t, 1);
    const planId = await t.run(
      async (ctx) =>
        await ctx.db.insert("planItems", {
          planSlug: "p",
          title: "\uACC4\uD68D",
          date: "2026-08-07",
          kind: "todo",
          order: 0,
          done: false,
          tags: [],
        }),
    );
    await t.mutation(api.embeddings.setEmbedding, {
      targetTable: "summaries",
      targetId: summaryId,
      vec: vec(1),
      ...auth,
    });
    await t.mutation(api.embeddings.setEmbedding, {
      targetTable: "planItems",
      targetId: planId,
      vec: vec(1),
      ...auth,
    });

    const hits = await t.action(api.embeddings.searchSummariesByVector, { embedding: vec(1), limit: 10, ...auth });
    expect(hits.map((h) => h._id)).toEqual([summaryId]);
  });

  it("files a vector by its width and searches the matching index", async () => {
    const t = withConvex();
    const id = await seedUnembeddedSummary(t, 1);
    await t.mutation(api.embeddings.setEmbedding, {
      model: "wide/model",
      targetTable: "summaries",
      targetId: id,
      vec: wide(1),
      ...auth,
    });

    const row = await t.run(async (ctx) => (await ctx.db.query("embeddings").collect())[0]);
    expect(row.vec640).toHaveLength(640);
    expect(row.vec).toBeUndefined();
  });

  it("clears the narrow vector when a row is re-embedded by a wider model", async () => {
    const t = withConvex();
    const id = await seedUnembeddedSummary(t, 1);
    const args = { model: "m", targetTable: "summaries" as const, targetId: id, ...auth };
    await t.mutation(api.embeddings.setEmbedding, { ...args, vec: vec(1) });
    await t.mutation(api.embeddings.setEmbedding, { ...args, vec: wide(1) });

    const rows = await t.run(async (ctx) => await ctx.db.query("embeddings").collect());
    expect(rows).toHaveLength(1);
    // Leaving the 384 vector behind would let the old index keep answering with
    // a vector the model no longer produces.
    expect(rows[0].vec).toBeUndefined();
    expect(rows[0].vec640).toHaveLength(640);
  });

  it("refuses a width no index can answer for", async () => {
    const t = withConvex();
    const id = await seedUnembeddedSummary(t, 1);
    await expect(
      t.mutation(api.embeddings.setEmbedding, {
        targetTable: "summaries",
        targetId: id,
        vec: Array.from({ length: 512 }, () => 0.1),
        ...auth,
      }),
    ).rejects.toThrow(/512 dimensions/);
  });

  it("counts only the model asked for", async () => {
    const t = withConvex();
    const id = await seedUnembeddedSummary(t, 1);
    await t.mutation(api.embeddings.setEmbedding, {
      model: "model-a",
      targetTable: "summaries",
      targetId: id,
      vec: vec(1),
      ...auth,
    });
    const a = await t.query(api.embeddings.countEmbeddings, { model: "model-a", ...auth });
    const b = await t.query(api.embeddings.countEmbeddings, { model: "model-b", ...auth });
    expect(a.counts.summaries.n).toBe(1);
    expect(b.counts.summaries.n).toBe(0);
  });
});
