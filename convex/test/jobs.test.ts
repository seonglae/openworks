import { describe, expect, it } from "vitest";
import { JOB_STATUSES, JOB_TYPES, type JobStatus, type JobType } from "@openworks/domain";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { auth, withConvex } from "./harness.setup";

type Harness = ReturnType<typeof withConvex>;
type JobSeed = Partial<Omit<Doc<"jobs">, "_id" | "_creationTime">>;
type SummarySeed = Partial<Omit<Doc<"summaries">, "_id" | "_creationTime" | "jobId">>;

const seedJob = (t: Harness, job: JobSeed = {}) =>
  t.run(async (ctx) =>
    ctx.db.insert("jobs", {
      url: "https://example.com/a",
      type: "newsletter",
      status: "pending",
      archived: false,
      createdAt: 1,
      ...job,
    }),
  );

const seedSummary = (t: Harness, jobId: Id<"jobs">, summary: SummarySeed = {}) =>
  t.run(async (ctx) =>
    ctx.db.insert("summaries", {
      jobId,
      index: 0,
      title: "item",
      category: "c",
      summary: "body",
      keywords: [],
      url: "https://example.com/item",
      ...summary,
    }),
  );

const seedSuggestion = (t: Harness, jobId: Id<"jobs">) =>
  t.run(async (ctx) =>
    ctx.db.insert("suggestions", {
      jobId,
      summaryIndex: 0,
      topic: "t",
      pageName: "p",
      pageId: "pid",
      pageUrl: "https://notion.so/p",
      action: "append",
      content: "c",
      status: "pending",
    }),
  );

const getJob = (t: Harness, jobId: Id<"jobs">) => t.run(async (ctx) => ctx.db.get(jobId));

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

const firstPage = { numItems: 50, cursor: null };

describe("jobs:create", () => {
  it("queues a new url as a pending non-archived newsletter", async () => {
    const t = withConvex();
    const jobId = await t.mutation(api.jobs.create, { ...auth, url: "https://example.com/issue" });
    const job = await getJob(t, jobId);
    expect(job?.status).toBe("pending");
    expect(job?.type).toBe("newsletter");
    expect(job?.archived).toBe(false);
  });

  it("returns the existing job id instead of queueing the same email twice", async () => {
    const t = withConvex();
    const first = await t.mutation(api.jobs.create, { ...auth, url: "https://a.example", emailId: "gmail-1" });
    const second = await t.mutation(api.jobs.create, { ...auth, url: "https://b.example", emailId: "gmail-1" });
    expect(second).toBe(first);
    expect(await t.query(api.jobs.count, { ...auth })).toBe(1);
  });

  it("queues the same url twice, because dedup is keyed on emailId and not on the url", async () => {
    const t = withConvex();
    await t.mutation(api.jobs.create, { ...auth, url: "https://same.example" });
    await t.mutation(api.jobs.create, { ...auth, url: "https://same.example" });
    expect(await t.query(api.jobs.count, { ...auth })).toBe(2);
  });

  it("keeps imageId pointing at the first attachment of a multi-image paste", async () => {
    const t = withConvex();
    const [a, b] = await t.run(async (ctx) => [
      await ctx.storage.store(new Blob(["a"])),
      await ctx.storage.store(new Blob(["b"])),
    ]);
    const jobId = await t.mutation(api.jobs.create, { ...auth, url: "", type: "paper", imageIds: [a, b] });
    const job = await getJob(t, jobId);
    expect(job?.imageId).toBe(a);
    expect(job?.imageIds).toEqual([a, b]);
  });

  it("drops an empty attachment list rather than storing it", async () => {
    const t = withConvex();
    const jobId = await t.mutation(api.jobs.create, { ...auth, url: "", type: "paper", imageIds: [] });
    const job = await getJob(t, jobId);
    expect(job?.imageIds).toBeUndefined();
    expect(job?.imageId).toBeUndefined();
  });

  it("honours a caller supplied createdAt so a backfilled row lands on its real date", async () => {
    const t = withConvex();
    const jobId = await t.mutation(api.jobs.create, { ...auth, url: "https://old.example", createdAt: 42 });
    expect((await getJob(t, jobId))?.createdAt).toBe(42);
  });

  it("accepts every type in the domain vocabulary and rejects anything else", async () => {
    const t = withConvex();
    for (const type of JOB_TYPES) {
      const jobId = await t.mutation(api.jobs.create, { ...auth, url: `https://${type}.example`, type });
      expect((await getJob(t, jobId))?.type).toBe(type);
    }
    await expect(
      t.mutation(api.jobs.create, { ...auth, url: "https://x.example", type: "podcast" as JobType }),
    ).rejects.toThrow();
  });
});

describe("jobs:getContent", () => {
  it("returns the full body the list view only previews", async () => {
    const t = withConvex();
    const content = "x".repeat(500);
    const jobId = await seedJob(t, { content });
    expect(await t.query(api.jobs.getContent, { ...auth, jobId })).toBe(content);
  });

  it("returns null for a job that has been deleted", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.run(async (ctx) => ctx.db.delete(jobId));
    expect(await t.query(api.jobs.getContent, { ...auth, jobId })).toBeNull();
  });
});

describe("jobs:claimJob", () => {
  it("moves a pending job to summarizing and counts the attempt", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    const claimed = await t.mutation(api.jobs.claimJob, { ...auth, jobId });
    // The worker gets the pre-claim snapshot, so the status it sees is still pending.
    expect(claimed?.status).toBe("pending");
    const job = await getJob(t, jobId);
    expect(job?.status).toBe("summarizing");
    expect(job?.processAttempts).toBe(1);
    expect(typeof job?.summarizingStartedAt).toBe("number");
  });

  it("returns null for a job that is already being worked on, so two workers cannot claim it", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.jobs.claimJob, { ...auth, jobId });
    expect(await t.mutation(api.jobs.claimJob, { ...auth, jobId })).toBeNull();
    expect((await getJob(t, jobId))?.processAttempts).toBe(1);
  });

  it("keeps the original start time on a re-claim so the duration measures the first attempt", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { processAttempts: 1, summarizingStartedAt: 111 });
    await t.mutation(api.jobs.claimJob, { ...auth, jobId });
    const job = await getJob(t, jobId);
    expect(job?.summarizingStartedAt).toBe(111);
    expect(job?.processAttempts).toBe(2);
  });
});

