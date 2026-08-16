import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import { auth, withConvex } from "./harness.setup";

async function seedJob(t: ReturnType<typeof withConvex>, type: "paper" | "article" | "newsletter") {
  return await t.run(async (ctx) =>
    ctx.db.insert("jobs", { url: `https://example.com/${type}`, type, status: "done", archived: false, createdAt: 1 }),
  );
}

describe("summary rollups on jobs", () => {
  it("counts summaries and collects paper scores", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, "paper");
    await t.mutation(api.summaries.addBatch, {
      ...auth,
      jobId,
      summaries: [
        {
          index: 0,
          title: "A",
          category: "c",
          summary: "s",
          keywords: [],
          url: "u",
          scores: {
            soundness: 5,
            originality: 5,
            experiments: 5,
            clarity: 5,
            impact: 5,
            significance: 5,
            overall: 7.5,
          },
        },
      ],
    });
    const job = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(job?.summaryCount).toBe(1);
    expect(job?.summaryScores).toEqual([7.5]);
  });

  it("ignores paper scores on a newsletter, because the rollup is keyed by job type", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, "newsletter");
    await t.mutation(api.summaries.addBatch, {
      ...auth,
      jobId,
      summaries: [
        { index: 0, title: "A", category: "c", summary: "s", keywords: [], url: "u" },
        { index: 1, title: "B", category: "c", summary: "s", keywords: [], url: "u" },
      ],
    });
    const job = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(job?.summaryCount).toBe(2);
    // Left unset rather than written as []: the sync skips a patch when nothing
    // changed, and a no-op write would invalidate every reactive query reading
    // this row. Readers treat missing as empty.
    expect(job?.summaryScores ?? []).toEqual([]);
  });

  it("recomputes rather than accumulates when summaries are removed", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, "paper");
    await t.mutation(api.summaries.addBatch, {
      ...auth,
      jobId,
      summaries: [{ index: 0, title: "A", category: "c", summary: "s", keywords: [], url: "u" }],
    });
    const summaryId = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("summaries")
        .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
        .collect();
      return rows[0]._id;
    });
    await t.mutation(api.summaries.remove, { ...auth, summaryId });
    const job = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(job?.summaryCount).toBe(0);
  });
});
