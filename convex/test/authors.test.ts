import { describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { auth, withConvex } from "./harness.setup";

type Harness = ReturnType<typeof withConvex>;

async function seedJob(
  t: Harness,
  opts: {
    type?: "paper" | "newsletter" | "article";
    title?: string;
    url?: string;
    content?: string;
    createdAt?: number;
    archived?: boolean;
    openAlexId?: string;
    resolvedAt?: number;
  } = {},
): Promise<Id<"jobs">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("jobs", {
      url: opts.url ?? "https://arxiv.org/abs/2401.00001",
      type: opts.type ?? "paper",
      status: "done",
      archived: opts.archived ?? false,
      createdAt: opts.createdAt ?? 1,
      ...(opts.title === undefined ? {} : { title: opts.title }),
      ...(opts.content === undefined ? {} : { content: opts.content }),
      ...(opts.openAlexId === undefined ? {} : { openAlexId: opts.openAlexId }),
      ...(opts.resolvedAt === undefined ? {} : { authorsResolvedAt: opts.resolvedAt }),
    }),
  );
}

async function seedSummary(
  t: Harness,
  jobId: Id<"jobs">,
  opts: { title?: string; url?: string; score?: number; researchLevel?: string; index?: number } = {},
): Promise<Id<"summaries">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("summaries", {
      jobId,
      index: opts.index ?? 0,
      title: opts.title ?? "seeded summary",
      category: "c",
      summary: "s",
      keywords: [],
      url: opts.url ?? "",
      ...(opts.researchLevel === undefined ? {} : { researchLevel: opts.researchLevel }),
      ...(opts.score === undefined
        ? {}
        : {
            scores: {
              soundness: 5,
              originality: 5,
              experiments: 5,
              clarity: 5,
              impact: 5,
              significance: 5,
              overall: opts.score,
            },
          }),
    }),
  );
}

async function seedAuthor(
  t: Harness,
  jobId: Id<"jobs">,
  opts: {
    authorId: string;
    name?: string;
    position?: "first" | "middle" | "last";
    resolved?: boolean;
    orcid?: string;
    institution?: string;
    seq?: number;
  },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("paperAuthors", {
      jobId,
      authorId: opts.authorId,
      name: opts.name ?? opts.authorId,
      position: opts.position ?? "first",
      seq: opts.seq ?? 0,
      resolved: opts.resolved ?? true,
      createdAt: 1,
      ...(opts.orcid === undefined ? {} : { orcid: opts.orcid }),
      ...(opts.institution === undefined ? {} : { institution: opts.institution }),
    }),
  );
}

async function seedStat(
  t: Harness,
  opts: {
    authorId: string;
    name?: string;
    paperCount?: number;
    firstCount?: number;
    lastCount?: number;
    scoreAll?: number;
    scoreFirst?: number;
    scoreLast?: number;
    scoredAll?: number;
    scoredFirst?: number;
    scoredLast?: number;
  },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("authorStats", {
      authorId: opts.authorId,
      name: opts.name ?? opts.authorId,
      paperCount: opts.paperCount ?? 0,
      firstCount: opts.firstCount ?? 0,
      lastCount: opts.lastCount ?? 0,
      scoreAll: opts.scoreAll ?? 0,
      scoreFirst: opts.scoreFirst ?? 0,
      scoreLast: opts.scoreLast ?? 0,
      rawAll: 0,
      rawFirst: 0,
      rawLast: 0,
      scoredAll: opts.scoredAll ?? 0,
      scoredFirst: opts.scoredFirst ?? 0,
      scoredLast: opts.scoredLast ?? 0,
      lastPaperAt: 0,
      updatedAt: 0,
    }),
  );
}

const statsByAuthor = async (t: Harness) => {
  const rows = await t.run(async (ctx) => ctx.db.query("authorStats").collect());
  return new Map(rows.map((r) => [r.authorId, r]));
};

const page = { numItems: 10, cursor: null };

type Board = { page: { authorId: string }[]; continueCursor: string; isDone: boolean };