describe("jobs:recordAttemptResult", () => {
  it("accumulates token usage across attempts", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.jobs.recordAttemptResult, { ...auth, jobId, inputTokens: 100, outputTokens: 10 });
    await t.mutation(api.jobs.recordAttemptResult, { ...auth, jobId, inputTokens: 50, outputTokens: 5 });
    const job = await getJob(t, jobId);
    expect(job?.inputTokens).toBe(150);
    expect(job?.outputTokens).toBe(15);
  });

  it("keeps the first completion timestamp when a later attempt also reports completed", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { summarizingCompletedAt: 555 });
    await t.mutation(api.jobs.recordAttemptResult, { ...auth, jobId, completed: true });
    expect((await getJob(t, jobId))?.summarizingCompletedAt).toBe(555);
  });

  it("writes nothing when the attempt reported neither tokens nor completion", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.jobs.recordAttemptResult, { ...auth, jobId, completed: false });
    const job = await getJob(t, jobId);
    expect(job?.inputTokens).toBeUndefined();
    expect(job?.summarizingCompletedAt).toBeUndefined();
  });

  it("ignores telemetry for a job that was deleted mid-run", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.run(async (ctx) => ctx.db.delete(jobId));
    await expect(t.mutation(api.jobs.recordAttemptResult, { ...auth, jobId, inputTokens: 1 })).resolves.toBeNull();
  });
});

describe("jobs:updateStatus", () => {
  it("clears the error left by a failed attempt once the job reaches done", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { status: "error", error: "gemini exited 1" });
    await t.mutation(api.jobs.updateStatus, { ...auth, jobId, status: "done" });
    expect((await getJob(t, jobId))?.error).toBeUndefined();
  });

  it("keeps the message when the terminal status is error", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.jobs.updateStatus, { ...auth, jobId, status: "error", error: "boom" });
    expect((await getJob(t, jobId))?.error).toBe("boom");
  });

  it("stamps the completion time on the first terminal status only", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.jobs.updateStatus, { ...auth, jobId, status: "summarizing" });
    expect((await getJob(t, jobId))?.summarizingCompletedAt).toBeUndefined();
    await t.mutation(api.jobs.updateStatus, { ...auth, jobId, status: "suggested" });
    const stamped = (await getJob(t, jobId))?.summarizingCompletedAt;
    expect(typeof stamped).toBe("number");
    await t.mutation(api.jobs.updateStatus, { ...auth, jobId, status: "done" });
    expect((await getJob(t, jobId))?.summarizingCompletedAt).toBe(stamped);
  });

  it("accepts every status in the domain vocabulary and rejects anything else", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    for (const status of JOB_STATUSES) {
      await t.mutation(api.jobs.updateStatus, { ...auth, jobId, status });
      expect((await getJob(t, jobId))?.status).toBe(status);
    }
    await expect(
      t.mutation(api.jobs.updateStatus, { ...auth, jobId, status: "queued" as JobStatus }),
    ).rejects.toThrow();
  });

  it("returns quietly when the job was deleted mid-run, like recordAttemptResult", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.run(async (ctx) => ctx.db.delete(jobId));
    await expect(t.mutation(api.jobs.updateStatus, { ...auth, jobId, status: "done" })).resolves.toBeNull();
  });
});

describe("worker queue reads", () => {
  it("getPending skips rows that are already summarizing", async () => {
    const t = withConvex();
    await seedJob(t, { status: "summarizing", url: "https://busy.example" });
    const pendingId = await seedJob(t, { url: "https://free.example" });
    expect((await t.query(api.jobs.getPending, { ...auth }))?._id).toBe(pendingId);
  });

  it("getAllPending drops the content blob the worker refetches through claimJob", async () => {
    const t = withConvex();
    await seedJob(t, { content: "x".repeat(500) });
    const [row] = await t.query(api.jobs.getAllPending, { ...auth });
    expect("content" in row).toBe(false);
    expect("contentPreview" in row).toBe(false);
  });

  it("getProcessable spans the three in-flight statuses and excludes finished jobs", async () => {
    const t = withConvex();
    await seedJob(t, { status: "done", url: "https://done.example" });
    await seedJob(t, { status: "suggesting", url: "https://suggesting.example" });
    await seedJob(t, { status: "error", url: "https://error.example" });
    await seedJob(t, { status: "pending", url: "https://pending.example" });
    await seedJob(t, { status: "summarizing", url: "https://summarizing.example" });
    const rows = await t.query(api.jobs.getProcessable, { ...auth });
    expect(rows.map((r) => r.status)).toEqual(["pending", "summarizing", "suggesting"]);
  });

  it("internalGetAllPending keeps the content the public listing strips", async () => {
    const t = withConvex();
    await seedJob(t, { content: "full body" });
    const rows = await t.query(internal.jobs.internalGetAllPending, {});
    expect(rows[0].content).toBe("full body");
  });
});

