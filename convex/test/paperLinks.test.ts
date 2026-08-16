import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { auth, withConvex } from "./harness.setup";

type Harness = ReturnType<typeof withConvex>;

// The summaries vector index is 384-dimensional; the exact values never matter
// here because the two vector-search actions are out of scope.
const VECTOR = Array.from({ length: 384 }, () => 0.1);

async function seedJob(
  t: Harness,
  opts: {
    type?: "paper" | "newsletter" | "article";
    status?: "pending" | "summarizing" | "done" | "error";
    archived?: boolean | null;
    createdAt?: number;
    url?: string;
  } = {},
): Promise<Id<"jobs">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("jobs", {
      url: opts.url ?? "https://arxiv.org/abs/2401.00001",
      type: opts.type ?? "paper",
      status: opts.status ?? "done",
      createdAt: opts.createdAt ?? 1,
      // null means "legacy row that predates the flag", which the index treats
      // differently from false.
      ...(opts.archived === null ? {} : { archived: opts.archived ?? false }),
    }),
  );
}

async function seedSummary(
  t: Harness,
  jobId: Id<"jobs">,
  opts: { title?: string; url?: string; embedded?: boolean; linkedAt?: number; keywords?: string[] } = {},
): Promise<Id<"summaries">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("summaries", {
      jobId,
      index: 0,
      title: opts.title ?? "seeded summary",
      category: "c",
      summary: "body",
      keywords: opts.keywords ?? [],
      url: opts.url ?? "https://arxiv.org/abs/2401.00001",
      ...(opts.embedded === false ? {} : { embedding: VECTOR }),
      ...(opts.linkedAt === undefined ? {} : { paperLinksAt: opts.linkedAt }),
    }),
  );
}

async function seedProject(t: Harness, slug: string, title = `Project ${slug}`): Promise<Id<"researchProjects">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("researchProjects", { slug, title, kind: "own", phase: "ideation", updatedAt: 1 }),
  );
}

async function seedLink(
  t: Harness,
  opts: {
    jobId: Id<"jobs">;
    summaryId: Id<"summaries">;
    researchId: Id<"researchProjects">;
    slug?: string;
    score: number;
    status?: "suggested" | "linked" | "rejected";
  },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("paperLinks", {
      jobId: opts.jobId,
      summaryId: opts.summaryId,
      researchId: opts.researchId,
      researchSlug: opts.slug ?? "proj",
      researchTitle: "Project",
      score: opts.score,
      reason: "because",
      status: opts.status ?? "suggested",
      createdAt: 1,
    }),
  );
}

describe("summary vector lookup", () => {
  it("returns null when the summary is gone", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    const summaryId = await seedSummary(t, jobId);
    await t.run(async (ctx) => ctx.db.delete(summaryId));
    expect(await t.query(internal.paperLinks.summaryVec, { summaryId })).toBeNull();
  });

  it("reports a summary that was never embedded as a null vector while still naming its job", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    const summaryId = await seedSummary(t, jobId, { embedded: false });
    expect(await t.query(internal.paperLinks.summaryVec, { summaryId })).toEqual({ embedding: null, jobId });
  });
});

describe("summary cards", () => {
  it("keeps the order the ids were asked for and skips ones that no longer resolve", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    const first = await seedSummary(t, jobId, { title: "First" });
    const second = await seedSummary(t, jobId, { title: "Second" });
    const removed = await seedSummary(t, jobId, { title: "Removed" });
    await t.run(async (ctx) => ctx.db.delete(removed));
    const cards = await t.query(internal.paperLinks.summaryCards, { ids: [second, removed, first] });
    expect(cards.map((c) => c.title)).toEqual(["Second", "First"]);
  });

  it("carries the job type onto each card so the ui can label the source", async () => {
    const t = withConvex();
    const paper = await seedJob(t, { type: "paper" });
    const letter = await seedJob(t, { type: "newsletter", url: "https://n/1" });
    const paperSummary = await seedSummary(t, paper, { keywords: ["rl"] });
    const letterSummary = await seedSummary(t, letter);
    const cards = await t.query(internal.paperLinks.summaryCards, { ids: [paperSummary, letterSummary] });
    expect(cards.map((c) => c.type)).toEqual(["paper", "newsletter"]);
    expect(cards[0].keywords).toEqual(["rl"]);
  });
});