describe("papers still awaiting author resolution", () => {
  it("offers only paper jobs that have never been through OpenAlex", async () => {
    const t = withConvex();
    const pending = await seedJob(t, { url: "https://p/pending" });
    await seedJob(t, { url: "https://p/done", resolvedAt: 123 });
    await seedJob(t, { type: "newsletter", url: "https://n/pending" });
    const rows = await t.query(internal.authors.jobsNeedingAuthors, { limit: 10 });
    expect(rows.map((r) => r._id)).toEqual([pending]);
  });

  it("keeps archived papers queued, because the leaderboard covers the whole reading history", async () => {
    const t = withConvex();
    const archived = await seedJob(t, { archived: true });
    const rows = await t.query(internal.authors.jobsNeedingAuthors, { limit: 10 });
    expect(rows.map((r) => r._id)).toEqual([archived]);
  });

  it("hands back the newest pending papers first and never more than the limit", async () => {
    const t = withConvex();
    await seedJob(t, { url: "https://p/1", createdAt: 100 });
    const mid = await seedJob(t, { url: "https://p/2", createdAt: 200 });
    const newest = await seedJob(t, { url: "https://p/3", createdAt: 300 });
    const rows = await t.query(internal.authors.jobsNeedingAuthors, { limit: 2 });
    expect(rows.map((r) => r._id)).toEqual([newest, mid]);
  });
});

describe("identifiers gathered for one paper", () => {
  it("returns null for a job that no longer exists", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.run(async (ctx) => ctx.db.delete(jobId));
    expect(await t.query(internal.authors.resolveInputs, { jobId })).toBeNull();
  });

  it("gathers the job url, every summary url and the leading slice of stripped content", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { url: "https://job/url", content: "x".repeat(900) });
    await seedSummary(t, jobId, { url: "https://summary/one" });
    await seedSummary(t, jobId, { url: "https://summary/two", index: 1 });
    const input = await t.query(internal.authors.resolveInputs, { jobId });
    expect(input?.urls.slice(0, 3)).toEqual(["https://job/url", "https://summary/one", "https://summary/two"]);
    expect(input?.urls[3]).toHaveLength(400);
  });

  it("drops blank urls and falls back to the first summary title when the job has none", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { url: "https://job/url" });
    await seedSummary(t, jobId, { title: "Attention Is All You Need", url: "" });
    const input = await t.query(internal.authors.resolveInputs, { jobId });
    expect(input?.urls).toEqual(["https://job/url"]);
    expect(input?.title).toBe("Attention Is All You Need");
  });
});

describe("saving resolved authorships", () => {
  it("replaces the paper's previous authorships instead of appending to them", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await seedAuthor(t, jobId, { authorId: "A_old" });
    const written = await t.mutation(internal.authors.saveAuthors, {
      jobId,
      authors: [{ authorId: "A_new", name: "New", position: "first", seq: 0, resolved: true }],
    });
    const rows = await t.run(async (ctx) => ctx.db.query("paperAuthors").collect());
    expect(written).toBe(1);
    expect(rows.map((r) => r.authorId)).toEqual(["A_new"]);
  });

  it("stamps the paper as resolved even when OpenAlex matched nothing", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(internal.authors.saveAuthors, { jobId, authors: [] });
    const job = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(job?.authorsResolvedAt).toBeGreaterThan(0);
    expect(await t.query(internal.authors.jobsNeedingAuthors, { limit: 10 })).toEqual([]);
  });

  it("leaves an already known work id in place when the caller omits one", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { openAlexId: "W1" });
    await t.mutation(internal.authors.saveAuthors, { jobId, authors: [] });
    expect(await t.run(async (ctx) => (await ctx.db.get(jobId))?.openAlexId)).toBe("W1");
    await t.mutation(internal.authors.saveAuthors, { jobId, openAlexId: "W2", authors: [] });
    expect(await t.run(async (ctx) => (await ctx.db.get(jobId))?.openAlexId)).toBe("W2");
  });
});

