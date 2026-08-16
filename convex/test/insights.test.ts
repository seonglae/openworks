import { describe, expect, it } from "vitest";
import type { JobStatus, JobType } from "@openworks/domain";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { auth, withConvex } from "./harness.setup";

type Harness = ReturnType<typeof withConvex>;
type InsightSeed = Partial<Omit<Doc<"insights">, "_id" | "_creationTime">>;
type JobSeed = Partial<Omit<Doc<"jobs">, "_id" | "_creationTime">>;

async function seedInsight(t: Harness, seed: InsightSeed = {}) {
  return await t.run(async (ctx) =>
    ctx.db.insert("insights", { text: "seed insight", origin: "manual", status: "new", createdAt: 1, ...seed }),
  );
}

async function readInsight(t: Harness, id: Id<"insights">) {
  return await t.run(async (ctx) => ctx.db.get(id));
}

async function listAll(t: Harness) {
  return await t.query(api.insights.list, { ...auth });
}

async function seedJob(t: Harness, seed: JobSeed = {}) {
  return await t.run(async (ctx) =>
    ctx.db.insert("jobs", {
      url: "https://example.com/x",
      type: "newsletter" satisfies JobType,
      status: "done" satisfies JobStatus,
      archived: false,
      createdAt: 1,
      ...seed,
    }),
  );
}

// Walks the cursor to exhaustion the way the infinite-scroll list does, and
// reports the round trips it took so an empty page is visible to assertions.
async function walkPaged(t: Harness, numItems: number, status?: Doc<"insights">["status"]) {
  const rows: Doc<"insights">[] = [];
  const pageSizes: number[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    // Annotated because the loop feeds the cursor back into the same call,
    // which leaves the inferred type self-referential.
    const res: { page: Doc<"insights">[]; isDone: boolean; continueCursor: string } = await t.query(
      api.insights.listPaged,
      { ...auth, paginationOpts: { numItems, cursor }, status },
    );
    rows.push(...res.page);
    pageSizes.push(res.page.length);
    if (res.isDone) return { rows, pageSizes };
    cursor = res.continueCursor;
  }
  throw new Error("listPaged never reported isDone");
}

describe("pasting insights by hand", () => {
  it("makes one insight per blank-line-separated paragraph", async () => {
    const t = withConvex();
    const res = await t.mutation(api.insights.add, { ...auth, raw: "first thought\n\nsecond thought" });
    expect(res).toEqual({ added: 2 });
    expect((await listAll(t)).map((r) => r.text).sort()).toEqual(["first thought", "second thought"]);
  });

  it("keeps a multi-line quote whole as long as it has no blank line inside", async () => {
    const t = withConvex();
    const res = await t.mutation(api.insights.add, { ...auth, raw: "line one\nline two" });
    expect(res).toEqual({ added: 1 });
    expect((await listAll(t))[0].text).toBe("line one\nline two");
  });

  it("adds nothing for a blob that is only whitespace", async () => {
    const t = withConvex();
    expect(await t.mutation(api.insights.add, { ...auth, raw: "\n\n   \n\n" })).toEqual({ added: 0 });
  });

  it("stores a hand-pasted duplicate again, because only the bulk import dedupes", async () => {
    const t = withConvex();
    await t.mutation(api.insights.add, { ...auth, raw: "same thought" });
    await t.mutation(api.insights.add, { ...auth, raw: "same thought" });
    expect((await listAll(t)).length).toBe(2);
  });
});

