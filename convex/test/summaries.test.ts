import { describe, expect, it } from "vitest";
import type { JobStatus, JobType } from "@openworks/domain";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { auth, withConvex } from "./harness.setup";

type T = ReturnType<typeof withConvex>;

type JobSeed = {
  url?: string;
  type?: JobType;
  status?: JobStatus;
  archived?: boolean;
  content?: string;
  title?: string;
  createdAt?: number;
};

async function seedJob(t: T, seed: JobSeed = {}) {
  return await t.run(async (ctx) =>
    ctx.db.insert("jobs", {
      url: seed.url ?? "https://example.com/job",
      type: seed.type ?? "paper",
      status: seed.status ?? "done",
      archived: seed.archived ?? false,
      createdAt: seed.createdAt ?? 1,
      ...(seed.content === undefined ? {} : { content: seed.content }),
      ...(seed.title === undefined ? {} : { title: seed.title }),
    }),
  );
}

// Pre-dates the `archived` flag: jobs:create has always written it, so only rows
// like this one are missing it.
async function seedLegacyJob(t: T, url: string, type: JobType = "paper") {
  return await t.run(async (ctx) => ctx.db.insert("jobs", { url, type, status: "done", createdAt: 1 }));
}

const paperScores = (overall: number) => ({
  soundness: 5,
  originality: 5,
  experiments: 5,
  clarity: 5,
  impact: 5,
  significance: 5,
  overall,
});

const articleScores = (overall: number) => ({
  evidence: 5,
  logic: 5,
  objectivity: 5,
  novelty: 5,
  clarity: 5,
  impact: 5,
  overall,
});

type SummaryInput = {
  index: number;
  title: string;
  category: string;
  summary: string;
  keywords: string[];
  url: string;
  researchLevel?: string;
  scores?: ReturnType<typeof paperScores>;
  articleScores?: ReturnType<typeof articleScores>;
  priorWork?: { citation: string; relation: string }[];
  reasoning?: string;
  tldr?: string[];
  provider?: string;
};

function row(index: number, overrides: Partial<SummaryInput> = {}): SummaryInput {
  return {
    index,
    title: `Title ${index}`,
    category: "cat",
    summary: `summary body ${index}`,
    keywords: [],
    url: `https://example.com/s/${index}`,
    ...overrides,
  };
}

async function readJob(t: T, jobId: Id<"jobs">) {
  return await t.run(async (ctx) => ctx.db.get(jobId));
}

async function summaryRows(t: T, jobId: Id<"jobs">) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("summaries")
      .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
      .collect(),
  );
}

async function summaryIdsByIndex(t: T, jobId: Id<"jobs">) {
  const rows = await summaryRows(t, jobId);
  return [...rows].sort((a, b) => a.index - b.index).map((r) => r._id);
}

async function scheduledPushes(t: T) {
  return await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
}

async function seedSuggestion(t: T, jobId: Id<"jobs">) {
  return await t.run(async (ctx) =>
    ctx.db.insert("suggestions", {
      jobId,
      summaryIndex: 0,
      topic: "topic",
      pageName: "page",
      pageId: "pid",
      pageUrl: "https://notion.so/pid",
      action: "append",
      content: "body",
      status: "pending",
    }),
  );
}