describe("rekeying authorships OpenAlex could not identify", () => {
  it("gives two same-named unidentified authors different keys so they never merge", async () => {
    const t = withConvex();
    const jobA = await seedJob(t, { url: "https://p/a" });
    const jobB = await seedJob(t, { url: "https://p/b" });
    await seedAuthor(t, jobA, { authorId: "name:weizhang", name: "Wei Zhang", resolved: false });
    await seedAuthor(t, jobB, { authorId: "name:weizhang", name: "Wei Zhang", resolved: false });
    expect(await t.mutation(internal.authors.rekeyUnresolved, {})).toBe(2);
    const rows = await t.run(async (ctx) => ctx.db.query("paperAuthors").collect());
    const keys = rows.map((r) => r.authorId);
    expect(keys).toEqual([`name:weizhang:${jobA}`, `name:weizhang:${jobB}`]);
    expect(new Set(keys).size).toBe(2);
  });

  it("leaves identified authorships alone and finds nothing left to fix on a second pass", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await seedAuthor(t, jobId, { authorId: "A5023888391", name: "Wei Zhang", resolved: true });
    await seedAuthor(t, jobId, { authorId: "stale", name: "Jane Doe", resolved: false, seq: 1 });
    expect(await t.mutation(internal.authors.rekeyUnresolved, {})).toBe(1);
    expect(await t.mutation(internal.authors.rekeyUnresolved, {})).toBe(0);
    const rows = await t.run(async (ctx) => ctx.db.query("paperAuthors").collect());
    expect(rows[0].authorId).toBe("A5023888391");
    expect(rows[1].authorId).toBe(`name:janedoe:${jobId}`);
  });
});

describe("the join feeding the author rollup", () => {
  it("averages over papers rather than authorships, so a many-author paper does not weigh more", async () => {
    const t = withConvex();
    const jobA = await seedJob(t, { url: "https://p/a" });
    await seedSummary(t, jobA, { score: 6 });
    await seedAuthor(t, jobA, { authorId: "X" });
    await seedAuthor(t, jobA, { authorId: "Z", position: "last", seq: 1 });
    const jobB = await seedJob(t, { url: "https://p/b" });
    await seedSummary(t, jobB, { score: 10 });
    await seedAuthor(t, jobB, { authorId: "Y" });
    const src = await t.query(internal.authors.statsSource, {});
    expect(src.rows.map((r) => r.score)).toEqual([6, 6, 10]);
    // Three authorship rows, two papers: jobA's 6 counts once, not twice.
    expect(src.globalMean).toBe(8);
  });

  it("counts a work once in the baseline when the same paper was submitted twice", async () => {
    const t = withConvex();
    const jobA = await seedJob(t, { url: "https://p/a", openAlexId: "W9" });
    await seedSummary(t, jobA, { score: 6 });
    await seedAuthor(t, jobA, { authorId: "X" });
    const jobB = await seedJob(t, { url: "https://p/b", openAlexId: "W9" });
    await seedSummary(t, jobB, { score: 10 });
    await seedAuthor(t, jobB, { authorId: "X" });
    const src = await t.query(internal.authors.statsSource, {});
    expect(src.globalMean).toBe(6);
  });

  it("identifies a paper by its OpenAlex work, so a second submission is not a second paper", async () => {
    const t = withConvex();
    const jobA = await seedJob(t, { url: "https://p/a", openAlexId: "W9" });
    const jobB = await seedJob(t, { url: "https://p/b", openAlexId: "W9" });
    const jobC = await seedJob(t, { url: "https://p/c" });
    await seedAuthor(t, jobA, { authorId: "X" });
    await seedAuthor(t, jobB, { authorId: "X" });
    await seedAuthor(t, jobC, { authorId: "X" });
    const src = await t.query(internal.authors.statsSource, {});
    expect(src.rows.map((r) => r.paperKey)).toEqual(["W9", "W9", jobC]);
  });

  it("takes the score from the first summary that carries one", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await seedSummary(t, jobId, { title: "unscored intro" });
    await seedSummary(t, jobId, { title: "scored", score: 7.5, index: 1 });
    await seedAuthor(t, jobId, { authorId: "X" });
    const src = await t.query(internal.authors.statsSource, {});
    expect(src.rows[0].score).toBe(7.5);
  });
});