describe("tldr backfill helpers", () => {
  it("lists only finished jobs of the requested type that still have no tldr", async () => {
    const t = withConvex();
    const wanted = await seedJob(t, { status: "done", title: "needs tldr", createdAt: 3 });
    await seedJob(t, { status: "pending", title: "still running", createdAt: 2 });
    await seedJob(t, { status: "done", title: "has tldr", tldr: ["a"], createdAt: 4 });
    await seedJob(t, { status: "done", title: "wrong type", type: "paper", createdAt: 5 });
    await seedJob(t, { status: "done", title: "archived", archived: true, createdAt: 6 });
    const rows = await t.query(api.jobs.listNeedingTldr, { ...auth, type: "newsletter" });
    expect(rows).toEqual([{ _id: wanted, title: "needs tldr" }]);
  });

  it("clearAllTldr counts only the rows that actually carried a tldr", async () => {
    const t = withConvex();
    const withTldr = await seedJob(t, { tldr: ["a", "b"], tldrPending: true });
    await seedJob(t, { tldr: [] });
    await seedJob(t);
    const res = await t.mutation(api.jobs.clearAllTldr, { ...auth, type: "newsletter" });
    expect(res).toEqual({ cleared: 1, total: 3 });
    const job = await getJob(t, withTldr);
    expect(job?.tldr).toBeUndefined();
    expect(job?.tldrPending).toBe(false);
  });

  it("clearAllTldr leaves archived rows alone", async () => {
    const t = withConvex();
    const archivedId = await seedJob(t, { tldr: ["keep"], archived: true, archivedAt: 5 });
    const res = await t.mutation(api.jobs.clearAllTldr, { ...auth, type: "newsletter" });
    expect(res).toEqual({ cleared: 0, total: 0 });
    expect((await getJob(t, archivedId))?.tldr).toEqual(["keep"]);
  });

  it("setTldr clears the pending spinner flag as it writes", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { tldrPending: true });
    await t.mutation(api.jobs.setTldr, { ...auth, jobId, tldr: ["one", "two", "three"] });
    const job = await getJob(t, jobId);
    expect(job?.tldr).toEqual(["one", "two", "three"]);
    expect(job?.tldrPending).toBe(false);
  });

  it("requeues finished untldr'd jobs as tldr-only work", async () => {
    const t = withConvex();
    const target = await seedJob(t, { status: "done", error: "old failure" });
    await seedJob(t, { status: "suggested", tldr: ["already"] });
    await seedJob(t, { status: "pending" });
    const res = await t.mutation(api.jobs.queueTldrRetry, { ...auth });
    expect(res).toEqual({ marked: 1, scanned: 3 });
    const job = await getJob(t, target);
    expect(job?.status).toBe("pending");
    expect(job?.tldrOnly).toBe(true);
    expect(job?.tldrPending).toBe(true);
    expect(job?.error).toBeUndefined();
  });
});

describe("jobs:searchWithContent", () => {
  it("returns nothing for a blank query without touching the indexes", async () => {
    const t = withConvex();
    await seedJob(t, { title: "anything" });
    expect(await t.query(api.jobs.searchWithContent, { ...auth, type: "newsletter", query: "   " })).toEqual([]);
  });

  it("drops fuzzy index hits that do not contain the exact phrase", async () => {
    const t = withConvex();
    const exact = await seedJob(t, { title: "Steered Generation via Gradient Descent" });
    await seedJob(t, { title: "Random generation notes" });
    const rows = await t.query(api.jobs.searchWithContent, {
      ...auth,
      type: "newsletter",
      query: "Steered Generation",
    });
    expect(rows.map((r) => r._id)).toEqual([exact]);
  });

  it("finds a job through the text of one of its summaries", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { title: "unrelated headline" });
    await seedSummary(t, jobId, { summary: "quantization aware training beats post hoc rounding" });
    const rows = await t.query(api.jobs.searchWithContent, {
      ...auth,
      type: "newsletter",
      query: "quantization aware",
    });
    expect(rows.map((r) => r._id)).toEqual([jobId]);
  });

  it("finds a job through a chat message about it", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { title: "unrelated headline" });
    await t.run(async (ctx) =>
      ctx.db.insert("chats", { jobId, role: "user", content: "what about speculative decoding", createdAt: 1 }),
    );
    const rows = await t.query(api.jobs.searchWithContent, {
      ...auth,
      type: "newsletter",
      query: "speculative decoding",
    });
    expect(rows.map((r) => r._id)).toEqual([jobId]);
  });

  it("ignores the content body unless includeContent is set", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { title: "opaque headline", content: "the secret phrase lives in the body" });
    expect(await t.query(api.jobs.searchWithContent, { ...auth, type: "newsletter", query: "secret phrase" })).toEqual(
      [],
    );
    const rows = await t.query(api.jobs.searchWithContent, {
      ...auth,
      type: "newsletter",
      query: "secret phrase",
      includeContent: true,
    });
    expect(rows.map((r) => r._id)).toEqual([jobId]);
  });

  it("scopes hits to the requested type and archived flag", async () => {
    const t = withConvex();
    const newsletterId = await seedJob(t, { title: "shared headline" });
    await seedJob(t, { title: "shared headline", type: "paper" });
    await seedJob(t, { title: "shared headline", archived: true, archivedAt: 2 });
    const active = await t.query(api.jobs.searchWithContent, { ...auth, type: "newsletter", query: "shared headline" });
    expect(active.map((r) => r._id)).toEqual([newsletterId]);
    const archived = await t.query(api.jobs.searchWithContent, {
      ...auth,
      type: "newsletter",
      query: "shared headline",
      archived: true,
    });
    expect(archived).toHaveLength(1);
    expect(archived[0]._id).not.toBe(newsletterId);
  });

  it("returns the matches newest first", async () => {
    const t = withConvex();
    const older = await seedJob(t, { title: "repeated headline", createdAt: 1 });
    const newest = await seedJob(t, { title: "repeated headline", createdAt: 9 });
    const rows = await t.query(api.jobs.searchWithContent, {
      ...auth,
      type: "newsletter",
      query: "repeated headline",
    });
    expect(rows.map((r) => r._id)).toEqual([newest, older]);
  });

  it("finds the exact phrase behind more token-only noise rows than the limit allows", async () => {
    const t = withConvex();
    // Seeded first, so they are the rows a candidate cap of `limit` would take.
    for (const i of [1, 2, 3, 4, 5]) await seedJob(t, { title: `generation roundup ${i}`, createdAt: 10 + i });
    const exact = await seedJob(t, { title: "Steered Generation via Gradient Descent", createdAt: 1 });
    const rows = await t.query(api.jobs.searchWithContent, {
      ...auth,
      type: "newsletter",
      query: "Steered Generation",
      limit: 2,
    });
    expect(rows.map((r) => r._id)).toEqual([exact]);
  });

  it("does the same for a body match when includeContent is on", async () => {
    const t = withConvex();
    for (const i of [1, 2, 3, 4, 5])
      await seedJob(t, { title: `roundup ${i}`, content: `generation notes ${i}`, createdAt: 10 + i });
    const exact = await seedJob(t, {
      title: "opaque headline",
      content: "steered generation via gradient descent",
      createdAt: 1,
    });
    const rows = await t.query(api.jobs.searchWithContent, {
      ...auth,
      type: "newsletter",
      query: "Steered Generation",
      limit: 2,
      includeContent: true,
    });
    expect(rows.map((r) => r._id)).toEqual([exact]);
  });

  it("still reaches a body match past the 75th content hit when the caller asks for 100", async () => {
    const t = withConvex();
    // A caller with limit > the default page size must not get a NARROWER
    // candidate window than the plain limit=cap take it replaced.
    for (let i = 0; i < 90; i++)
      await seedJob(t, { title: `noise ${i}`, content: `generation notes ${i}`, createdAt: i + 1 });
    const exact = await seedJob(t, { title: "opaque headline", content: "steered generation is here", createdAt: 999 });
    const rows = await t.query(api.jobs.searchWithContent, {
      ...auth,
      type: "newsletter",
      query: "steered generation",
      limit: 100,
      includeContent: true,
    });
    expect(rows.map((r) => r._id)).toEqual([exact]);
  });

  it("keeps a chat-only match even behind more summary matches than the lookup budget", async () => {
    const t = withConvex();
    // More summary matches than the per-query job-lookup allowance, so draining
    // summaries before chats would spend the whole allowance before the chat.
    for (let i = 0; i < 120; i++) {
      const noise = await seedJob(t, { title: `noise ${i}`, createdAt: i + 1 });
      await seedSummary(t, noise, { summary: `gradient descent notes ${i}` });
    }
    const chatOnly = await seedJob(t, { title: "chat only", createdAt: 999999 });
    await t.run(async (ctx) =>
      ctx.db.insert("chats", { jobId: chatOnly, role: "user", content: "about gradient descent", createdAt: 1 }),
    );
    const rows = await t.query(api.jobs.searchWithContent, { ...auth, type: "newsletter", query: "gradient descent" });
    expect(rows[0]?._id).toBe(chatOnly);
  });

  it("caps the result at the requested limit", async () => {
    const t = withConvex();
    for (const createdAt of [1, 2, 3]) await seedJob(t, { title: "repeated headline", createdAt });
    const rows = await t.query(api.jobs.searchWithContent, {
      ...auth,
      type: "newsletter",
      query: "repeated headline",
      limit: 2,
    });
    expect(rows).toHaveLength(2);
  });

  it("ships a content preview rather than the whole body", async () => {
    const t = withConvex();
    await seedJob(t, { title: "previewed headline", content: `${"z".repeat(400)} tail` });
    const [row] = await t.query(api.jobs.searchWithContent, {
      ...auth,
      type: "newsletter",
      query: "previewed headline",
    });
    expect("content" in row).toBe(false);
    expect(row.contentPreview).toHaveLength(120);
  });
});