describe("project lookup", () => {
  it("skips project ids that no longer resolve", async () => {
    const t = withConvex();
    const alive = await seedProject(t, "alive");
    const gone = await seedProject(t, "gone");
    await t.run(async (ctx) => ctx.db.delete(gone));
    const projects = await t.query(internal.paperLinks.projectsByIds, { ids: [gone, alive] });
    expect(projects.map((p) => p.slug)).toEqual(["alive"]);
  });
});

describe("research links shown for a job", () => {
  it("hides rejected suggestions and puts the strongest of the rest first", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    const summaryId = await seedSummary(t, jobId);
    const researchId = await seedProject(t, "proj");
    await seedLink(t, { jobId, summaryId, researchId, score: 0.4 });
    await seedLink(t, { jobId, summaryId, researchId, score: 0.99, status: "rejected" });
    await seedLink(t, { jobId, summaryId, researchId, score: 0.8, status: "linked" });
    const rows = await t.query(api.paperLinks.listByJob, { ...auth, jobId });
    expect(rows.map((r) => r.score)).toEqual([0.8, 0.4]);
  });

  it("returns nothing for a job that has no suggestions at all", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    expect(await t.query(api.paperLinks.listByJob, { ...auth, jobId })).toEqual([]);
  });
});

describe("summaries still awaiting link generation", () => {
  it("offers only finished, unarchived paper jobs whose summary is embedded and unlinked", async () => {
    const t = withConvex();
    const ready = await seedJob(t, { url: "https://p/ready" });
    const readySummary = await seedSummary(t, ready);
    const unfinished = await seedJob(t, { url: "https://p/unfinished", status: "summarizing" });
    await seedSummary(t, unfinished);
    const archived = await seedJob(t, { url: "https://p/archived", archived: true });
    await seedSummary(t, archived);
    const letter = await seedJob(t, { url: "https://n/1", type: "newsletter" });
    await seedSummary(t, letter);
    const unembedded = await seedJob(t, { url: "https://p/unembedded" });
    await seedSummary(t, unembedded, { embedded: false });
    const rows = await t.query(api.paperLinks.pendingForLinks, { ...auth });
    expect(rows.map((r) => r.summaryId)).toEqual([readySummary]);
  });

  it("skips a summary that has already been through link generation", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await seedSummary(t, jobId, { linkedAt: 42 });
    expect(await t.query(api.paperLinks.pendingForLinks, { ...auth })).toEqual([]);
  });

  it("skips a legacy paper job that carries no archived flag, because the index demands one", async () => {
    const t = withConvex();
    const legacy = await seedJob(t, { archived: null });
    await seedSummary(t, legacy);
    expect(await t.query(api.paperLinks.pendingForLinks, { ...auth })).toEqual([]);
  });

  it("hands out three summaries unless a different limit is asked for, newest job first", async () => {
    const t = withConvex();
    for (let i = 0; i < 5; i++) {
      const jobId = await seedJob(t, { url: `https://p/${i}`, createdAt: i });
      await seedSummary(t, jobId, { title: `paper ${i}` });
    }
    const byDefault = await t.query(api.paperLinks.pendingForLinks, { ...auth });
    expect(byDefault.map((r) => r.title)).toEqual(["paper 4", "paper 3", "paper 2"]);
    const limited = await t.query(api.paperLinks.pendingForLinks, { ...auth, limit: 1 });
    expect(limited.map((r) => r.title)).toEqual(["paper 4"]);
  });

  it("only ever considers a job's first summary", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await seedSummary(t, jobId, { title: "first", embedded: false });
    await seedSummary(t, jobId, { title: "second" });
    expect(await t.query(api.paperLinks.pendingForLinks, { ...auth })).toEqual([]);
  });
});