describe("score rollup on the parent job", () => {
  it("sorts rolled-up scores ascending regardless of the order the summaries arrive in", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.summaries.addBatch, {
      ...auth,
      jobId,
      summaries: [
        row(0, { scores: paperScores(9) }),
        row(1, { scores: paperScores(6) }),
        row(2, { scores: paperScores(7.5) }),
      ],
    });
    expect((await readJob(t, jobId))?.summaryScores).toEqual([6, 7.5, 9]);
  });

  it("re-derives the whole rollup when one summary is rescored", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.summaries.addBatch, {
      ...auth,
      jobId,
      summaries: [row(0, { scores: paperScores(9) }), row(1, { scores: paperScores(6) })],
    });
    const [first] = await summaryIdsByIndex(t, jobId);
    await t.mutation(api.summaries.patchScores, { ...auth, summaryId: first, scores: paperScores(2) });
    const job = await readJob(t, jobId);
    expect(job?.summaryScores).toEqual([2, 6]);
    expect(job?.summaryCount).toBe(2);
  });

  it("keeps the rollup intact when only the display order of the summaries changes", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.summaries.addBatch, {
      ...auth,
      jobId,
      summaries: [
        row(0, { scores: paperScores(9) }),
        row(1, { scores: paperScores(6) }),
        row(2, { scores: paperScores(7.5) }),
      ],
    });
    const ids = await summaryIdsByIndex(t, jobId);
    await t.run(async (ctx) => {
      await ctx.db.patch(ids[0], { index: 2 });
      await ctx.db.patch(ids[2], { index: 0 });
    });
    // deleteDuplicates is a no-op here (indexes are still unique) but it is the
    // cheapest public mutation that forces a fresh rollup.
    await t.mutation(api.summaries.deleteDuplicates, { ...auth, jobId });
    const job = await readJob(t, jobId);
    expect(job?.summaryScores).toEqual([6, 7.5, 9]);
    const listed = await t.query(api.summaries.listByJob, { ...auth, jobId });
    expect(listed.map((s) => s.title)).toEqual(["Title 2", "Title 1", "Title 0"]);
  });

  it("drops the scores of rows removed as duplicates", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.summaries.addBatch, {
      ...auth,
      jobId,
      summaries: [
        row(0, { scores: paperScores(9) }),
        row(0, { scores: paperScores(6) }),
        row(1, { scores: paperScores(7.5) }),
      ],
    });
    expect((await readJob(t, jobId))?.summaryScores).toEqual([6, 7.5, 9]);
    await t.mutation(api.summaries.deleteDuplicates, { ...auth, jobId });
    const job = await readJob(t, jobId);
    expect(job?.summaryCount).toBe(2);
    expect(job?.summaryScores).toEqual([7.5, 9]);
  });

  it("keeps the first inserted row for a repeated index and discards the later one", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.summaries.addBatch, {
      ...auth,
      jobId,
      summaries: [row(0, { title: "kept" }), row(0, { title: "dropped" })],
    });
    await t.mutation(api.summaries.deleteDuplicates, { ...auth, jobId });
    const rows = await summaryRows(t, jobId);
    expect(rows.map((r) => r.title)).toEqual(["kept"]);
  });

  it("leaves the rollup unset on a job that never had a summary write", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    const job = await readJob(t, jobId);
    expect(job?.summaryCount).toBeUndefined();
    expect(job?.summaryScores).toBeUndefined();
  });

  it("writes a zero count when an empty batch syncs a job that has no summaries", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.summaries.addBatch, { ...auth, jobId, summaries: [] });
    expect((await readJob(t, jobId))?.summaryCount).toBe(0);
  });

  it("empties the score list rather than leaving stale numbers when the last scored row goes", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.summaries.addBatch, { ...auth, jobId, summaries: [row(0, { scores: paperScores(9) })] });
    const [only] = await summaryIdsByIndex(t, jobId);
    await t.mutation(api.summaries.remove, { ...auth, summaryId: only });
    const job = await readJob(t, jobId);
    expect(job?.summaryCount).toBe(0);
    expect(job?.summaryScores).toEqual([]);
  });

  it("reads article rubric scores for article jobs and ignores the paper rubric on them", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { type: "article" });
    await t.mutation(api.summaries.addBatch, {
      ...auth,
      jobId,
      summaries: [row(0, { articleScores: articleScores(6.5), scores: paperScores(9) })],
    });
    expect((await readJob(t, jobId))?.summaryScores).toEqual([6.5]);
  });

  it("collects no scores for a pr-fix job because neither rubric applies to it", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { type: "pr-fix" });
    await t.mutation(api.summaries.addBatch, {
      ...auth,
      jobId,
      summaries: [row(0, { scores: paperScores(9), articleScores: articleScores(9) })],
    });
    const job = await readJob(t, jobId);
    expect(job?.summaryCount).toBe(1);
    expect(job?.summaryScores ?? []).toEqual([]);
  });

  it("carries a stale rubric until the next write when the job type changes underneath it", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.summaries.addBatch, { ...auth, jobId, summaries: [row(0, { scores: paperScores(9) })] });
    await t.run(async (ctx) => ctx.db.patch(jobId, { type: "newsletter" }));
    expect((await readJob(t, jobId))?.summaryScores).toEqual([9]);
    await t.mutation(api.summaries.deleteDuplicates, { ...auth, jobId });
    expect((await readJob(t, jobId))?.summaryScores).toEqual([]);
  });
});

describe("adding summaries", () => {
  it("appends a second batch instead of replacing the first", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.summaries.addBatch, { ...auth, jobId, summaries: [row(0)] });
    await t.mutation(api.summaries.addBatch, { ...auth, jobId, summaries: [row(0)] });
    expect((await summaryRows(t, jobId)).length).toBe(2);
    expect((await readJob(t, jobId))?.summaryCount).toBe(2);
  });

  it("rejects a score rubric that is missing a criterion", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    const broken = { soundness: 5, originality: 5, experiments: 5, clarity: 5, impact: 5, overall: 8 };
    await expect(
      t.mutation(api.summaries.addBatch, {
        ...auth,
        jobId,
        summaries: [{ ...row(0), scores: broken } as unknown as SummaryInput],
      }),
    ).rejects.toThrow();
  });

  it("rejects a summary whose keywords are not strings", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await expect(
      t.mutation(api.summaries.addBatch, {
        ...auth,
        jobId,
        summaries: [{ ...row(0), keywords: [1, 2] } as unknown as SummaryInput],
      }),
    ).rejects.toThrow();
  });
});