describe("jobs:getById", () => {
  it("returns null for a malformed id instead of throwing at the UI", async () => {
    const t = withConvex();
    expect(await t.query(api.jobs.getById, { ...auth, jobId: "not-an-id" })).toBeNull();
  });

  it("returns null for a well formed id belonging to another table", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    const summaryId = await seedSummary(t, jobId);
    expect(await t.query(api.jobs.getById, { ...auth, jobId: summaryId })).toBeNull();
  });

  it("returns the whole row, content included, for a real id", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { content: "body" });
    const job = await t.query(api.jobs.getById, { ...auth, jobId });
    expect(job?.content).toBe("body");
  });
});

describe("date distributions", () => {
  it("buckets papers by their arXiv publication month and by upload day", async () => {
    const t = withConvex();
    await seedJob(t, {
      type: "paper",
      url: "https://arxiv.org/abs/2406.12345",
      createdAt: Date.UTC(2025, 0, 15),
    });
    await seedJob(t, { type: "paper", url: "https://example.com/blog", createdAt: Date.UTC(2025, 0, 15) });
    const stats = await t.query(api.jobs.jobDateStats, { ...auth, type: "paper" });
    expect(stats.created).toEqual([{ date: "2025-01-15", count: 2 }]);
    expect(stats.published).toEqual([
      { date: "2024-06", count: 1 },
      { date: "2025-01", count: 1 },
    ]);
  });

  it("leaves the published axis empty for a type that is not paper", async () => {
    const t = withConvex();
    await seedJob(t, { createdAt: Date.UTC(2025, 4, 2) });
    const stats = await t.query(api.jobs.jobDateStats, { ...auth, type: "newsletter" });
    expect(stats.published).toEqual([]);
    expect(stats.created).toEqual([{ date: "2025-05-02", count: 1 }]);
  });

  it("counts archived rows separately from active ones", async () => {
    const t = withConvex();
    await seedJob(t, { createdAt: Date.UTC(2025, 4, 2) });
    await seedJob(t, { createdAt: Date.UTC(2025, 4, 2), archived: true, archivedAt: 1 });
    const active = await t.query(api.jobs.jobDateStats, { ...auth, type: "newsletter" });
    const archived = await t.query(api.jobs.jobDateStats, { ...auth, type: "newsletter", archived: true });
    expect(active.created).toEqual([{ date: "2025-05-02", count: 1 }]);
    expect(archived.created).toEqual([{ date: "2025-05-02", count: 1 }]);
  });
});