describe("bulk importing insight texts", () => {
  it("skips fragments shorter than four characters", async () => {
    const t = withConvex();
    const res = await t.mutation(api.insights.addBatchTexts, { ...auth, texts: ["abc", "abcd", " ab "] });
    expect(res).toEqual({ added: 1, skipped: 2 });
    expect((await listAll(t)).map((r) => r.text)).toEqual(["abcd"]);
  });

  it("dedupes case-insensitively against stored rows and within the same batch", async () => {
    const t = withConvex();
    await seedInsight(t, { text: "Scaling laws hold" });
    const res = await t.mutation(api.insights.addBatchTexts, {
      ...auth,
      texts: ["scaling laws hold", "SCALING LAWS HOLD", "  Scaling laws hold  ", "a fresh one"],
    });
    expect(res).toEqual({ added: 1, skipped: 3 });
  });

  it("labels imported rows as coming from notion unless the caller says otherwise", async () => {
    const t = withConvex();
    await t.mutation(api.insights.addBatchTexts, { ...auth, texts: ["from a notion page"] });
    await t.mutation(api.insights.addBatchTexts, { ...auth, texts: ["typed by hand"], origin: "manual" });
    const byText = Object.fromEntries((await listAll(t)).map((r) => [r.text, r.origin]));
    expect(byText).toEqual({ "from a notion page": "notion", "typed by hand": "manual" });
  });

  it("refuses a harvest origin, which only the worker path may set", async () => {
    const t = withConvex();
    await expect(
      t.mutation(api.insights.addBatchTexts, { ...auth, texts: ["x y z"], origin: "paper" as "manual" }),
    ).rejects.toThrow(/paper/);
  });
});