describe("stamping the completing provider onto a job's summaries", () => {
  it("fills only the rows that have no provider yet", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.summaries.addBatch, {
      ...auth,
      jobId,
      summaries: [row(0, { provider: "gemini" }), row(1)],
    });
    await t.mutation(api.summaries.setProviderForJob, { ...auth, jobId, provider: "claude" });
    const rows = await summaryRows(t, jobId);
    expect(rows.map((r) => r.provider)).toEqual(["gemini", "claude"]);
  });

  it("does not reach into another job's summaries", async () => {
    const t = withConvex();
    const mine = await seedJob(t);
    const theirs = await seedJob(t, { url: "https://example.com/other" });
    await t.mutation(api.summaries.addBatch, { ...auth, jobId: mine, summaries: [row(0)] });
    await t.mutation(api.summaries.addBatch, { ...auth, jobId: theirs, summaries: [row(0)] });
    await t.mutation(api.summaries.setProviderForJob, { ...auth, jobId: mine, provider: "codex" });
    expect((await summaryRows(t, theirs))[0].provider).toBeUndefined();
  });
});

describe("rescoring an existing summary", () => {
  it("leaves the summary prose untouched while stamping the structured fields", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.summaries.addBatch, { ...auth, jobId, summaries: [row(0, { summary: "original prose" })] });
    const [id] = await summaryIdsByIndex(t, jobId);
    await t.mutation(api.summaries.patchScores, {
      ...auth,
      summaryId: id,
      scores: paperScores(7),
      researchLevel: "strong",
      tldr: ["a", "b", "c"],
    });
    const patched = (await summaryRows(t, jobId))[0];
    expect(patched.summary).toBe("original prose");
    expect(patched.researchLevel).toBe("strong");
    expect(patched.tldr).toEqual(["a", "b", "c"]);
  });

  it("does nothing at all when every optional field is omitted", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.summaries.addBatch, { ...auth, jobId, summaries: [row(0, { researchLevel: "weak" })] });
    const [id] = await summaryIdsByIndex(t, jobId);
    await t.mutation(api.summaries.patchScores, { ...auth, summaryId: id });
    expect((await summaryRows(t, jobId))[0].researchLevel).toBe("weak");
  });

  it("cannot clear a previously set field, because omitted means unchanged", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.summaries.addBatch, { ...auth, jobId, summaries: [row(0, { scores: paperScores(9) })] });
    const [id] = await summaryIdsByIndex(t, jobId);
    await t.mutation(api.summaries.patchScores, { ...auth, summaryId: id, researchLevel: "strong" });
    expect((await summaryRows(t, jobId))[0].scores?.overall).toBe(9);
  });
});

describe("recommend notifications", () => {
  it("queues one push and marks the job when a paper reaches the recommend threshold", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { title: "Great Paper" });
    await t.mutation(api.summaries.addBatch, { ...auth, jobId, summaries: [row(0)] });
    const [id] = await summaryIdsByIndex(t, jobId);
    await t.mutation(api.summaries.patchScores, { ...auth, summaryId: id, scores: paperScores(8) });
    expect((await readJob(t, jobId))?.recommendedNotifiedAt).toBeTypeOf("number");
    const pushes = await scheduledPushes(t);
    expect(pushes.length).toBe(1);
    expect(pushes[0].name).toBe("pushNode:broadcast");
    expect(pushes[0].args[0]).toMatchObject({ title: "Recommended paper · 8.0", body: "Great Paper" });
  });

  it("stays quiet below the threshold", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.summaries.addBatch, { ...auth, jobId, summaries: [row(0)] });
    const [id] = await summaryIdsByIndex(t, jobId);
    await t.mutation(api.summaries.patchScores, { ...auth, summaryId: id, scores: paperScores(7.9) });
    expect((await readJob(t, jobId))?.recommendedNotifiedAt).toBeUndefined();
    expect((await scheduledPushes(t)).length).toBe(0);
  });

  it("notifies once no matter how many times the paper is rescored high", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.summaries.addBatch, { ...auth, jobId, summaries: [row(0)] });
    const [id] = await summaryIdsByIndex(t, jobId);
    await t.mutation(api.summaries.patchScores, { ...auth, summaryId: id, scores: paperScores(9) });
    await t.mutation(api.summaries.patchScores, { ...auth, summaryId: id, scores: paperScores(9.5) });
    expect((await scheduledPushes(t)).length).toBe(1);
  });

  it("stays quiet for an archived job even at a top score", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { archived: true });
    await t.mutation(api.summaries.addBatch, { ...auth, jobId, summaries: [row(0)] });
    const [id] = await summaryIdsByIndex(t, jobId);
    await t.mutation(api.summaries.patchScores, { ...auth, summaryId: id, scores: paperScores(10) });
    expect((await readJob(t, jobId))?.recommendedNotifiedAt).toBeUndefined();
    expect((await scheduledPushes(t)).length).toBe(0);
  });

  it("stays quiet for a newsletter, which has no recommend surface", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { type: "newsletter" });
    await t.mutation(api.summaries.addBatch, { ...auth, jobId, summaries: [row(0)] });
    const [id] = await summaryIdsByIndex(t, jobId);
    await t.mutation(api.summaries.patchScores, { ...auth, summaryId: id, scores: paperScores(10) });
    expect((await scheduledPushes(t)).length).toBe(0);
  });

  it("notifies on an article using its own rubric and deep-links to the job", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { type: "article", url: "https://news.example/story" });
    await t.mutation(api.summaries.addBatch, { ...auth, jobId, summaries: [row(0)] });
    const [id] = await summaryIdsByIndex(t, jobId);
    await t.mutation(api.summaries.patchScores, { ...auth, summaryId: id, articleScores: articleScores(9) });
    const pushes = await scheduledPushes(t);
    expect(pushes.length).toBe(1);
    expect(pushes[0].args[0]).toMatchObject({
      title: "Recommended article · 9.0",
      body: "https://news.example/story",
      url: `/?item=${jobId}`,
    });
  });
});