describe("jobs:listByDate", () => {
  it("returns the issues whose title date matches the clicked bar", async () => {
    const t = withConvex();
    const wanted = await seedJob(t, { title: "TLDR 2026-06-25", createdAt: Date.UTC(2026, 6, 1) });
    await seedJob(t, { title: "TLDR 2026-06-26", createdAt: Date.UTC(2026, 6, 1) });
    const rows = await t.query(api.jobs.listByDate, {
      ...auth,
      type: "newsletter",
      basis: "issue",
      dateKey: "2026-06-25",
    });
    expect(rows.map((r) => r._id)).toEqual([wanted]);
  });

  it("falls back to the upload day when the title carries no issue date", async () => {
    const t = withConvex();
    const wanted = await seedJob(t, { title: "AlphaSignal daily", createdAt: Date.UTC(2026, 5, 25) });
    const rows = await t.query(api.jobs.listByDate, {
      ...auth,
      type: "newsletter",
      basis: "issue",
      dateKey: "2026-06-25",
    });
    expect(rows.map((r) => r._id)).toEqual([wanted]);
  });

  it("treats an issue with no url but pasted content as the paste source", async () => {
    const t = withConvex();
    const pasted = await seedJob(t, { title: "pasted issue", url: "", content: "body" });
    await seedJob(t, { title: "TLDR 2026-06-25" });
    const rows = await t.query(api.jobs.listByDate, { ...auth, type: "newsletter", source: "paste" });
    expect(rows.map((r) => r._id)).toEqual([pasted]);
  });

  it("intersects the date bucket with the source chip when both are set", async () => {
    const t = withConvex();
    const wanted = await seedJob(t, { title: "TLDR 2026-06-25", createdAt: 3 });
    await seedJob(t, { title: "AlphaSignal 2026-06-25", createdAt: 2 });
    await seedJob(t, { title: "TLDR 2026-06-26", createdAt: 1 });
    const rows = await t.query(api.jobs.listByDate, {
      ...auth,
      type: "newsletter",
      basis: "issue",
      dateKey: "2026-06-25",
      source: "tldr",
    });
    expect(rows.map((r) => r._id)).toEqual([wanted]);
  });
});

describe("jobs:newsletterStats", () => {
  it("counts issues per source but sums summarized elements per issue date", async () => {
    const t = withConvex();
    await seedJob(t, { title: "TLDR 2026-06-25", status: "done", summaryCount: 4 });
    await seedJob(t, { title: "AlphaSignal 2026-06-25", status: "pending", summaryCount: 2 });
    await seedJob(t, { title: "TLDR 2026-06-26", status: "done", summaryCount: 1 });
    const stats = await t.query(api.jobs.newsletterStats, { ...auth });
    expect(stats).toEqual({
      count: 3,
      done: 2,
      elements: 7,
      bySource: { tldr: 2, alphasignal: 1 },
      byDate: [
        {
          date: "2026-06-25",
          total: 2,
          done: 1,
          elements: 6,
          srcElements: { tldr: 4, alphasignal: 2 },
        },
        { date: "2026-06-26", total: 1, done: 1, elements: 1, srcElements: { tldr: 1 } },
      ],
    });
  });

  it("reads the denormalized summaryCount, so a job with unsynced rollups contributes zero elements", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { title: "TLDR 2026-06-25", status: "done" });
    await seedSummary(t, jobId);
    const stats = await t.query(api.jobs.newsletterStats, { ...auth });
    expect(stats.elements).toBe(0);
  });
});

describe("jobs:list", () => {
  it("pages newest first and reports isDone only on the final page", async () => {
    const t = withConvex();
    for (const createdAt of [1, 2, 3]) await seedJob(t, { createdAt, url: `https://n${createdAt}.example` });
    const page1 = await t.query(api.jobs.list, { ...auth, paginationOpts: { numItems: 2, cursor: null } });
    expect(page1.page.map((j) => j.createdAt)).toEqual([3, 2]);
    expect(page1.isDone).toBe(false);
    const page2 = await t.query(api.jobs.list, {
      ...auth,
      paginationOpts: { numItems: 2, cursor: page1.continueCursor },
    });
    expect(page2.page.map((j) => j.createdAt)).toEqual([1]);
    expect(page2.isDone).toBe(true);
  });

  it("orders the archived list by archive time rather than creation time", async () => {
    const t = withConvex();
    const older = await seedJob(t, { createdAt: 100, archived: true, archivedAt: 1 });
    const newer = await seedJob(t, { createdAt: 1, archived: true, archivedAt: 100 });
    const res = await t.query(api.jobs.list, { ...auth, archived: true, paginationOpts: firstPage });
    expect(res.page.map((j) => j._id)).toEqual([newer, older]);
  });

  it("defaults to non-archived newsletters when no filter is given", async () => {
    const t = withConvex();
    const wanted = await seedJob(t);
    await seedJob(t, { type: "paper" });
    await seedJob(t, { archived: true, archivedAt: 1 });
    const res = await t.query(api.jobs.list, { ...auth, paginationOpts: firstPage });
    expect(res.page.map((j) => j._id)).toEqual([wanted]);
  });

  it("replaces the body with a preview capped at 120 characters", async () => {
    const t = withConvex();
    await seedJob(t, { content: "y".repeat(500) });
    const res = await t.query(api.jobs.list, { ...auth, paginationOpts: firstPage });
    expect("content" in res.page[0]).toBe(false);
    expect(res.page[0].contentPreview).toHaveLength(120);
  });

  it("never cuts the preview through a surrogate pair", async () => {
    const t = withConvex();
    await seedJob(t, { content: `${"a".repeat(119)}\u{1F600}rest` });
    const res = await t.query(api.jobs.list, { ...auth, paginationOpts: firstPage });
    expect(res.page[0].contentPreview).toHaveLength(119);
  });

  it("omits contentPreview entirely for a job with no body", async () => {
    const t = withConvex();
    await seedJob(t);
    const res = await t.query(api.jobs.list, { ...auth, paginationOpts: firstPage });
    expect("contentPreview" in res.page[0]).toBe(false);
  });

  it("returns an empty page for a tab key that is not a job type", async () => {
    const t = withConvex();
    await seedJob(t);
    const res = await t.query(api.jobs.list, { ...auth, type: "insights", paginationOpts: firstPage });
    expect(res.page).toEqual([]);
    expect(res.isDone).toBe(true);
  });
});