describe("writing the agent's accepted links", () => {
  it("clears its own earlier suggestions but keeps the ones the user already acted on", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    const summaryId = await seedSummary(t, jobId);
    const researchId = await seedProject(t, "proj");
    await seedLink(t, { jobId, summaryId, researchId, score: 0.2, status: "suggested" });
    await seedLink(t, { jobId, summaryId, researchId, score: 0.3, status: "linked" });
    await seedLink(t, { jobId, summaryId, researchId, score: 0.4, status: "rejected" });
    const written = await t.mutation(api.paperLinks.writeLinks, {
      ...auth,
      summaryId,
      jobId,
      links: [{ researchId, researchSlug: "proj", researchTitle: "Project proj", score: 0.9, reason: "same topic" }],
    });
    expect(written).toEqual({ count: 1 });
    const rows = await t.run(async (ctx) => ctx.db.query("paperLinks").collect());
    expect(rows.map((r) => [r.status, r.score]).sort()).toEqual([
      ["linked", 0.3],
      ["rejected", 0.4],
      ["suggested", 0.9],
    ]);
  });

  it("marks the summary as processed even when the agent accepted nothing", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    const summaryId = await seedSummary(t, jobId);
    expect(await t.mutation(api.paperLinks.writeLinks, { ...auth, summaryId, jobId, links: [] })).toEqual({ count: 0 });
    const summary = await t.run(async (ctx) => ctx.db.get(summaryId));
    expect(summary?.paperLinksAt).toBeGreaterThan(0);
    // A stamped summary is never handed to the worker again.
    expect(await t.query(api.paperLinks.pendingForLinks, { ...auth })).toEqual([]);
  });

  it("leaves suggestions belonging to another summary alone", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    const mine = await seedSummary(t, jobId, { title: "mine" });
    const other = await seedSummary(t, jobId, { title: "other" });
    const researchId = await seedProject(t, "proj");
    await seedLink(t, { jobId, summaryId: other, researchId, score: 0.5 });
    await t.mutation(api.paperLinks.writeLinks, { ...auth, summaryId: mine, jobId, links: [] });
    const rows = await t.run(async (ctx) => ctx.db.query("paperLinks").collect());
    expect(rows.map((r) => r.summaryId)).toEqual([other]);
  });

  it("rejects a link that names no research project", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    const summaryId = await seedSummary(t, jobId);
    await expect(
      t.mutation(api.paperLinks.writeLinks, {
        ...auth,
        summaryId,
        jobId,
        links: [
          {
            researchId: "not-an-id" as unknown as Id<"researchProjects">,
            researchSlug: "proj",
            researchTitle: "Project",
            score: 0.9,
            reason: "r",
          },
        ],
      }),
    ).rejects.toThrow();
  });
});

describe("acting on a suggestion", () => {
  it("moves a suggestion to linked, which takes it off the job list only once rejected", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    const summaryId = await seedSummary(t, jobId);
    const researchId = await seedProject(t, "proj");
    const linkId = await seedLink(t, { jobId, summaryId, researchId, score: 0.5 });
    await t.mutation(api.paperLinks.setStatus, { ...auth, linkId, status: "linked" });
    expect((await t.query(api.paperLinks.listByJob, { ...auth, jobId })).map((r) => r.status)).toEqual(["linked"]);
    await t.mutation(api.paperLinks.setStatus, { ...auth, linkId, status: "rejected" });
    expect(await t.query(api.paperLinks.listByJob, { ...auth, jobId })).toEqual([]);
  });

  it("rejects a status outside suggested, linked and rejected", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    const summaryId = await seedSummary(t, jobId);
    const researchId = await seedProject(t, "proj");
    const linkId = await seedLink(t, { jobId, summaryId, researchId, score: 0.5 });
    await expect(
      t.mutation(api.paperLinks.setStatus, { ...auth, linkId, status: "deleted" as unknown as "linked" }),
    ).rejects.toThrow();
  });
});

describe("papers linked into a research project", () => {
  it("shows only the linked rows of that project, best score first", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    const summaryId = await seedSummary(t, jobId);
    const mine = await seedProject(t, "mine");
    const other = await seedProject(t, "other");
    await seedLink(t, { jobId, summaryId, researchId: mine, slug: "mine", score: 0.5, status: "linked" });
    await seedLink(t, { jobId, summaryId, researchId: mine, slug: "mine", score: 0.9, status: "linked" });
    await seedLink(t, { jobId, summaryId, researchId: mine, slug: "mine", score: 0.99, status: "suggested" });
    await seedLink(t, { jobId, summaryId, researchId: other, slug: "other", score: 0.7, status: "linked" });
    const rows = await t.query(api.paperLinks.listByResearch, { ...auth, researchSlug: "mine" });
    expect(rows.map((r) => r.score)).toEqual([0.9, 0.5]);
  });
});