describe("link repair patches", () => {
  it("rewrites only the body and the url", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.summaries.addBatch, { ...auth, jobId, summaries: [row(0, { title: "keep me" })] });
    const [id] = await summaryIdsByIndex(t, jobId);
    await t.mutation(api.summaries.patchLinks, {
      ...auth,
      summaryId: id,
      summary: "cleaned body",
      url: "https://example.com/live",
    });
    const patched = (await summaryRows(t, jobId))[0];
    expect(patched.summary).toBe("cleaned body");
    expect(patched.url).toBe("https://example.com/live");
    expect(patched.title).toBe("keep me");
  });

  it("accepts a call with nothing to patch and leaves the row alone", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.summaries.addBatch, { ...auth, jobId, summaries: [row(0)] });
    const [id] = await summaryIdsByIndex(t, jobId);
    await t.mutation(api.summaries.patchLinks, { ...auth, summaryId: id });
    expect((await summaryRows(t, jobId))[0].summary).toBe("summary body 0");
  });
});

describe("removing a summary", () => {
  it("treats a second delete of the same row as a quiet no-op", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.summaries.addBatch, { ...auth, jobId, summaries: [row(0), row(1)] });
    const [first] = await summaryIdsByIndex(t, jobId);
    await t.mutation(api.summaries.remove, { ...auth, summaryId: first });
    await expect(t.mutation(api.summaries.remove, { ...auth, summaryId: first })).resolves.toBeNull();
    expect((await summaryRows(t, jobId)).map((r) => r.index)).toEqual([1]);
    expect((await readJob(t, jobId))?.summaryCount).toBe(1);
  });
});

describe("listing a job's summaries", () => {
  it("returns them ordered by index, not by insertion time", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.summaries.addBatch, { ...auth, jobId, summaries: [row(2), row(0), row(1)] });
    const listed = await t.query(api.summaries.listByJob, { ...auth, jobId });
    expect(listed.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it("returns an empty list for a job that has no summaries", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    expect(await t.query(api.summaries.listByJob, { ...auth, jobId })).toEqual([]);
  });
});

describe("finding similar articles", () => {
  // The seed-job form of findSimilar builds its query from the source titles and
  // keywords, so the title has to carry the same words the summary does.
  async function seedArticle(t: T, url: string, summary: string, keywords: string[]) {
    const jobId = await seedJob(t, { url });
    await t.mutation(api.summaries.addBatch, {
      ...auth,
      jobId,
      summaries: [row(0, { summary, keywords, title: summary })],
    });
    return jobId;
  }

  it("returns nothing when neither a query nor a seed job is supplied", async () => {
    const t = withConvex();
    await seedArticle(t, "https://a", "sparse autoencoder features", ["sae"]);
    expect(await t.query(api.summaries.findSimilar, { ...auth })).toEqual([]);
  });

  it("returns nothing when the seed job has no summaries to build a query from", async () => {
    const t = withConvex();
    const empty = await seedJob(t, { url: "https://empty" });
    expect(await t.query(api.summaries.findSimilar, { ...auth, jobId: empty })).toEqual([]);
  });

  it("never returns the seed job itself", async () => {
    const t = withConvex();
    const seed = await seedArticle(t, "https://seed", "sparse autoencoder features on transformers", ["sae"]);
    const other = await seedArticle(t, "https://other", "sparse autoencoder features on transformers", ["sae"]);
    const hits = await t.query(api.summaries.findSimilar, { ...auth, jobId: seed });
    expect(hits.map((h) => h.jobId)).toEqual([other.toString()]);
  });

  it("collapses several matching summaries of one job into a single entry", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { url: "https://multi" });
    await t.mutation(api.summaries.addBatch, {
      ...auth,
      jobId,
      summaries: [
        row(0, { summary: "sparse autoencoder features", keywords: ["sae"] }),
        row(1, { summary: "sparse autoencoder probes", keywords: ["sae"] }),
      ],
    });
    const hits = await t.query(api.summaries.findSimilar, { ...auth, query: "sparse autoencoder" });
    expect(hits.length).toBe(1);
    expect(hits[0].jobId).toBe(jobId.toString());
  });

  it("clamps a limit of zero up to one result", async () => {
    const t = withConvex();
    await seedArticle(t, "https://a", "sparse autoencoder features", ["sae"]);
    await seedArticle(t, "https://b", "sparse autoencoder probes", ["sae"]);
    const hits = await t.query(api.summaries.findSimilar, { ...auth, query: "sparse autoencoder", limit: 0 });
    expect(hits.length).toBe(1);
  });

  it("leaves out jobs whose summaries share no terms with the query", async () => {
    const t = withConvex();
    const ml = await seedArticle(t, "https://ml", "sparse autoencoder features on transformers", ["sae"]);
    await seedArticle(t, "https://food", "how to bake sourdough bread at home", ["bread"]);
    const hits = await t.query(api.summaries.findSimilar, { ...auth, query: "sparse autoencoder" });
    expect(hits.map((h) => h.jobId)).toEqual([ml.toString()]);
  });
});