describe("offset paging and counts", () => {
  it("returns the requested window of the newest-first list", async () => {
    const t = withConvex();
    for (const createdAt of [1, 2, 3, 4, 5]) await seedJob(t, { createdAt, url: `https://n${createdAt}.example` });
    const rows = await t.query(api.jobs.listOffset, { ...auth, skip: 2, limit: 2 });
    expect(rows.map((j) => j.createdAt)).toEqual([3, 2]);
  });

  it("returns fewer rows than asked for when the window runs off the end", async () => {
    const t = withConvex();
    await seedJob(t, { createdAt: 1 });
    const rows = await t.query(api.jobs.listOffset, { ...auth, skip: 0, limit: 10 });
    expect(rows).toHaveLength(1);
  });

  it("counts only the requested type and archived flag", async () => {
    const t = withConvex();
    await seedJob(t);
    await seedJob(t);
    await seedJob(t, { archived: true, archivedAt: 1 });
    await seedJob(t, { type: "paper" });
    expect(await t.query(api.jobs.count, { ...auth })).toBe(2);
    expect(await t.query(api.jobs.count, { ...auth, archived: true })).toBe(1);
    expect(await t.query(api.jobs.count, { ...auth, type: "paper" })).toBe(1);
  });

  it("getLatest crosses every type and returns the newest row", async () => {
    const t = withConvex();
    await seedJob(t, { createdAt: 5 });
    const newest = await seedJob(t, { createdAt: 9, type: "paper" });
    expect((await t.query(api.jobs.getLatest, { ...auth }))?._id).toBe(newest);
  });

  it("listAllMeta reports the content length instead of the content", async () => {
    const t = withConvex();
    await seedJob(t, { content: "12345" });
    const res = await t.query(api.jobs.listAllMeta, { ...auth, paginationOpts: firstPage });
    expect("content" in res.page[0]).toBe(false);
    expect(res.page[0].contentLength).toBe(5);
  });

  it("listAll ships the raw rows, content and all", async () => {
    const t = withConvex();
    await seedJob(t, { content: "12345" });
    const res = await t.query(api.jobs.listAll, { ...auth, paginationOpts: firstPage });
    expect(res.page[0].content).toBe("12345");
  });

  it("listPaperRefs returns newest-first ids for active papers only", async () => {
    const t = withConvex();
    const older = await seedJob(t, { type: "paper", createdAt: 1, title: "older", url: "https://p1.example" });
    const newer = await seedJob(t, { type: "paper", createdAt: 2, title: "newer", url: "https://p2.example" });
    await seedJob(t, { type: "paper", createdAt: 3, archived: true, archivedAt: 1 });
    await seedJob(t, { createdAt: 4 });
    const refs = await t.query(api.jobs.listPaperRefs, { ...auth });
    expect(refs).toEqual([
      { jobId: newer, url: "https://p2.example", title: "newer" },
      { jobId: older, url: "https://p1.example", title: "older" },
    ]);
  });
});

describe("archive semantics", () => {
  it("archiving stamps archivedAt and moves the row out of the active list", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.jobs.archive, { ...auth, jobId });
    const job = await getJob(t, jobId);
    expect(job?.archived).toBe(true);
    expect(typeof job?.archivedAt).toBe("number");
    expect(await t.query(api.jobs.count, { ...auth })).toBe(0);
    expect(await t.query(api.jobs.count, { ...auth, archived: true })).toBe(1);
  });

  it("unarchiving clears the archive timestamp so the row sorts by creation again", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { archived: true, archivedAt: 7 });
    await t.mutation(api.jobs.unarchive, { ...auth, jobId });
    const job = await getJob(t, jobId);
    expect(job?.archived).toBe(false);
    expect(job?.archivedAt).toBeUndefined();
  });

  it("backfillArchived only touches legacy rows that never had the flag", async () => {
    const t = withConvex();
    const legacy = await seedJob(t, { archived: undefined });
    await seedJob(t, { archived: true, archivedAt: 1 });
    expect(await t.mutation(api.jobs.backfillArchived, { ...auth })).toBe(1);
    expect((await getJob(t, legacy))?.archived).toBe(false);
    expect(await t.mutation(api.jobs.backfillArchived, { ...auth })).toBe(0);
  });
});