describe("author rollup", () => {
  it("leaves out an authorship with no OpenAlex entity behind it", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await seedSummary(t, jobId, { score: 8 });
    await seedAuthor(t, jobId, { authorId: "A1", name: "Known" });
    await seedAuthor(t, jobId, { authorId: `name:unknown:${jobId}`, name: "Unknown", resolved: false, seq: 1 });
    expect(await t.action(internal.authors.recomputeStats, {})).toBe(1);
    const stats = await statsByAuthor(t);
    expect([...stats.keys()]).toEqual(["A1"]);
  });

  it("keeps two researchers who publish under the same display name apart", async () => {
    const t = withConvex();
    const jobA = await seedJob(t, { url: "https://p/a" });
    await seedSummary(t, jobA, { score: 9 });
    await seedAuthor(t, jobA, { authorId: "A111", name: "Wei Zhang" });
    const jobB = await seedJob(t, { url: "https://p/b" });
    await seedSummary(t, jobB, { score: 3 });
    await seedAuthor(t, jobB, { authorId: "A222", name: "Wei Zhang" });
    await t.action(internal.authors.recomputeStats, {});
    const stats = await statsByAuthor(t);
    expect(stats.size).toBe(2);
    expect(stats.get("A111")?.name).toBe("Wei Zhang");
    expect(stats.get("A222")?.name).toBe("Wei Zhang");
    // Global mean 6, so the shrunk means straddle it instead of collapsing to one row.
    expect(stats.get("A111")?.scoreFirst).toBe(6.75);
    expect(stats.get("A222")?.scoreFirst).toBe(5.25);
  });

  it("counts a work once when the same paper was submitted twice", async () => {
    const t = withConvex();
    const jobA = await seedJob(t, { url: "https://p/a", openAlexId: "W9" });
    await seedSummary(t, jobA, { score: 6 });
    await seedAuthor(t, jobA, { authorId: "X" });
    const jobB = await seedJob(t, { url: "https://p/b", openAlexId: "W9" });
    await seedSummary(t, jobB, { score: 10 });
    await seedAuthor(t, jobB, { authorId: "X" });
    await t.action(internal.authors.recomputeStats, {});
    const stats = await statsByAuthor(t);
    expect(stats.get("X")?.paperCount).toBe(1);
    expect(stats.get("X")?.scoredAll).toBe(1);
    // One work, so the baseline and the author's own sum both take the
    // first-seen 6 and the shrunk mean cannot move off it.
    expect(stats.get("X")?.scoreAll).toBe(6);
    expect(stats.get("X")?.rawAll).toBe(6);
  });

  it("does not let a many-author paper drag a solo author's shrunk score", async () => {
    const t = withConvex();
    const crowd = await seedJob(t, { url: "https://p/crowd" });
    await seedSummary(t, crowd, { score: 2 });
    for (let i = 0; i < 10; i++) {
      await seedAuthor(t, crowd, { authorId: `C${i}`, position: i === 0 ? "first" : "middle", seq: i });
    }
    const solo = await seedJob(t, { url: "https://p/solo" });
    await seedSummary(t, solo, { score: 8 });
    await seedAuthor(t, solo, { authorId: "S" });
    await t.action(internal.authors.recomputeStats, {});
    const stats = await statsByAuthor(t);
    // Baseline 5 over the two papers, so (3*5 + 8) / 4. Weighting by authorship
    // would have put the baseline near 2.5 and the solo author near 3.9.
    expect(stats.get("S")?.scoreAll).toBe(5.75);
  });

  it("pulls a single outstanding score toward the global mean", async () => {
    const t = withConvex();
    const low = await seedJob(t, { url: "https://p/low" });
    await seedSummary(t, low, { score: 4 });
    await seedAuthor(t, low, { authorId: "X" });
    const high = await seedJob(t, { url: "https://p/high" });
    await seedSummary(t, high, { score: 10 });
    await seedAuthor(t, high, { authorId: "Y" });
    await t.action(internal.authors.recomputeStats, {});
    const stats = await statsByAuthor(t);
    expect(stats.get("Y")?.rawFirst).toBe(10);
    expect(stats.get("Y")?.scoreFirst).toBe(7.75);
    expect(stats.get("X")?.scoreFirst).toBe(6.25);
  });

  it("gives an author with no scored paper the global mean and a raw mean of zero", async () => {
    const t = withConvex();
    const scored = await seedJob(t, { url: "https://p/scored" });
    await seedSummary(t, scored, { score: 8 });
    await seedAuthor(t, scored, { authorId: "X" });
    const unscored = await seedJob(t, { url: "https://p/unscored" });
    await seedSummary(t, unscored, {});
    await seedAuthor(t, unscored, { authorId: "W" });
    await t.action(internal.authors.recomputeStats, {});
    const stats = await statsByAuthor(t);
    expect(stats.get("W")?.paperCount).toBe(1);
    expect(stats.get("W")?.scoredAll).toBe(0);
    expect(stats.get("W")?.scoreAll).toBe(8);
    expect(stats.get("W")?.rawAll).toBe(0);
  });

  it("tallies first, last and any authorship on separate axes", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await seedSummary(t, jobId, { score: 8 });
    await seedAuthor(t, jobId, { authorId: "X", position: "first" });
    await seedAuthor(t, jobId, { authorId: "Y", position: "middle", seq: 1 });
    await seedAuthor(t, jobId, { authorId: "Z", position: "last", seq: 2 });
    await t.action(internal.authors.recomputeStats, {});
    const stats = await statsByAuthor(t);
    expect([stats.get("X")?.firstCount, stats.get("X")?.lastCount, stats.get("X")?.paperCount]).toEqual([1, 0, 1]);
    expect([stats.get("Y")?.firstCount, stats.get("Y")?.lastCount, stats.get("Y")?.paperCount]).toEqual([0, 0, 1]);
    expect([stats.get("Z")?.firstCount, stats.get("Z")?.lastCount, stats.get("Z")?.paperCount]).toEqual([0, 1, 1]);
    // A middle-author paper still counts as a scored paper on the "all" axis.
    expect(stats.get("Y")?.scoredAll).toBe(1);
    expect(stats.get("Y")?.scoredFirst).toBe(0);
  });

  it("keeps the first orcid and institution seen for an author", async () => {
    const t = withConvex();
    const jobA = await seedJob(t, { url: "https://p/a" });
    const jobB = await seedJob(t, { url: "https://p/b" });
    const jobC = await seedJob(t, { url: "https://p/c" });
    await seedAuthor(t, jobA, { authorId: "X" });
    await seedAuthor(t, jobB, { authorId: "X", orcid: "0000-0001", institution: "MIT" });
    await seedAuthor(t, jobC, { authorId: "X", orcid: "0000-0002", institution: "KAIST" });
    await t.action(internal.authors.recomputeStats, {});
    const stats = await statsByAuthor(t);
    expect(stats.get("X")?.orcid).toBe("0000-0001");
    expect(stats.get("X")?.institution).toBe("MIT");
  });

  it("remembers the newest paper date across an author's papers", async () => {
    const t = withConvex();
    const old = await seedJob(t, { url: "https://p/old", createdAt: 100 });
    const recent = await seedJob(t, { url: "https://p/recent", createdAt: 900 });
    await seedAuthor(t, recent, { authorId: "X" });
    await seedAuthor(t, old, { authorId: "X" });
    await t.action(internal.authors.recomputeStats, {});
    const stats = await statsByAuthor(t);
    expect(stats.get("X")?.lastPaperAt).toBe(900);
  });

  it("drops an author whose authorships disappeared once the clock has moved on", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await seedSummary(t, jobId, { score: 8 });
    await seedAuthor(t, jobId, { authorId: "X" });
    // Only Date is faked: the rebuild stamp is Date.now(), and real timers keep
    // the harness's own scheduling untouched.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await t.action(internal.authors.recomputeStats, {});
      expect((await statsByAuthor(t)).size).toBe(1);
      await t.run(async (ctx) => {
        for (const row of await ctx.db.query("paperAuthors").collect()) await ctx.db.delete(row._id);
      });
      vi.setSystemTime(Date.now() + 1000);
      expect(await t.action(internal.authors.recomputeStats, {})).toBe(0);
      expect((await statsByAuthor(t)).size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a vanished author even when two rebuilds land on the same millisecond", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await seedSummary(t, jobId, { score: 8 });
    await seedAuthor(t, jobId, { authorId: "X" });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await t.action(internal.authors.recomputeStats, {});
      expect((await statsByAuthor(t)).size).toBe(1);
      await t.run(async (ctx) => {
        for (const row of await ctx.db.query("paperAuthors").collect()) await ctx.db.delete(row._id);
      });
      // The clock never moves, so the rebuild marker cannot come from it: it
      // steps past the stamp already on the rows instead, and the prune sees
      // them as the leftovers they are.
      expect(await t.action(internal.authors.recomputeStats, {})).toBe(0);
      expect((await statsByAuthor(t)).size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives each rebuild a marker past the last one even without the clock moving", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await seedSummary(t, jobId, { score: 8 });
    await seedAuthor(t, jobId, { authorId: "X" });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await t.action(internal.authors.recomputeStats, {});
      const first = (await statsByAuthor(t)).get("X")!.updatedAt;
      await t.action(internal.authors.recomputeStats, {});
      expect((await statsByAuthor(t)).get("X")!.updatedAt).toBeGreaterThan(first);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("stats persistence", () => {
  const row = {
    authorId: "X",
    name: "X",
    paperCount: 1,
    firstCount: 1,
    lastCount: 0,
    scoreAll: 5,
    scoreFirst: 5,
    scoreLast: 0,
    rawAll: 5,
    rawFirst: 5,
    rawLast: 0,
    scoredAll: 1,
    scoredFirst: 1,
    scoredLast: 0,
    lastPaperAt: 10,
  };

  it("updates an author's existing row rather than inserting a second one", async () => {
    const t = withConvex();
    await t.mutation(internal.authors.writeStats, { rows: [row], stamp: 1 });
    await t.mutation(internal.authors.writeStats, { rows: [{ ...row, paperCount: 4 }], stamp: 2 });
    const rows = await t.run(async (ctx) => ctx.db.query("authorStats").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].paperCount).toBe(4);
    expect(rows[0].updatedAt).toBe(2);
  });

  it("deletes only the rows an earlier rebuild left behind", async () => {
    const t = withConvex();
    await t.mutation(internal.authors.writeStats, { rows: [row], stamp: 1 });
    await t.mutation(internal.authors.writeStats, { rows: [{ ...row, authorId: "Y", name: "Y" }], stamp: 2 });
    expect(await t.mutation(internal.authors.pruneStats, { stamp: 2 })).toBe(1);
    const rows = await t.run(async (ctx) => ctx.db.query("authorStats").collect());
    expect(rows.map((r) => r.authorId)).toEqual(["Y"]);
  });
});

describe("leaderboard", () => {
  it("ranks by shrunk first-author score when neither axis is given", async () => {
    const t = withConvex();
    await seedStat(t, { authorId: "low", firstCount: 1, scoredFirst: 1, scoreFirst: 4, paperCount: 5, scoreAll: 9 });
    await seedStat(t, { authorId: "high", firstCount: 1, scoredFirst: 1, scoreFirst: 8, paperCount: 1, scoreAll: 1 });
    const res = await t.query(api.authors.leaderboard, { ...auth, paginationOpts: page });
    expect(res.page.map((r) => r.authorId)).toEqual(["high", "low"]);
  });

  it("ranks by paper count when the count metric is asked for", async () => {
    const t = withConvex();
    await seedStat(t, { authorId: "few", paperCount: 1, scoreAll: 9 });
    await seedStat(t, { authorId: "many", paperCount: 7, scoreAll: 1 });
    const res = await t.query(api.authors.leaderboard, {
      ...auth,
      paginationOpts: page,
      position: "all",
      metric: "count",
    });
    expect(res.page.map((r) => r.authorId)).toEqual(["many", "few"]);
  });

  it("hides an author who never held the ranked position", async () => {
    const t = withConvex();
    await seedStat(t, { authorId: "coauthor", paperCount: 9, firstCount: 0, scoredFirst: 0, scoreFirst: 9 });
    await seedStat(t, { authorId: "lead", paperCount: 1, firstCount: 1, scoredFirst: 1, scoreFirst: 2 });
    const res = await t.query(api.authors.leaderboard, { ...auth, paginationOpts: page });
    expect(res.page.map((r) => r.authorId)).toEqual(["lead"]);
  });

  it("hides an author with no scored paper in the position, but only under the score metric", async () => {
    const t = withConvex();
    await seedStat(t, { authorId: "unscored", firstCount: 2, scoredFirst: 0, scoreFirst: 8 });
    await seedStat(t, { authorId: "scored", firstCount: 1, scoredFirst: 1, scoreFirst: 3 });
    const byScore = await t.query(api.authors.leaderboard, { ...auth, paginationOpts: page });
    expect(byScore.page.map((r) => r.authorId)).toEqual(["scored"]);
    const byCount = await t.query(api.authors.leaderboard, { ...auth, paginationOpts: page, metric: "count" });
    expect(byCount.page.map((r) => r.authorId)).toEqual(["unscored", "scored"]);
  });

  it("returns a short page when the filter drops a row, because filtering runs after pagination", async () => {
    const t = withConvex();
    await seedStat(t, { authorId: "a", firstCount: 2, scoredFirst: 2, scoreFirst: 9 });
    await seedStat(t, { authorId: "b", firstCount: 0, scoredFirst: 0, scoreFirst: 8 });
    await seedStat(t, { authorId: "c", firstCount: 1, scoredFirst: 1, scoreFirst: 7 });
    const first = await t.query(api.authors.leaderboard, { ...auth, paginationOpts: { numItems: 2, cursor: null } });
    expect(first.page.map((r) => r.authorId)).toEqual(["a"]);
    expect(first.isDone).toBe(false);
    const second = await t.query(api.authors.leaderboard, {
      ...auth,
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page.map((r) => r.authorId)).toEqual(["c"]);
    expect(second.isDone).toBe(true);
  });

  it("walks the whole board across pages without repeating an author", async () => {
    const t = withConvex();
    for (const [i, id] of ["a", "b", "c", "d"].entries()) {
      await seedStat(t, { authorId: id, firstCount: 1, scoredFirst: 1, scoreFirst: 9 - i });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let done = false;
    while (!done) {
      // Annotated because the cursor feeding the next call comes out of the
      // previous result, which TypeScript reads as a circular initializer.
      const res: Board = await t.query(api.authors.leaderboard, { ...auth, paginationOpts: { numItems: 3, cursor } });
      seen.push(...res.page.map((r) => r.authorId));
      cursor = res.continueCursor;
      done = res.isDone;
    }
    expect(seen).toEqual(["a", "b", "c", "d"]);
  });

  it("puts the more recently written of two tied authors first", async () => {
    const t = withConvex();
    await seedStat(t, { authorId: "earlier", firstCount: 1, scoredFirst: 1, scoreFirst: 7 });
    await seedStat(t, { authorId: "later", firstCount: 1, scoredFirst: 1, scoreFirst: 7 });
    const res = await t.query(api.authors.leaderboard, { ...auth, paginationOpts: page });
    // Convex breaks an index tie by creation time, and the board reads descending.
    expect(res.page.map((r) => r.authorId)).toEqual(["later", "earlier"]);
  });

  it("rejects a position outside first, last and all", async () => {
    const t = withConvex();
    await expect(
      t.query(api.authors.leaderboard, {
        ...auth,
        paginationOpts: page,
        position: "middle" as unknown as "first",
      }),
    ).rejects.toThrow();
  });

  it("rejects a metric outside score and count", async () => {
    const t = withConvex();
    await expect(
      t.query(api.authors.leaderboard, { ...auth, paginationOpts: page, metric: "raw" as unknown as "score" }),
    ).rejects.toThrow();
  });
});

describe("papers behind one leaderboard row", () => {
  it("shows a work once even when it was submitted twice", async () => {
    const t = withConvex();
    const jobA = await seedJob(t, { title: "Same paper", url: "https://p/a", openAlexId: "W9" });
    const jobB = await seedJob(t, { title: "Same paper", url: "https://p/b", openAlexId: "W9" });
    await seedAuthor(t, jobA, { authorId: "X" });
    await seedAuthor(t, jobB, { authorId: "X" });
    const res = await t.query(api.authors.papersByAuthor, { ...auth, paginationOpts: page, authorId: "X" });
    expect(res.page).toHaveLength(1);
    expect(res.page[0].jobId).toBe(jobB);
  });

  // Summaries come off by_jobId in insertion order, so a batch that arrived
  // out of order puts index 1 at rows[0]. Reading rows[0] reports the wrong
  // paper's title and url on a job whose own fields are blank.
  it("falls back to the summary at index 0, not to whichever row was written first", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { title: undefined, url: "" });
    await seedSummary(t, jobId, { index: 1, title: "Second Paper", url: "https://p/second" });
    await seedSummary(t, jobId, { index: 0, title: "First Paper", url: "https://p/first" });
    await seedAuthor(t, jobId, { authorId: "X" });
    const res = await t.query(api.authors.papersByAuthor, { ...auth, paginationOpts: page, authorId: "X" });
    expect(res.page[0].title).toBe("First Paper");
    expect(res.page[0].url).toBe("https://p/first");
  });

  it("skips an authorship whose job was deleted", async () => {
    const t = withConvex();
    const alive = await seedJob(t, { title: "Alive", url: "https://p/alive" });
    const gone = await seedJob(t, { title: "Gone", url: "https://p/gone" });
    await seedAuthor(t, alive, { authorId: "X" });
    await seedAuthor(t, gone, { authorId: "X" });
    await t.run(async (ctx) => ctx.db.delete(gone));
    const res = await t.query(api.authors.papersByAuthor, { ...auth, paginationOpts: page, authorId: "X" });
    expect(res.page.map((r) => r.title)).toEqual(["Alive"]);
  });

  it("carries the paper's score, research level and archive flag", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { title: "Scored", url: "https://p/s", archived: true, createdAt: 42 });
    await seedSummary(t, jobId, { score: 7.5, researchLevel: "top" });
    await seedAuthor(t, jobId, { authorId: "X", position: "last" });
    const res = await t.query(api.authors.papersByAuthor, { ...auth, paginationOpts: page, authorId: "X" });
    expect(res.page[0]).toMatchObject({
      overall: 7.5,
      researchLevel: "top",
      archived: true,
      position: "last",
      createdAt: 42,
    });
  });

  it("falls back to the summary title, and marks a paper with neither title untitled", async () => {
    const t = withConvex();
    const fromSummary = await seedJob(t, { url: "" });
    await seedSummary(t, fromSummary, { title: "Summary title", url: "https://summary/url" });
    await seedAuthor(t, fromSummary, { authorId: "X" });
    const bare = await seedJob(t, { url: "" });
    await seedAuthor(t, bare, { authorId: "X" });
    const res = await t.query(api.authors.papersByAuthor, { ...auth, paginationOpts: page, authorId: "X" });
    const byJob = new Map(res.page.map((r) => [r.jobId, r]));
    expect(byJob.get(fromSummary)?.title).toBe("Summary title");
    expect(byJob.get(bare)?.title).toBe("(untitled)");
    // `url` is required on a job, so a blank one is a value rather than a
    // missing field, and the fallback has to test the value to reach the
    // summary's url the way the title fallback reaches its title.
    expect(byJob.get(fromSummary)?.url).toBe("https://summary/url");
    expect(byJob.get(bare)?.url).toBe("");
  });

  it("returns nothing for an author id that was never recorded", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await seedAuthor(t, jobId, { authorId: "X" });
    const res = await t.query(api.authors.papersByAuthor, { ...auth, paginationOpts: page, authorId: "ghost" });
    expect(res.page).toEqual([]);
    expect(res.isDone).toBe(true);
  });
});