describe("score distribution", () => {
  it("reports empty rubrics as null bounds rather than infinities", async () => {
    const t = withConvex();
    expect(await t.query(api.summaries.scoreStats, { ...auth })).toEqual({
      paper: { count: 0, min: null, max: null, sum: 0, buckets: {} },
      article: { count: 0, min: null, max: null, sum: 0, buckets: {} },
    });
  });

  it("bins overall scores into half-point buckets per rubric", async () => {
    const t = withConvex();
    const paperJob = await seedJob(t);
    await t.mutation(api.summaries.addBatch, {
      ...auth,
      jobId: paperJob,
      summaries: [
        row(0, { scores: paperScores(7.5) }),
        row(1, { scores: paperScores(7.25) }),
        row(2, { scores: paperScores(8) }),
      ],
    });
    const articleJob = await seedJob(t, { type: "article", url: "https://article" });
    await t.mutation(api.summaries.addBatch, {
      ...auth,
      jobId: articleJob,
      summaries: [row(0, { articleScores: articleScores(6.5) })],
    });
    const stats = await t.query(api.summaries.scoreStats, { ...auth });
    expect(stats.paper).toEqual({
      count: 3,
      min: 7.25,
      max: 8,
      sum: 22.75,
      buckets: { "7.0": 1, "7.5": 1, "8.0": 1 },
    });
    expect(stats.article).toEqual({ count: 1, min: 6.5, max: 6.5, sum: 6.5, buckets: { "6.5": 1 } });
  });

  it("splits the distribution by archived state so the two never mix", async () => {
    const t = withConvex();
    const live = await seedJob(t);
    await t.mutation(api.summaries.addBatch, { ...auth, jobId: live, summaries: [row(0, { scores: paperScores(9) })] });
    const filed = await seedJob(t, { archived: true, url: "https://filed" });
    await t.mutation(api.summaries.addBatch, {
      ...auth,
      jobId: filed,
      summaries: [row(0, { scores: paperScores(4) })],
    });
    expect((await t.query(api.summaries.scoreStats, { ...auth })).paper.count).toBe(1);
    const archived = await t.query(api.summaries.scoreStats, { ...auth, archived: true });
    expect(archived.paper).toMatchObject({ count: 1, min: 4, max: 4 });
  });

  it("counts a job whose archived flag was never written on the unarchived side", async () => {
    const t = withConvex();
    const legacy = await seedLegacyJob(t, "https://legacy");
    await t.mutation(api.summaries.addBatch, {
      ...auth,
      jobId: legacy,
      summaries: [row(0, { scores: paperScores(9) })],
    });
    expect((await readJob(t, legacy))?.summaryScores).toEqual([9]);
    // An unwritten flag equals neither false nor true on the index, so the row
    // only shows up if the unarchived read covers the undefined key too.
    expect((await t.query(api.summaries.scoreStats, { ...auth })).paper).toMatchObject({ count: 1, min: 9, max: 9 });
    expect((await t.query(api.summaries.scoreStats, { ...auth, archived: true })).paper.count).toBe(0);
  });

  it("keeps the flagless rows out of the archived side while still splitting the two", async () => {
    const t = withConvex();
    const legacy = await seedLegacyJob(t, "https://legacy");
    await t.mutation(api.summaries.addBatch, {
      ...auth,
      jobId: legacy,
      summaries: [row(0, { scores: paperScores(9) })],
    });
    const filed = await seedJob(t, { archived: true, url: "https://filed" });
    await t.mutation(api.summaries.addBatch, {
      ...auth,
      jobId: filed,
      summaries: [row(0, { scores: paperScores(4) })],
    });
    const live = await seedJob(t, { url: "https://live" });
    await t.mutation(api.summaries.addBatch, { ...auth, jobId: live, summaries: [row(0, { scores: paperScores(7) })] });
    expect((await t.query(api.summaries.scoreStats, { ...auth })).paper).toMatchObject({ count: 2, min: 7, max: 9 });
    expect((await t.query(api.summaries.scoreStats, { ...auth, archived: true })).paper).toMatchObject({
      count: 1,
      min: 4,
      max: 4,
    });
  });

  it("also rescues a flagless article, not just papers", async () => {
    const t = withConvex();
    const legacy = await seedLegacyJob(t, "https://legacy/article", "article");
    await t.mutation(api.summaries.addBatch, {
      ...auth,
      jobId: legacy,
      summaries: [row(0, { articleScores: articleScores(6) })],
    });
    expect((await t.query(api.summaries.scoreStats, { ...auth })).article).toMatchObject({ count: 1, min: 6, max: 6 });
  });
});