describe("retry paths", () => {
  it("retry drops the derived rows, clears the error and resets the rollup", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, {
      type: "paper",
      status: "error",
      error: "boom",
      summaryCount: 1,
      summaryScores: [7],
    });
    await seedSummary(t, jobId, { scores: paperScores(7) });
    await seedSuggestion(t, jobId);
    await t.mutation(api.jobs.retry, { ...auth, jobId });
    const job = await getJob(t, jobId);
    expect(job?.status).toBe("pending");
    expect(job?.error).toBeUndefined();
    expect(job?.summaryCount).toBe(0);
    expect(job?.summaryScores).toEqual([]);
    const leftovers = await t.run(async (ctx) => ({
      summaries: await ctx.db
        .query("summaries")
        .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
        .collect(),
      suggestions: await ctx.db
        .query("suggestions")
        .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
        .collect(),
    }));
    expect(leftovers.summaries).toHaveLength(0);
    expect(leftovers.suggestions).toHaveLength(0);
  });

  it("resets arxiv papers whose content was never stored and leaves the rest scanned but untouched", async () => {
    const t = withConvex();
    const empty = await seedJob(t, { type: "paper", url: "https://arxiv.org/abs/2406.1", status: "done", tldr: ["a"] });
    const full = await seedJob(t, {
      type: "paper",
      url: "https://arxiv.org/pdf/2406.2",
      status: "done",
      content: "c".repeat(300),
    });
    const elsewhere = await seedJob(t, { type: "paper", url: "https://example.com/p", status: "done" });
    await seedJob(t, { type: "paper", url: "https://arxiv.org/abs/2406.3", archived: true, archivedAt: 1 });
    const res = await t.mutation(api.jobs.retryArxivPapersWithoutContent, { ...auth });
    expect(res).toEqual({ reset: 1, scanned: 3 });
    const resetJob = await getJob(t, empty);
    expect(resetJob?.status).toBe("pending");
    expect(resetJob?.tldr).toBeUndefined();
    expect(resetJob?.tldrPending).toBe(false);
    expect((await getJob(t, full))?.status).toBe("done");
    expect((await getJob(t, elsewhere))?.status).toBe("done");
  });

  it("skips an arxiv paper a worker is still summarizing but retries one that errored", async () => {
    const t = withConvex();
    const running = await seedJob(t, { type: "paper", url: "https://arxiv.org/abs/2406.9", status: "summarizing" });
    const failed = await seedJob(t, { type: "paper", url: "https://arxiv.org/abs/2406.10", status: "error" });
    const res = await t.mutation(api.jobs.retryArxivPapersWithoutContent, { ...auth });
    expect(res).toEqual({ reset: 1, scanned: 2 });
    expect((await getJob(t, running))?.status).toBe("summarizing");
    expect((await getJob(t, failed))?.status).toBe("pending");
  });

  it("still cleans a queued arxiv paper, because pending means no worker has claimed it", async () => {
    const t = withConvex();
    const queued = await seedJob(t, {
      type: "paper",
      url: "https://arxiv.org/abs/2406.11",
      status: "pending",
      tldr: ["stale tldr"],
      tldrPending: true,
    });
    await seedSummary(t, queued);
    await seedSuggestion(t, queued);
    expect(await t.mutation(api.jobs.retryArxivPapersWithoutContent, { ...auth })).toEqual({ reset: 1, scanned: 1 });
    const job = await getJob(t, queued);
    expect(job?.status).toBe("pending");
    expect(job?.tldr).toBeUndefined();
    expect(job?.tldrPending).toBe(false);
    expect(await t.run(async (ctx) => ctx.db.query("summaries").collect())).toEqual([]);
    expect(await t.run(async (ctx) => ctx.db.query("suggestions").collect())).toEqual([]);
  });

  it("leaves an in-flight paper alone, so the rescore sweep cannot hand a running job to a second worker", async () => {
    const t = withConvex();
    const running = await seedJob(t, { type: "paper", content: "c".repeat(300), status: "summarizing" });
    await seedSummary(t, running);
    expect(await t.mutation(api.jobs.retryPaperJobsWithoutScores, { ...auth })).toEqual({ marked: 0, scanned: 1 });
    expect((await getJob(t, running))?.status).toBe("summarizing");
    expect((await getJob(t, running))?.scoresOnly).toBeUndefined();
  });

  it("still rescores a paper whose last attempt ended in error, because error is terminal", async () => {
    const t = withConvex();
    const failed = await seedJob(t, { type: "paper", content: "c".repeat(300), status: "error", error: "boom" });
    await seedSummary(t, failed);
    expect(await t.mutation(api.jobs.retryPaperJobsWithoutScores, { ...auth })).toEqual({ marked: 1, scanned: 1 });
    const job = await getJob(t, failed);
    expect(job?.status).toBe("pending");
    expect(job?.scoresOnly).toBe(true);
    expect(job?.error).toBeUndefined();
  });

  it("marks papers whose summaries are missing any structured score field", async () => {
    const t = withConvex();
    const missing = await seedJob(t, { type: "paper", content: "c".repeat(300), status: "done" });
    await seedSummary(t, missing, { scores: paperScores(7), researchLevel: "phd", reasoning: "r" });
    const complete = await seedJob(t, { type: "paper", content: "c".repeat(300), status: "done" });
    await seedSummary(t, complete, {
      scores: paperScores(7),
      researchLevel: "phd",
      reasoning: "r",
      priorWork: [{ citation: "x", relation: "y" }],
    });
    const short = await seedJob(t, { type: "paper", content: "too short", status: "done" });
    await seedSummary(t, short);
    await seedJob(t, { type: "paper", content: "c".repeat(300), status: "done" });
    const res = await t.mutation(api.jobs.retryPaperJobsWithoutScores, { ...auth });
    expect(res).toEqual({ marked: 1, scanned: 4 });
    const job = await getJob(t, missing);
    expect(job?.status).toBe("pending");
    expect(job?.scoresOnly).toBe(true);
    expect((await getJob(t, complete))?.status).toBe("done");
    expect((await getJob(t, short))?.status).toBe("done");
  });

  it("marks only unscored articles unless force is passed", async () => {
    const t = withConvex();
    const unscored = await seedJob(t, { type: "article", status: "done" });
    await seedSummary(t, unscored);
    const scored = await seedJob(t, { type: "article", status: "suggested" });
    await seedSummary(t, scored, { articleScores: articleScores(6) });
    const unfinished = await seedJob(t, { type: "article", status: "pending" });
    await seedSummary(t, unfinished);
    expect(await t.mutation(api.jobs.retryArticleJobsWithoutScores, { ...auth })).toEqual({ marked: 1, scanned: 3 });
    expect((await getJob(t, scored))?.status).toBe("suggested");
    await t.mutation(api.jobs.updateStatus, { ...auth, jobId: unscored, status: "done" });
    expect(await t.mutation(api.jobs.retryArticleJobsWithoutScores, { ...auth, force: true })).toEqual({
      marked: 2,
      scanned: 3,
    });
    expect((await getJob(t, scored))?.scoresOnly).toBe(true);
  });

  it("clears the one-shot rescore flags", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { scoresOnly: true, tldrOnly: true });
    await t.mutation(api.jobs.clearScoresOnly, { ...auth, jobId });
    await t.mutation(api.jobs.clearTldrOnly, { ...auth, jobId });
    const job = await getJob(t, jobId);
    expect(job?.scoresOnly).toBeUndefined();
    expect(job?.tldrOnly).toBeUndefined();
  });
});