describe("screenshot insights", () => {
  it("queues an empty row so the worker can read the quote off the image", async () => {
    const t = withConvex();
    const imageId = await t.run(async (ctx) => ctx.storage.store(new Blob(["png"])));
    const id = await t.mutation(api.insights.addImage, { ...auth, imageId });
    expect(await readInsight(t, id)).toMatchObject({ text: "", imageId, origin: "manual", status: "new" });
  });

  it("serves a download url for the stored screenshot", async () => {
    const t = withConvex();
    const imageId = await t.run(async (ctx) => ctx.storage.store(new Blob(["png"])));
    const id = await t.mutation(api.insights.addImage, { ...auth, imageId });
    expect(await t.query(api.insights.imageUrl, { ...auth, id })).toMatch(/^https?:\/\//);
  });

  it("returns no url for a text-only insight", async () => {
    const t = withConvex();
    const id = await seedInsight(t);
    expect(await t.query(api.insights.imageUrl, { ...auth, id })).toBeNull();
  });

  it("returns no url when the insight was deleted while its image was on screen", async () => {
    const t = withConvex();
    const id = await seedInsight(t);
    await t.mutation(api.insights.remove, { ...auth, id });
    expect(await t.query(api.insights.imageUrl, { ...auth, id })).toBeNull();
  });

  it("hands the paste flow an upload url to post the screenshot to", async () => {
    const t = withConvex();
    expect(await t.mutation(api.insights.generateUploadUrl, { ...auth })).toMatch(/^https?:\/\//);
  });
});

describe("listing insights", () => {
  it("lists every status together, newest first", async () => {
    const t = withConvex();
    await seedInsight(t, { text: "oldest", createdAt: 10, status: "dismissed" });
    await seedInsight(t, { text: "newest", createdAt: 30, status: "new" });
    await seedInsight(t, { text: "middle", createdAt: 20, status: "placed" });
    expect((await listAll(t)).map((r) => r.text)).toEqual(["newest", "middle", "oldest"]);
  });

  it("counts each status for the filter chips and reports the count as exact", async () => {
    const t = withConvex();
    await seedInsight(t, { status: "new" });
    await seedInsight(t, { status: "new" });
    await seedInsight(t, { status: "placed" });
    expect(await t.query(api.insights.statusCounts, { ...auth })).toEqual({
      counts: { new: 2, placed: 1 },
      total: 3,
      approx: false,
    });
  });

  it("stops counting at the cap and says so, counting the newest rows the list also shows", async () => {
    const t = withConvex();
    const CAP = 2000;
    await t.run(async (ctx) => {
      for (let i = 0; i < CAP; i++) {
        await ctx.db.insert("insights", { text: `old ${i}`, origin: "manual", status: "new", createdAt: i });
      }
      await ctx.db.insert("insights", { text: "newest", origin: "manual", status: "placed", createdAt: CAP });
    });
    const res = await t.query(api.insights.statusCounts, { ...auth });
    expect(res).toMatchObject({ total: CAP, approx: true });
    expect(res.counts.placed).toBe(1);
    expect(res.counts.new).toBe(CAP - 1);
  });
});

describe("paginating insights", () => {
  it("returns a single status newest first when the list is filtered", async () => {
    const t = withConvex();
    await seedInsight(t, { text: "a", createdAt: 1, status: "new" });
    await seedInsight(t, { text: "b", createdAt: 2, status: "new" });
    await seedInsight(t, { text: "c", createdAt: 3, status: "new" });
    await seedInsight(t, { text: "other", createdAt: 4, status: "placed" });
    const { rows } = await walkPaged(t, 2, "new");
    expect(rows.map((r) => r.text)).toEqual(["c", "b", "a"]);
  });

  it("orders the unfiltered feed by what still needs attention, then by recency", async () => {
    const t = withConvex();
    await seedInsight(t, { text: "dismissed", status: "dismissed", createdAt: 5 });
    await seedInsight(t, { text: "new old", status: "new", createdAt: 1 });
    await seedInsight(t, { text: "placed", status: "placed", createdAt: 4 });
    await seedInsight(t, { text: "suggested", status: "suggested", createdAt: 2 });
    await seedInsight(t, { text: "new recent", status: "new", createdAt: 3 });
    await seedInsight(t, { text: "error", status: "error", createdAt: 6 });
    const { rows } = await walkPaged(t, 2);
    expect(rows.map((r) => r.text)).toEqual(["suggested", "new recent", "new old", "error", "placed", "dismissed"]);
  });

  it("skips statuses with no rows instead of spending a round trip on an empty page", async () => {
    const t = withConvex();
    await seedInsight(t, { text: "a", status: "dismissed", createdAt: 1 });
    await seedInsight(t, { text: "b", status: "dismissed", createdAt: 2 });
    const { rows, pageSizes } = await walkPaged(t, 5);
    expect(rows.map((r) => r.text)).toEqual(["b", "a"]);
    expect(pageSizes).toEqual([2]);
  });

  it("finishes in one call on an empty table", async () => {
    const t = withConvex();
    const res = await t.query(api.insights.listPaged, { ...auth, paginationOpts: { numItems: 10, cursor: null } });
    expect(res).toMatchObject({ page: [], isDone: true });
  });

  it("hands the cursor to the next status once a stream runs out", async () => {
    const t = withConvex();
    await seedInsight(t, { text: "suggested", status: "suggested" });
    await seedInsight(t, { text: "new", status: "new" });
    const first = await t.query(api.insights.listPaged, { ...auth, paginationOpts: { numItems: 5, cursor: null } });
    expect(first.page.map((r) => r.text)).toEqual(["suggested"]);
    expect(first.isDone).toBe(false);
    expect(first.continueCursor).toBe("1:");
    const second = await t.query(api.insights.listPaged, {
      ...auth,
      paginationOpts: { numItems: 5, cursor: first.continueCursor },
    });
    expect(second.page.map((r) => r.text)).toEqual(["new"]);
  });

  it("restarts from the top when handed a cursor that carries no status rank", async () => {
    const t = withConvex();
    await seedInsight(t, { text: "suggested", status: "suggested" });
    const res = await t.query(api.insights.listPaged, {
      ...auth,
      paginationOpts: { numItems: 5, cursor: "garbage-without-a-colon" },
    });
    expect(res.page.map((r) => r.text)).toEqual(["suggested"]);
  });

  it("rejects a status the feed does not know", async () => {
    const t = withConvex();
    await expect(
      t.query(api.insights.listPaged, {
        ...auth,
        paginationOpts: { numItems: 5, cursor: null },
        status: "archived" as "new",
      }),
    ).rejects.toThrow(/archived/);
  });
});

describe("editing and status changes", () => {
  it("re-queues an edited insight and drops the enrichment written for the old text", async () => {
    const t = withConvex();
    const id = await seedInsight(t, {
      text: "partial quo",
      status: "suggested",
      source: "TLDR",
      interpretation: "old reading",
      evaluation: "old take",
      tags: ["ai"],
      notionPageId: "page-1",
      notionPageName: "Scaling",
      notionPageUrl: "https://notion.so/page-1",
      notionContent: "> partial quo",
      notionContextBefore: "before",
      notionContextAfter: "after",
      notionReason: "best match",
      error: "stale error",
    });
    await t.mutation(api.insights.updateText, { ...auth, id, text: "partial quote, now whole" });
    const row = await readInsight(t, id);
    expect(row).toMatchObject({ text: "partial quote, now whole", status: "new" });
    for (const field of ["source", "interpretation", "evaluation", "tags", "notionPageId", "error"] as const) {
      expect(row?.[field]).toBeUndefined();
    }
  });

  it("drops the provider and the placement stamp but keeps the unrecoverable source url", async () => {
    const t = withConvex();
    const id = await seedInsight(t, {
      text: "quote",
      status: "placed",
      origin: "newsletter",
      provider: "gemini",
      placedAt: 123,
      sourceUrl: "https://example.com/a",
    });
    await t.mutation(api.insights.updateText, { ...auth, id, text: "quote, fixed" });
    const row = await readInsight(t, id);
    expect(row).toMatchObject({ status: "new", origin: "newsletter", sourceUrl: "https://example.com/a" });
    for (const field of ["provider", "placedAt"] as const) {
      expect(row?.[field]).toBeUndefined();
    }
  });

  it("moves an insight to a chosen status", async () => {
    const t = withConvex();
    const id = await seedInsight(t, { status: "suggested" });
    await t.mutation(api.insights.setStatus, { ...auth, id, status: "dismissed" });
    expect((await readInsight(t, id))?.status).toBe("dismissed");
  });

  it("refuses a status outside the five the schema allows", async () => {
    const t = withConvex();
    const id = await seedInsight(t);
    await expect(t.mutation(api.insights.setStatus, { ...auth, id, status: "archived" as "new" })).rejects.toThrow(
      /archived/,
    );
  });

  it("drops a removed insight out of the list", async () => {
    const t = withConvex();
    const id = await seedInsight(t);
    await t.mutation(api.insights.remove, { ...auth, id });
    expect(await listAll(t)).toEqual([]);
  });
});

describe("worker enrichment", () => {
  it("hands the worker only the rows waiting to be enriched", async () => {
    const t = withConvex();
    await seedInsight(t, { text: "waiting", status: "new" });
    await seedInsight(t, { text: "already suggested", status: "suggested" });
    await seedInsight(t, { text: "failed", status: "error" });
    expect((await t.query(api.insights.listNew, { ...auth })).map((r) => r.text)).toEqual(["waiting"]);
  });

  it("accepts a typo-level cleanup of the original wording", async () => {
    const t = withConvex();
    const id = await seedInsight(t, { text: "Attention is all you need." });
    await t.mutation(api.insights.completeEnrich, {
      ...auth,
      id,
      text: "Attention is all you neeed.",
      interpretation: "the transformer thesis",
    });
    expect(await readInsight(t, id)).toMatchObject({
      text: "Attention is all you neeed.",
      status: "suggested",
      interpretation: "the transformer thesis",
    });
  });

  it("keeps the user's wording when the enrichment tries to paraphrase it", async () => {
    const t = withConvex();
    const id = await seedInsight(t, { text: "Attention is all you need." });
    await t.mutation(api.insights.completeEnrich, {
      ...auth,
      id,
      text: "Transformers drop recurrence entirely and rely on attention.",
      evaluation: "solid",
    });
    expect(await readInsight(t, id)).toMatchObject({
      text: "Attention is all you need.",
      status: "suggested",
      evaluation: "solid",
    });
  });

  it("fills the text of an image-only row from scratch", async () => {
    const t = withConvex();
    const id = await seedInsight(t, { text: "" });
    await t.mutation(api.insights.completeEnrich, { ...auth, id, text: "a quote read off the screenshot" });
    expect((await readInsight(t, id))?.text).toBe("a quote read off the screenshot");
  });

  it("lets a very short insight be replaced wholesale, because the guard has a four-edit floor", async () => {
    const t = withConvex();
    const id = await seedInsight(t, { text: "cat" });
    await t.mutation(api.insights.completeEnrich, { ...auth, id, text: "dogs" });
    expect((await readInsight(t, id))?.text).toBe("dogs");
  });

  it("ignores a whitespace-only rewrite but still records the enrichment", async () => {
    const t = withConvex();
    const id = await seedInsight(t, { text: "the original quote" });
    await t.mutation(api.insights.completeEnrich, { ...auth, id, text: "   ", tags: ["ai"] });
    expect(await readInsight(t, id)).toMatchObject({ text: "the original quote", status: "suggested", tags: ["ai"] });
  });

  it("parks a failed enrichment with a truncated error message", async () => {
    const t = withConvex();
    const id = await seedInsight(t);
    await t.mutation(api.insights.setError, { ...auth, id, error: "e".repeat(600) });
    const row = await readInsight(t, id);
    expect(row?.status).toBe("error");
    expect(row?.error?.length).toBe(500);
  });
});

describe("harvesting insights from finished jobs", () => {
  it("attaches the origin job and skips blanks and quotes already captured", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { type: "newsletter" });
    await seedInsight(t, { text: "Already captured" });
    const res = await t.mutation(api.insights.addHarvested, {
      ...auth,
      jobId,
      origin: "newsletter",
      items: [
        { text: "already captured" },
        { text: "   " },
        { text: "A fresh takeaway", source: "TLDR", sourceUrl: "https://example.com/a" },
      ],
    });
    expect(res).toEqual({ added: 1 });
    const harvested = (await listAll(t)).find((r) => r.text === "A fresh takeaway");
    expect(harvested).toMatchObject({
      origin: "newsletter",
      originJobId: jobId,
      source: "TLDR",
      sourceUrl: "https://example.com/a",
      status: "new",
    });
  });

  it("applies the same minimum length the bulk import does, so neither path can seed a fragment", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { type: "newsletter" });
    const fragments = ["x", "ab", "abc", "  a  "];
    const harvested = await t.mutation(api.insights.addHarvested, {
      ...auth,
      jobId,
      origin: "newsletter",
      items: fragments.map((text) => ({ text })),
    });
    expect(harvested).toEqual({ added: 0 });
    const imported = await t.mutation(api.insights.addBatchTexts, { ...auth, texts: fragments });
    expect(imported.added).toBe(0);
    expect(await listAll(t)).toEqual([]);

    const atTheLimit = await t.mutation(api.insights.addHarvested, {
      ...auth,
      jobId,
      origin: "newsletter",
      items: [{ text: "abcd" }],
    });
    expect(atTheLimit).toEqual({ added: 1 });
  });

  it("offers newsletter jobs before paper jobs and the newest of each first", async () => {
    const t = withConvex();
    const olderNewsletter = await seedJob(t, { type: "newsletter", createdAt: 1 });
    const newerNewsletter = await seedJob(t, { type: "newsletter", createdAt: 2 });
    const paper = await seedJob(t, { type: "paper", createdAt: 3 });
    const res = await t.query(api.insights.listHarvestable, { ...auth, limit: 10 });
    expect(res).toEqual([
      { jobId: newerNewsletter, type: "newsletter" },
      { jobId: olderNewsletter, type: "newsletter" },
      { jobId: paper, type: "paper" },
    ]);
  });

  it("offers one job at a time unless a limit is given", async () => {
    const t = withConvex();
    await seedJob(t, { type: "newsletter", createdAt: 1 });
    await seedJob(t, { type: "newsletter", createdAt: 2 });
    expect((await t.query(api.insights.listHarvestable, { ...auth })).length).toBe(1);
  });

  it("passes over archived, unfinished and already-harvested jobs", async () => {
    const t = withConvex();
    await seedJob(t, { type: "newsletter", archived: true });
    await seedJob(t, { type: "newsletter", status: "pending" });
    await seedJob(t, { type: "newsletter", insightsHarvestedAt: 999 });
    await seedJob(t, { type: "paper", status: "error" });
    expect(await t.query(api.insights.listHarvestable, { ...auth, limit: 10 })).toEqual([]);
  });

  it("stops offering a job once it has been marked harvested", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { type: "newsletter" });
    await t.mutation(api.insights.markHarvested, { ...auth, jobId });
    expect(await t.query(api.insights.listHarvestable, { ...auth, limit: 10 })).toEqual([]);
    expect((await t.run(async (ctx) => ctx.db.get(jobId)))?.insightsHarvestedAt).toBeGreaterThan(0);
  });

  it("still reaches a harvestable job sitting behind hundreds of newer ones", async () => {
    const t = withConvex();
    const starved = await seedJob(t, { type: "newsletter", createdAt: 0 });
    await t.run(async (ctx) => {
      for (let i = 1; i <= 400; i++) {
        await ctx.db.insert("jobs", {
          url: `https://example.com/${i}`,
          type: "newsletter",
          status: "done",
          archived: false,
          // Half already harvested, half archived or unfinished: none of them is
          // harvestable, and none of them may crowd out the one that is.
          ...(i % 2 === 0 ? { insightsHarvestedAt: 1 } : { archived: true }),
          createdAt: i,
        });
      }
    });
    expect(await t.query(api.insights.listHarvestable, { ...auth, limit: 10 })).toEqual([
      { jobId: starved, type: "newsletter" },
    ]);
  });

  it("reaches a job old enough to predate the archived field", async () => {
    const t = withConvex();
    const legacy = await t.run(async (ctx) =>
      ctx.db.insert("jobs", { url: "https://example.com/legacy", type: "newsletter", status: "done", createdAt: 0 }),
    );
    expect(await t.query(api.insights.listHarvestable, { ...auth, limit: 10 })).toEqual([
      { jobId: legacy, type: "newsletter" },
    ]);
  });

  it("clamps an oversized limit so one caller cannot read more job content than a transaction allows", async () => {
    const t = withConvex();
    await t.run(async (ctx) => {
      for (const type of ["newsletter", "paper"] as const) {
        for (let i = 0; i < 205; i++) {
          await ctx.db.insert("jobs", {
            url: `https://example.com/${type}/${i}`,
            type,
            status: "done",
            archived: false,
            createdAt: i,
          });
        }
      }
    });
    expect((await t.query(api.insights.listHarvestable, { ...auth, limit: 10_000 })).length).toBe(25);
  });
});

describe("placement from the notion action", () => {
  it("reads back the row the placement action was given", async () => {
    const t = withConvex();
    const id = await seedInsight(t, { text: "to be placed", notionPageId: "page-1" });
    const row = await t.query(internal.insights.internalGetById, { id });
    expect(row).toMatchObject({ text: "to be placed", notionPageId: "page-1" });
  });

  it("reads back nothing when the insight was deleted before the action ran", async () => {
    const t = withConvex();
    const id = await seedInsight(t);
    await t.mutation(api.insights.remove, { ...auth, id });
    expect(await t.query(internal.insights.internalGetById, { id })).toBeNull();
  });

  it("stamps the placement time when the quote lands in notion", async () => {
    const t = withConvex();
    const id = await seedInsight(t, { status: "suggested" });
    await t.mutation(internal.insights.internalMarkPlaced, { id });
    const row = await readInsight(t, id);
    expect(row?.status).toBe("placed");
    expect(row?.placedAt).toBeGreaterThan(0);
  });
});