const MISMATCH_CONTENT =
  "alpha appears here but the rest of this pasted text is about sourdough bread, flour and water hydration ratios";
const MATCHING_CONTENT =
  "sparse autoencoders recover interpretable features from transformer residual streams across several model scales";

describe("detecting summaries written against the wrong paste", () => {
  it("flags a paper whose title shares almost no vocabulary with its content", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, {
      title: "Quantum Chromodynamics Lattice Simulations",
      content: MISMATCH_CONTENT,
    });
    await t.mutation(api.summaries.addBatch, { ...auth, jobId, summaries: [row(0)] });
    const flagged = await t.query(api.summaries.previewMismatched, { ...auth });
    expect(flagged.length).toBe(1);
    expect(flagged[0]).toMatchObject({ jobId: jobId.toString(), overlap: 0, titleTokens: 4, ratio: 0 });
  });

  it("leaves a paper alone when its title vocabulary shows up in the content", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, {
      title: "Sparse Autoencoders Recover Interpretable Features",
      content: MATCHING_CONTENT,
    });
    await t.mutation(api.summaries.addBatch, { ...auth, jobId, summaries: [row(0)] });
    expect(await t.query(api.summaries.previewMismatched, { ...auth })).toEqual([]);
  });

  it("puts the most confident mismatch first", async () => {
    const t = withConvex();
    const partial = await seedJob(t, { title: "Alpha Bravo Charlie Delta", content: MISMATCH_CONTENT });
    const total = await seedJob(t, {
      url: "https://example.com/total",
      title: "Quantum Chromodynamics Lattice Simulations",
      content: MISMATCH_CONTENT,
    });
    await t.mutation(api.summaries.addBatch, { ...auth, jobId: partial, summaries: [row(0)] });
    await t.mutation(api.summaries.addBatch, { ...auth, jobId: total, summaries: [row(0)] });
    const flagged = await t.query(api.summaries.previewMismatched, { ...auth });
    expect(flagged.map((f) => f.jobId)).toEqual([total.toString(), partial.toString()]);
    expect(flagged[1].ratio).toBeCloseTo(0.25);
  });

  it("skips a paper that has no summaries to judge", async () => {
    const t = withConvex();
    await seedJob(t, { title: "Quantum Chromodynamics Lattice Simulations", content: MISMATCH_CONTENT });
    expect(await t.query(api.summaries.previewMismatched, { ...auth })).toEqual([]);
  });

  it("skips a paper whose stored content is too short to compare against", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { title: "Quantum Chromodynamics Lattice", content: "too short" });
    await t.mutation(api.summaries.addBatch, { ...auth, jobId, summaries: [row(0)] });
    expect(await t.query(api.summaries.previewMismatched, { ...auth })).toEqual([]);
  });

  it("falls back to the lowest-index summary title, not the first row inserted", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { content: MISMATCH_CONTENT });
    // Written out of order, so insertion order and summary order disagree: the
    // probe has to be index 0 even though index 1 landed in the table first.
    await t.mutation(api.summaries.addBatch, {
      ...auth,
      jobId,
      summaries: [row(1, { title: "alpha bravo" }), row(0, { title: "Quantum Chromodynamics Lattice Simulations" })],
    });
    const flagged = await t.query(api.summaries.previewMismatched, { ...auth });
    expect(flagged.length).toBe(1);
    expect(flagged[0]).toMatchObject({ summaryTitle: "Quantum Chromodynamics Lattice Simulations", ratio: 0 });
  });

  it("ignores an article job, because the scan is scoped to papers", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, {
      type: "article",
      title: "Quantum Chromodynamics Lattice Simulations",
      content: MISMATCH_CONTENT,
    });
    await t.mutation(api.summaries.addBatch, { ...auth, jobId, summaries: [row(0)] });
    expect(await t.query(api.summaries.previewMismatched, { ...auth })).toEqual([]);
  });
});