describe("jobs:updateType", () => {
  it("brings the paper scores into the rollup when a newsletter is retyped", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await seedSummary(t, jobId, { scores: paperScores(7.5) });
    await t.mutation(api.jobs.updateType, { ...auth, jobId, type: "paper" });
    const job = await getJob(t, jobId);
    expect(job?.type).toBe("paper");
    expect(job?.summaryCount).toBe(1);
    expect(job?.summaryScores).toEqual([7.5]);
  });

  it("drops the scores again when the same job is retyped away from paper", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { type: "paper" });
    await seedSummary(t, jobId, { scores: paperScores(7.5) });
    await t.mutation(api.jobs.updateType, { ...auth, jobId, type: "paper" });
    await t.mutation(api.jobs.updateType, { ...auth, jobId, type: "article" });
    expect((await getJob(t, jobId))?.summaryScores).toEqual([]);
  });

  it("rejects a type outside the domain vocabulary", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await expect(t.mutation(api.jobs.updateType, { ...auth, jobId, type: "podcast" as JobType })).rejects.toThrow();
  });
});

describe("pasted images", () => {
  it("prefers the multi-image list over the legacy single id", async () => {
    const t = withConvex();
    const [a, b, legacy] = await t.run(async (ctx) => [
      await ctx.storage.store(new Blob(["a"])),
      await ctx.storage.store(new Blob(["b"])),
      await ctx.storage.store(new Blob(["legacy"])),
    ]);
    const jobId = await seedJob(t, { imageId: legacy, imageIds: [a, b] });
    const expected = await t.run(async (ctx) => [await ctx.storage.getUrl(a), await ctx.storage.getUrl(b)]);
    expect(await t.query(api.jobs.imageUrls, { ...auth, jobId })).toEqual(expected);
  });

  it("falls back to the single imageId for rows written before multi-paste", async () => {
    const t = withConvex();
    const legacy = await t.run(async (ctx) => ctx.storage.store(new Blob(["legacy"])));
    const jobId = await seedJob(t, { imageId: legacy });
    const expected = await t.run(async (ctx) => ctx.storage.getUrl(legacy));
    expect(await t.query(api.jobs.imageUrls, { ...auth, jobId })).toEqual([expected]);
    expect(await t.query(api.jobs.imageUrl, { ...auth, jobId })).toBe(expected);
  });

  it("returns nothing for a job with no paste and for a job that is gone", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    expect(await t.query(api.jobs.imageUrls, { ...auth, jobId })).toEqual([]);
    expect(await t.query(api.jobs.imageUrl, { ...auth, jobId })).toBeNull();
    await t.run(async (ctx) => ctx.db.delete(jobId));
    expect(await t.query(api.jobs.imageUrls, { ...auth, jobId })).toEqual([]);
  });
});

describe("small field writers", () => {
  it("stamps the canonical url an agent recovered from a pasted screenshot", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { url: "" });
    await t.mutation(api.jobs.setUrl, { ...auth, jobId, url: "https://arxiv.org/abs/2406.1" });
    expect((await getJob(t, jobId))?.url).toBe("https://arxiv.org/abs/2406.1");
  });

  it("stores title, content, provider and emailId without disturbing the status", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, { status: "summarizing" });
    await t.mutation(api.jobs.updateTitle, { ...auth, jobId, title: "TLDR 2026-06-25" });
    await t.mutation(api.jobs.setContent, { ...auth, jobId, content: "fetched body" });
    await t.mutation(api.jobs.setProvider, { ...auth, jobId, provider: "codex" });
    await t.mutation(api.jobs.patchEmailId, { ...auth, jobId, emailId: "gmail-9" });
    const job = await getJob(t, jobId);
    expect(job?.title).toBe("TLDR 2026-06-25");
    expect(job?.content).toBe("fetched body");
    expect(job?.provider).toBe("codex");
    expect(job?.emailId).toBe("gmail-9");
    expect(job?.status).toBe("summarizing");
  });

  it("patching an emailId after the fact does not retroactively dedupe the row", async () => {
    const t = withConvex();
    const first = await t.mutation(api.jobs.create, { ...auth, url: "https://a.example" });
    const second = await t.mutation(api.jobs.create, { ...auth, url: "https://b.example" });
    await t.mutation(api.jobs.patchEmailId, { ...auth, jobId: first, emailId: "gmail-1" });
    await t.mutation(api.jobs.patchEmailId, { ...auth, jobId: second, emailId: "gmail-1" });
    expect(await t.query(api.jobs.count, { ...auth })).toBe(2);
  });

  it("setTldrPending toggles the spinner flag on its own", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.jobs.setTldrPending, { ...auth, jobId, pending: true });
    expect((await getJob(t, jobId))?.tldrPending).toBe(true);
    await t.mutation(api.jobs.setTldrPending, { ...auth, jobId, pending: false });
    expect((await getJob(t, jobId))?.tldrPending).toBe(false);
  });

  it("hands out an upload url for a clipboard paste", async () => {
    const t = withConvex();
    expect(await t.mutation(api.jobs.generateUploadUrl, { ...auth })).toContain("http");
  });
});

describe("jobs:remove", () => {
  it("deletes the job together with its summaries and suggestions", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await seedSummary(t, jobId);
    await seedSuggestion(t, jobId);
    const other = await seedJob(t);
    await seedSummary(t, other);
    await t.mutation(api.jobs.remove, { ...auth, jobId });
    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      summaries: await ctx.db.query("summaries").collect(),
      suggestions: await ctx.db.query("suggestions").collect(),
    }));
    expect(state.job).toBeNull();
    expect(state.summaries.map((s) => s.jobId)).toEqual([other]);
    expect(state.suggestions).toHaveLength(0);
  });
});