describe("resolution progress", () => {
  it("counts resolved and pending papers and ignores other job types", async () => {
    const t = withConvex();
    await seedJob(t, { url: "https://p/1", resolvedAt: 5 });
    await seedJob(t, { url: "https://p/2" });
    await seedJob(t, { url: "https://p/3" });
    await seedJob(t, { type: "newsletter", url: "https://n/1" });
    expect(await t.query(api.authors.resolveProgress, { ...auth })).toEqual({ total: 3, resolved: 1, pending: 2 });
  });
});

describe("sweep entry point", () => {
  it("schedules the sweep, which rebuilds the stats once no paper is pending", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { resolvedAt: 5 });
    await seedSummary(t, jobId, { score: 8 });
    await seedAuthor(t, jobId, { authorId: "X" });
    // convex-test only registers a scheduled job once its timer fires, so the
    // clock has to be driven forward before the sweep can be awaited.
    vi.useFakeTimers();
    try {
      expect(await t.mutation(api.authors.startResolveSweep, { ...auth })).toBe("scheduled");
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
    const stats = await statsByAuthor(t);
    expect(stats.get("X")?.paperCount).toBe(1);
  });
});

describe("shrinkage constant", () => {
  it("reports the constant alone, without consulting the stored rows", async () => {
    const t = withConvex();
    expect(await t.query(api.authors.globalMean, { ...auth })).toEqual({ shrinkC: 3 });
    // Ranked rows carry no baseline the query could report, so seeding one
    // leaves the answer identical.
    await seedStat(t, { authorId: "X", firstCount: 1, scoredFirst: 1, scoreFirst: 5 });
    expect(await t.query(api.authors.globalMean, { ...auth })).toEqual({ shrinkC: 3 });
  });
});