describe("papers attached to a research project", () => {
  const paper = (over: Partial<{ arxivId: string; title: string; url: string }> = {}) => ({
    title: over.title ?? "A Paper",
    authors: ["Ada Lovelace"],
    url: over.url ?? "https://arxiv.org/abs/2401.00002",
    source: "arxiv" as const,
    ...(over.arxivId === undefined ? {} : { arxivId: over.arxivId }),
  });

  it("lists a project's papers newest first", async () => {
    const t = withConvex();
    await t.run(async (ctx) => {
      await ctx.db.insert("researchPapers", {
        researchSlug: "proj",
        title: "Older",
        authors: [],
        url: "u1",
        source: "manual",
        addedAt: 10,
      });
      await ctx.db.insert("researchPapers", {
        researchSlug: "proj",
        title: "Newer",
        authors: [],
        url: "u2",
        source: "manual",
        addedAt: 20,
      });
      await ctx.db.insert("researchPapers", {
        researchSlug: "elsewhere",
        title: "Other project",
        authors: [],
        url: "u3",
        source: "manual",
        addedAt: 30,
      });
    });
    const rows = await t.query(api.researchPapers.listByResearch, { ...auth, researchSlug: "proj" });
    expect(rows.map((r) => r.title)).toEqual(["Newer", "Older"]);
  });

  it("swaps out one project's whole set without touching another's", async () => {
    const t = withConvex();
    await t.mutation(api.researchPapers.replaceForResearch, {
      ...auth,
      researchSlug: "mine",
      papers: [paper({ title: "Old one" })],
    });
    await t.mutation(api.researchPapers.replaceForResearch, {
      ...auth,
      researchSlug: "other",
      papers: [paper({ title: "Untouched" })],
    });
    await t.mutation(api.researchPapers.replaceForResearch, {
      ...auth,
      researchSlug: "mine",
      papers: [paper({ title: "New one" })],
    });
    const mine = await t.query(api.researchPapers.listByResearch, { ...auth, researchSlug: "mine" });
    const other = await t.query(api.researchPapers.listByResearch, { ...auth, researchSlug: "other" });
    expect(mine.map((r) => r.title)).toEqual(["New one"]);
    expect(other.map((r) => r.title)).toEqual(["Untouched"]);
  });

  it("empties a project when the replacement set is empty", async () => {
    const t = withConvex();
    await t.mutation(api.researchPapers.replaceForResearch, { ...auth, researchSlug: "mine", papers: [paper()] });
    await t.mutation(api.researchPapers.replaceForResearch, { ...auth, researchSlug: "mine", papers: [] });
    expect(await t.query(api.researchPapers.listByResearch, { ...auth, researchSlug: "mine" })).toEqual([]);
  });

  it("takes the same arxiv id only once per project", async () => {
    const t = withConvex();
    const first = await t.mutation(api.researchPapers.addOne, {
      ...auth,
      researchSlug: "mine",
      paper: paper({ arxivId: "2401.00002", title: "First title" }),
    });
    const again = await t.mutation(api.researchPapers.addOne, {
      ...auth,
      researchSlug: "mine",
      paper: paper({ arxivId: "2401.00002", title: "Second title" }),
    });
    expect(again).toBe(first);
    const rows = await t.query(api.researchPapers.listByResearch, { ...auth, researchSlug: "mine" });
    // The existing row wins: a repeat add never refreshes the stored metadata.
    expect(rows.map((r) => r.title)).toEqual(["First title"]);
  });

  it("keeps the same arxiv id once per project it is added to", async () => {
    const t = withConvex();
    await t.mutation(api.researchPapers.addOne, {
      ...auth,
      researchSlug: "mine",
      paper: paper({ arxivId: "2401.00002" }),
    });
    await t.mutation(api.researchPapers.addOne, {
      ...auth,
      researchSlug: "other",
      paper: paper({ arxivId: "2401.00002" }),
    });
    const all = await t.run(async (ctx) => ctx.db.query("researchPapers").collect());
    expect(all.map((r) => r.researchSlug)).toEqual(["mine", "other"]);
  });

  it("always inserts a paper that carries no arxiv id, even an identical one", async () => {
    const t = withConvex();
    await t.mutation(api.researchPapers.addOne, { ...auth, researchSlug: "mine", paper: paper() });
    await t.mutation(api.researchPapers.addOne, { ...auth, researchSlug: "mine", paper: paper() });
    const rows = await t.query(api.researchPapers.listByResearch, { ...auth, researchSlug: "mine" });
    expect(rows).toHaveLength(2);
  });

  it("rejects a bibtex source even though the table stores one", async () => {
    const t = withConvex();
    await t.run(async (ctx) =>
      ctx.db.insert("researchPapers", {
        researchSlug: "mine",
        title: "From the bib file",
        authors: [],
        url: "u",
        source: "bibtex",
        addedAt: 1,
      }),
    );
    await expect(
      t.mutation(api.researchPapers.addOne, {
        ...auth,
        researchSlug: "mine",
        paper: { ...paper(), source: "bibtex" as unknown as "arxiv" },
      }),
    ).rejects.toThrow();
  });
});