describe("reconciling mismatched papers", () => {
  it("wipes the summaries and suggestions of a mismatch and requeues the job from scratch", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, {
      title: "Quantum Chromodynamics Lattice Simulations",
      content: MISMATCH_CONTENT,
      archived: true,
    });
    // Out of insertion order on purpose: the reported title is the job's leading
    // summary, which is index 0, not whichever row was written first.
    await t.mutation(api.summaries.addBatch, {
      ...auth,
      jobId,
      summaries: [
        row(1, { title: "Second", scores: paperScores(4) }),
        row(0, { title: "First", scores: paperScores(9) }),
      ],
    });
    await seedSuggestion(t, jobId);
    const result = await t.mutation(api.summaries.reconcileMismatched, { ...auth });
    expect(result.count).toBe(1);
    expect(result.fixed[0].oldSummaryTitle).toBe("First");
    const job = await readJob(t, jobId);
    expect(job).toMatchObject({ status: "pending", archived: false, summaryCount: 0 });
    expect(job?.title).toBeUndefined();
    expect(job?.summaryScores).toEqual([]);
    expect(await summaryRows(t, jobId)).toEqual([]);
    expect(await t.query(api.suggestions.listByJob, { ...auth, jobId })).toEqual([]);
  });

  it("leaves a matching paper and its suggestions completely alone", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, {
      title: "Sparse Autoencoders Recover Interpretable Features",
      content: MATCHING_CONTENT,
    });
    await t.mutation(api.summaries.addBatch, { ...auth, jobId, summaries: [row(0)] });
    await seedSuggestion(t, jobId);
    expect((await t.mutation(api.summaries.reconcileMismatched, { ...auth })).count).toBe(0);
    expect((await summaryRows(t, jobId)).length).toBe(1);
    expect((await t.query(api.suggestions.listByJob, { ...auth, jobId })).length).toBe(1);
  });
});

describe("restoring archived state after a blanket unarchive", () => {
  it("re-archives every pending paper except the kept ones", async () => {
    const t = withConvex();
    const keep = await seedJob(t, { status: "pending" });
    const drop = await seedJob(t, { status: "pending", url: "https://example.com/drop" });
    const other = await seedJob(t, { status: "pending", type: "newsletter", url: "https://example.com/nl" });
    const done = await seedJob(t, { status: "done", url: "https://example.com/done" });
    const result = await t.mutation(api.summaries.restoreArchiveExcept, { ...auth, keepIds: [keep] });
    expect(result).toEqual({ rearchived: 1 });
    expect(await readJob(t, drop)).toMatchObject({ archived: true, status: "done" });
    expect(await readJob(t, keep)).toMatchObject({ archived: false, status: "pending" });
    expect(await readJob(t, other)).toMatchObject({ archived: false, status: "pending" });
    expect(await readJob(t, done)).toMatchObject({ archived: false, status: "done" });
  });
});

describe("bulk restore from a recovery payload", () => {
  it("replaces existing summaries instead of stacking on top of them", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { status: "pending" });
    await t.mutation(api.summaries.addBatch, {
      ...auth,
      jobId,
      summaries: [row(0, { scores: paperScores(9) }), row(1, { scores: paperScores(4) })],
    });
    const result = await t.mutation(api.summaries.restoreBulk, {
      ...auth,
      entries: [
        {
          jobId,
          title: "Recovered Title",
          summaries: [{ index: 0, title: "R0", category: "cat", summary: "restored", keywords: ["k"], url: "u" }],
        },
      ],
    });
    expect(result).toEqual({ restored: 1, summariesInserted: 1 });
    const rows = await summaryRows(t, jobId);
    expect(rows.map((r) => r.title)).toEqual(["R0"]);
    const job = await readJob(t, jobId);
    expect(job).toMatchObject({ status: "suggested", title: "Recovered Title", summaryCount: 1 });
    // The payload carries no rubric, so the rollup has to shed the old scores.
    expect(job?.summaryScores).toEqual([]);
  });

  it("keeps the existing title when the entry does not carry one", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { title: "Kept Title" });
    await t.mutation(api.summaries.restoreBulk, {
      ...auth,
      entries: [
        { jobId, summaries: [{ index: 0, title: "R0", category: "cat", summary: "s", keywords: [], url: "u" }] },
      ],
    });
    expect((await readJob(t, jobId))?.title).toBe("Kept Title");
  });

  it("skips an entry whose job has been deleted", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.run(async (ctx) => ctx.db.delete(jobId));
    const result = await t.mutation(api.summaries.restoreBulk, {
      ...auth,
      entries: [
        { jobId, summaries: [{ index: 0, title: "R0", category: "cat", summary: "s", keywords: [], url: "u" }] },
      ],
    });
    expect(result).toEqual({ restored: 0, summariesInserted: 0 });
  });
});

describe("bulk resets of paste-mode papers", () => {
  it("resets only unarchived papers that carry real pasted content", async () => {
    const t = withConvex();
    const live = await seedJob(t, { content: MATCHING_CONTENT, status: "done" });
    const thin = await seedJob(t, { content: "short", url: "https://example.com/thin" });
    const filed = await seedJob(t, { content: MATCHING_CONTENT, archived: true, url: "https://example.com/filed" });
    await t.mutation(api.summaries.addBatch, { ...auth, jobId: live, summaries: [row(0, { scores: paperScores(9) })] });
    await seedSuggestion(t, live);
    await t.mutation(api.summaries.addBatch, { ...auth, jobId: filed, summaries: [row(0)] });
    const result = await t.mutation(api.summaries.resetUnarchivedPastePapers, { ...auth });
    expect(result).toEqual({ touched: 1, summariesDeleted: 1, suggestionsDeleted: 1 });
    expect(await readJob(t, live)).toMatchObject({ status: "pending", summaryCount: 0 });
    expect((await readJob(t, live))?.summaryScores).toEqual([]);
    expect((await summaryRows(t, filed)).length).toBe(1);
    expect(await readJob(t, thin)).toMatchObject({ status: "done" });
  });

  it("unarchives the archived papers it resets so they come back into the queue", async () => {
    const t = withConvex();
    const filed = await seedJob(t, { content: MATCHING_CONTENT, archived: true });
    await t.mutation(api.summaries.addBatch, { ...auth, jobId: filed, summaries: [row(0), row(1)] });
    const result = await t.mutation(api.summaries.resetArchivedPastePapers, { ...auth });
    expect(result).toEqual({ touched: 1, summariesDeleted: 2, suggestionsDeleted: 0 });
    expect(await readJob(t, filed)).toMatchObject({ status: "pending", archived: false, summaryCount: 0 });
  });

  it("resets exactly the listed jobs and leaves their neighbours alone", async () => {
    const t = withConvex();
    const target = await seedJob(t, { archived: true });
    const bystander = await seedJob(t, { url: "https://example.com/bystander" });
    await t.mutation(api.summaries.addBatch, { ...auth, jobId: target, summaries: [row(0)] });
    await seedSuggestion(t, target);
    await t.mutation(api.summaries.addBatch, { ...auth, jobId: bystander, summaries: [row(0)] });
    const result = await t.mutation(api.summaries.resetByIds, { ...auth, jobIds: [target] });
    expect(result).toEqual({ count: 1, summariesDeleted: 1, suggestionsDeleted: 1 });
    expect(await readJob(t, target)).toMatchObject({ status: "pending", archived: false });
    expect((await summaryRows(t, bystander)).length).toBe(1);
  });

  it("counts a requested id it could not find, so the count is not a success count", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.run(async (ctx) => ctx.db.delete(jobId));
    expect(await t.mutation(api.summaries.resetByIds, { ...auth, jobIds: [jobId] })).toEqual({
      count: 1,
      summariesDeleted: 0,
      suggestionsDeleted: 0,
    });
  });

  it("reports what a full reset would touch without mutating anything on a dry run", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { content: MATCHING_CONTENT, archived: true, status: "done" });
    await t.mutation(api.summaries.addBatch, { ...auth, jobId, summaries: [row(0), row(1)] });
    await seedSuggestion(t, jobId);
    const result = await t.mutation(api.summaries.resetAllPastePapers, { ...auth, dryRun: true });
    expect(result).toEqual({ jobsTouched: 1, summariesDeleted: 2, suggestionsDeleted: 1, dryRun: true });
    expect((await summaryRows(t, jobId)).length).toBe(2);
    expect(await readJob(t, jobId)).toMatchObject({ status: "done", archived: true });
  });

  it("wipes and requeues archived and unarchived paste papers alike on a real run", async () => {
    const t = withConvex();
    const filed = await seedJob(t, { content: MATCHING_CONTENT, archived: true });
    const live = await seedJob(t, { content: MATCHING_CONTENT, url: "https://example.com/live" });
    await t.mutation(api.summaries.addBatch, { ...auth, jobId: filed, summaries: [row(0)] });
    await t.mutation(api.summaries.addBatch, { ...auth, jobId: live, summaries: [row(0)] });
    const result = await t.mutation(api.summaries.resetAllPastePapers, { ...auth });
    expect(result).toEqual({ jobsTouched: 2, summariesDeleted: 2, suggestionsDeleted: 0, dryRun: false });
    expect(await readJob(t, filed)).toMatchObject({ status: "pending", archived: false, summaryCount: 0 });
    expect(await readJob(t, live)).toMatchObject({ status: "pending", archived: false, summaryCount: 0 });
  });
});

describe("dumping paste heads for external judging", () => {
  it("truncates the content head and pairs each paper with its lowest-index summary title", async () => {
    const t = withConvex();
    const long = "x".repeat(500);
    const jobId = await seedJob(t, { title: "Job Title", content: long, archived: true });
    await t.mutation(api.summaries.addBatch, {
      ...auth,
      jobId,
      summaries: [row(1, { title: "Second" }), row(0, { title: "First" })],
    });
    const heads = await t.query(api.summaries.listAllPasteHeads, { ...auth });
    expect(heads).toEqual([
      {
        jobId: jobId.toString(),
        jobTitle: "Job Title",
        summaryTitle: "First",
        contentHead: "x".repeat(400),
        archived: true,
      },
    ]);
  });

  it("lists a paper that has no summaries yet with an empty summary title", async () => {
    const t = withConvex();
    await seedJob(t, { content: MATCHING_CONTENT });
    const heads = await t.query(api.summaries.listAllPasteHeads, { ...auth });
    expect(heads.length).toBe(1);
    expect(heads[0]).toMatchObject({ jobTitle: "", summaryTitle: "" });
  });

  it("omits papers whose content is below the paste threshold", async () => {
    const t = withConvex();
    await seedJob(t, { content: "tiny" });
    await seedJob(t, { url: "https://example.com/none" });
    expect(await t.query(api.summaries.listAllPasteHeads, { ...auth })).toEqual([]);
  });
});
