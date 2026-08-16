// Author extraction for paper jobs, and the leaderboards built on top of it.
//
// Authors come from OpenAlex rather than from the summarizing agent. OpenAlex
// runs its own author disambiguation and hands back a stable entity id per
// researcher, which is the whole point: counting by name would merge two
// different people who happen to share one and split a person who publishes
// under name variants. Names are only ever a display label here; every
// aggregate keys on the entity id.
//
// The lookup is plain HTTP with no key and no model involved.

import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { requireOwner } from "./auth";
import { headOf } from "./summaries";

const OPENALEX = "https://api.openalex.org";
// OpenAlex asks for a contact address in exchange for the faster "polite pool".
// Leaving it unset is fine and is the right default for a fresh install: the
// request simply goes to the common pool rather than carrying a stranger's
// address.
const politeParam = (sep: "?" | "&"): string => {
  const mailto = process.env.OPENALEX_MAILTO;
  return mailto ? `${sep}mailto=${encodeURIComponent(mailto)}` : "";
};

// Shrinkage constant for the score leaderboard: an author is treated as
// starting from C phantom papers at the global mean, so a single lucky 9.5
// cannot outrank a long record. Raising it demands more papers before an
// author's own mean dominates.
const SHRINK_C = 3;

const ARXIV_RE = /arxiv(?:\.org\/(?:abs|pdf)\/|[:\s/])([0-9]{4}\.[0-9]{4,6})(?:v[0-9]+)?/i;
const DOI_RE = /\b(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)\b/i;

type OpenAlexAuthorship = {
  author_position?: string;
  author?: { id?: string | null; display_name?: string | null; orcid?: string | null };
  institutions?: { display_name?: string | null }[];
};
type OpenAlexWork = {
  id?: string;
  title?: string | null;
  display_name?: string | null;
  authorships?: OpenAlexAuthorship[];
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

// Same guard the insight enrichment uses: a fuzzy title search may return a
// plausible neighbour, so only accept a hit that is essentially the same string.
function titleMatches(a: string, b: string) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.abs(x.length - y.length) > Math.ceil(Math.max(x.length, y.length) * 0.15)) return false;
  // Levenshtein, bounded by the shorter string so a long title is not matched
  // by a short prefix.
  const prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (x[i - 1] === y[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[y.length] <= Math.ceil(Math.max(x.length, y.length) * 0.1);
}

async function fetchJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Resolve a paper to an OpenAlex work: exact identifier first, title only as a
// fallback and only when the returned title actually matches.
async function findWork(urls: string[], title: string | undefined): Promise<OpenAlexWork | null> {
  for (const u of urls) {
    if (!u) continue;
    const ax = u.match(ARXIV_RE);
    if (ax) {
      const w = await fetchJson(`${OPENALEX}/works/doi:10.48550/arXiv.${ax[1]}${politeParam("?")}`);
      if (w?.id) return w;
    }
    const doi = u.match(DOI_RE);
    if (doi) {
      const w = await fetchJson(`${OPENALEX}/works/doi:${doi[1]}${politeParam("?")}`);
      if (w?.id) return w;
    }
  }
  if (title && title.trim().length > 12) {
    const res = await fetchJson(
      `${OPENALEX}/works?filter=title.search:${encodeURIComponent(title.trim())}&per-page=5${politeParam("&")}`,
    );
    for (const w of (res?.results ?? []) as OpenAlexWork[]) {
      const cand = w.title ?? w.display_name ?? "";
      if (titleMatches(title, cand)) return w;
    }
  }
  return null;
}

export const jobsNeedingAuthors = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("jobs")
      .withIndex("by_type_createdAt", (q) => q.eq("type", "paper"))
      .order("desc")
      .take(600);
    // Archived papers count too — the leaderboard is about the whole reading
    // history, not the current inbox.
    return rows.filter((j) => j.authorsResolvedAt === undefined).slice(0, args.limit);
  },
});

// Identifiers for one job: the job URL, whatever canonical URL the agent
// recorded on the summary, and the title.
export const resolveInputs = internalQuery({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    const sums = await ctx.db
      .query("summaries")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    const urls = [job.url ?? "", ...sums.map((s) => s.url ?? "")].filter(Boolean);
    // Papers whose body was stripped keep their arXiv link in the marker text.
    if (job.content) urls.push(job.content.slice(0, 400));
    return { urls, title: job.title ?? headOf(sums)?.title ?? undefined };
  },
});

export const saveAuthors = internalMutation({
  args: {
    jobId: v.id("jobs"),
    openAlexId: v.optional(v.string()),
    authors: v.array(
      v.object({
        authorId: v.string(),
        name: v.string(),
        orcid: v.optional(v.string()),
        institution: v.optional(v.string()),
        position: v.string(),
        seq: v.number(),
        resolved: v.boolean(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("paperAuthors")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .collect();
    for (const row of existing) await ctx.db.delete(row._id);
    const now = Date.now();
    for (const a of args.authors) await ctx.db.insert("paperAuthors", { jobId: args.jobId, ...a, createdAt: now });
    await ctx.db.patch(args.jobId, {
      authorsResolvedAt: now,
      ...(args.openAlexId ? { openAlexId: args.openAlexId } : {}),
    });
    return args.authors.length;
  },
});

// One-off repair for rows written before unresolved authors got a per-paper
// key: those shared a bare name key, which is exactly the same-name-same-person
// assumption this module refuses to make.
export const rekeyUnresolved = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("paperAuthors").collect();
    let fixed = 0;
    for (const r of rows) {
      if (r.resolved) continue;
      const want = `name:${norm(r.name)}:${r.jobId}`;
      if (r.authorId === want) continue;
      await ctx.db.patch(r._id, { authorId: want });
      fixed++;
    }
    return fixed;
  },
});

export const resolveJob = internalAction({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args): Promise<number> => {
    const input = await ctx.runQuery(internal.authors.resolveInputs, { jobId: args.jobId });
    if (!input) return 0;
    const work = await findWork(input.urls, input.title);
    if (!work) {
      // Stamp anyway so the sweep moves on; a later re-run can clear the stamp.
      await ctx.runMutation(internal.authors.saveAuthors, { jobId: args.jobId, authors: [] });
      return 0;
    }
    const authorships = work.authorships ?? [];
    const authors = authorships.map((a, i) => {
      const id = a.author?.id ?? null;
      const name = a.author?.display_name ?? "Unknown";
      return {
        // No OpenAlex entity for this author. Keying on the name would merge
        // every unresolved person who happens to share one, so the key is made
        // unique per paper instead and the row is marked unresolved. Such rows
        // are deliberately excluded from the leaderboards: we cannot claim two
        // same-named authors are the same researcher.
        authorId: id ? id.split("/").pop()! : `name:${norm(name)}:${args.jobId}`,
        name,
        ...(a.author?.orcid ? { orcid: a.author.orcid } : {}),
        ...(a.institutions?.[0]?.display_name ? { institution: a.institutions[0].display_name! } : {}),
        position: a.author_position ?? (i === 0 ? "first" : i === authorships.length - 1 ? "last" : "middle"),
        seq: i,
        resolved: Boolean(id),
      };
    });
    return await ctx.runMutation(internal.authors.saveAuthors, {
      jobId: args.jobId,
      ...(work.id ? { openAlexId: work.id.split("/").pop()! } : {}),
      authors,
    });
  },
});

// Walks unresolved paper jobs a few at a time, self-scheduling so one run never
// hits the action time limit and OpenAlex is never hammered.
export const resolveSweep = internalAction({
  args: { batch: v.optional(v.number()) },
  handler: async (ctx, args): Promise<void> => {
    const batch = args.batch ?? 8;
    const jobs: Doc<"jobs">[] = await ctx.runQuery(internal.authors.jobsNeedingAuthors, { limit: batch });
    if (jobs.length === 0) {
      await ctx.runAction(internal.authors.recomputeStats, {});
      console.log("[authors] sweep complete");
      return;
    }
    for (const j of jobs) await ctx.runAction(internal.authors.resolveJob, { jobId: j._id });
    console.log(`[authors] resolved ${jobs.length} papers`);
    await ctx.scheduler.runAfter(1000, internal.authors.resolveSweep, { batch });
  },
});

// Owner-triggered entry point for the backfill / a manual refresh.
export const startResolveSweep = mutation({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.scheduler.runAfter(0, internal.authors.resolveSweep, {});
    return "scheduled";
  },
});

export const resolveProgress = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const papers = await ctx.db
      .query("jobs")
      .withIndex("by_type_createdAt", (q) => q.eq("type", "paper"))
      .order("desc")
      .take(600);
    const done = papers.filter((j) => j.authorsResolvedAt !== undefined).length;
    return { total: papers.length, resolved: done, pending: papers.length - done };
  },
});

// Rebuilds authorStats from paperAuthors + the papers' overall scores. Cheap
// enough to run whole: one pass over author rows and one over paper scores.
// Joins each authorship to its paper's score inside the query, so nothing but
// the finished per-authorship rows crosses the function boundary.
export const statsSource = internalQuery({
  args: {},
  handler: async (ctx) => {
    const authors = await ctx.db.query("paperAuthors").collect();
    const byJob = new Map<string, { score?: number; createdAt: number; paperKey: string }>();
    for (const a of authors) {
      if (byJob.has(a.jobId)) continue;
      const sums = await ctx.db
        .query("summaries")
        .withIndex("by_jobId", (q) => q.eq("jobId", a.jobId))
        .collect();
      const job = await ctx.db.get(a.jobId);
      byJob.set(a.jobId, {
        score: sums.find((s) => s.scores?.overall !== undefined)?.scores?.overall,
        createdAt: job?.createdAt ?? 0,
        // The same paper is often submitted more than once; counting jobs would
        // rank an author by how many times a paper was re-read. Identity is the
        // resolved work, with the job id only as a fallback for unmatched ones.
        paperKey: job?.openAlexId ?? (a.jobId as string),
      });
    }
    const rows = authors.map((a) => {
      const j = byJob.get(a.jobId)!;
      return {
        authorId: a.authorId,
        name: a.name,
        orcid: a.orcid,
        institution: a.institution,
        position: a.position,
        resolved: a.resolved,
        jobId: a.jobId as string,
        paperKey: j.paperKey,
        score: j.score,
        createdAt: j.createdAt,
      };
    });
    // The baseline stands in for C phantom *papers*, so each work counts once.
    // Averaging over authorships instead would let a 30-author paper carry its
    // score thirty times and drag every author toward big-collaboration work.
    const counted = new Set<string>();
    let sum = 0;
    for (const r of rows) {
      if (r.score === undefined || counted.has(r.paperKey)) continue;
      counted.add(r.paperKey);
      sum += r.score;
    }
    const globalMean = counted.size > 0 ? sum / counted.size : 0;
    return { rows, globalMean };
  },
});

export const writeStats = internalMutation({
  args: {
    rows: v.array(
      v.object({
        authorId: v.string(),
        name: v.string(),
        orcid: v.optional(v.string()),
        institution: v.optional(v.string()),
        paperCount: v.number(),
        firstCount: v.number(),
        lastCount: v.number(),
        scoreAll: v.number(),
        scoreFirst: v.number(),
        scoreLast: v.number(),
        rawAll: v.number(),
        rawFirst: v.number(),
        rawLast: v.number(),
        scoredAll: v.number(),
        scoredFirst: v.number(),
        scoredLast: v.number(),
        lastPaperAt: v.number(),
      }),
    ),
    // Shared across every chunk of one rebuild, so pruneStats can tell rows
    // this rebuild touched from rows left over by a previous one. Allocated by
    // nextStatsStamp, never read as a wall clock.
    stamp: v.number(),
  },
  handler: async (ctx, args) => {
    for (const row of args.rows) {
      const prev = await ctx.db
        .query("authorStats")
        .withIndex("by_authorId", (q) => q.eq("authorId", row.authorId))
        .first();
      if (prev) await ctx.db.patch(prev._id, { ...row, updatedAt: args.stamp });
      else await ctx.db.insert("authorStats", { ...row, updatedAt: args.stamp });
    }
    return args.rows.length;
  },
});

// Marker for one rebuild. It has to differ from every stamp already stored,
// because pruneStats keeps exactly the rows carrying it: reusing a previous
// rebuild's value would adopt that rebuild's leftovers instead of deleting
// them. Date.now() collides whenever two rebuilds land in the same
// millisecond, so the marker steps past the highest stamp on disk, which makes
// it strictly increasing however fast rebuilds follow one another. Reads the
// same authorStats scan pruneStats already does: one row per ranked author.
export const nextStatsStamp = internalQuery({
  args: {},
  handler: async (ctx) => {
    let max = 0;
    for (const row of await ctx.db.query("authorStats").collect()) max = Math.max(max, row.updatedAt);
    return Math.max(Date.now(), max + 1);
  },
});

// Drops authors that this rebuild did not write — their last paper was deleted
// or re-resolved to a different identity. Runs once, after every chunk.
export const pruneStats = internalMutation({
  args: { stamp: v.number() },
  handler: async (ctx, args) => {
    const stale = (await ctx.db.query("authorStats").collect()).filter((r) => r.updatedAt !== args.stamp);
    for (const row of stale) await ctx.db.delete(row._id);
    return stale.length;
  },
});

export const recomputeStats = internalAction({
  args: {},
  handler: async (ctx): Promise<number> => {
    const { rows: source, globalMean } = await ctx.runQuery(internal.authors.statsSource, {});

    // Sums are tracked per position so each leaderboard axis scores only the
    // papers that axis counts.
    type Bucket = { n: number; sum: number; scored: number };
    type Acc = {
      name: string;
      orcid?: string;
      institution?: string;
      papers: Set<string>;
      all: Bucket;
      first: Bucket;
      last: Bucket;
      lastPaperAt: number;
    };
    const bucket = (): Bucket => ({ n: 0, sum: 0, scored: 0 });
    const add = (b: Bucket, score: number | undefined) => {
      b.n++;
      if (score !== undefined) {
        b.sum += score;
        b.scored++;
      }
    };
    const shrink = (b: Bucket) => Math.round(((SHRINK_C * globalMean + b.sum) / (SHRINK_C + b.scored)) * 100) / 100;
    const raw = (b: Bucket) => (b.scored > 0 ? Math.round((b.sum / b.scored) * 100) / 100 : 0);
    const acc = new Map<string, Acc>();
    for (const a of source) {
      // Unresolved authorships have a per-paper key, so aggregating them would
      // only ever produce singletons that imply a disambiguation we don't have.
      if (!a.resolved) continue;
      let e = acc.get(a.authorId);
      if (!e) {
        e = { name: a.name, papers: new Set(), all: bucket(), first: bucket(), last: bucket(), lastPaperAt: 0 };
        acc.set(a.authorId, e);
      }
      if (a.orcid && !e.orcid) e.orcid = a.orcid;
      if (a.institution && !e.institution) e.institution = a.institution;
      if (e.papers.has(a.paperKey)) continue;
      e.papers.add(a.paperKey);
      add(e.all, a.score);
      if (a.position === "first") add(e.first, a.score);
      if (a.position === "last") add(e.last, a.score);
      e.lastPaperAt = Math.max(e.lastPaperAt, a.createdAt);
    }

    const rows = [...acc.entries()].map(([authorId, e]) => ({
      authorId,
      name: e.name,
      ...(e.orcid ? { orcid: e.orcid } : {}),
      ...(e.institution ? { institution: e.institution } : {}),
      paperCount: e.all.n,
      firstCount: e.first.n,
      lastCount: e.last.n,
      scoreAll: shrink(e.all),
      scoreFirst: shrink(e.first),
      scoreLast: shrink(e.last),
      rawAll: raw(e.all),
      rawFirst: raw(e.first),
      rawLast: raw(e.last),
      scoredAll: e.all.scored,
      scoredFirst: e.first.scored,
      scoredLast: e.last.scored,
      lastPaperAt: e.lastPaperAt,
    }));

    // Chunked to stay inside the per-mutation write limit; the prune that
    // removes rows this rebuild did not touch runs once, after all of them.
    const stamp: number = await ctx.runQuery(internal.authors.nextStatsStamp, {});
    for (let i = 0; i < rows.length; i += 200) {
      await ctx.runMutation(internal.authors.writeStats, { rows: rows.slice(i, i + 200), stamp });
    }
    const pruned: number = await ctx.runMutation(internal.authors.pruneStats, { stamp });
    console.log(`[authors] stats for ${rows.length} authors, pruned ${pruned} (global mean ${globalMean.toFixed(2)})`);
    return rows.length;
  },
});

// Position and metric are independent: any of the three author positions can be
// ranked either by how many papers it covers or by their shrunk mean score.
const RANK_INDEX = {
  "first:count": "by_firstCount",
  "last:count": "by_lastCount",
  "all:count": "by_paperCount",
  "first:score": "by_scoreFirst",
  "last:score": "by_scoreLast",
  "all:score": "by_scoreAll",
} as const;

export const leaderboard = query({
  args: {
    paginationOpts: paginationOptsValidator,
    // first = first author (default), last = corresponding, all = any authorship.
    position: v.optional(v.union(v.literal("first"), v.literal("last"), v.literal("all"))),
    metric: v.optional(v.union(v.literal("score"), v.literal("count"))),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const position = args.position ?? "first";
    const metric = args.metric ?? "score";
    const res = await ctx.db
      .query("authorStats")
      .withIndex(RANK_INDEX[`${position}:${metric}` as keyof typeof RANK_INDEX])
      .order("desc")
      .paginate(args.paginationOpts);
    // Authors with nothing in the ranked column would otherwise fill the list.
    // Under score that means no *scored* paper in this position: their shrunk
    // value is exactly the global mean, which would outrank every real author
    // whose papers scored below it.
    const page = res.page.filter((r) => {
      const count = position === "first" ? r.firstCount : position === "last" ? r.lastCount : r.paperCount;
      if (count === 0) return false;
      if (metric === "count") return true;
      const scored = position === "first" ? r.scoredFirst : position === "last" ? r.scoredLast : r.scoredAll;
      return scored > 0;
    });
    return { ...res, page };
  },
});

// Only the shrinkage constant: the mean this module shrinks toward is derived
// during a rebuild and never stored, so no read here can recover it.
export const globalMean = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return { shrinkC: SHRINK_C };
  },
});

// Papers for one author, newest first — loaded lazily when a leaderboard row
// is unfolded rather than shipped with the leaderboard itself.
export const papersByAuthor = query({
  args: {
    paginationOpts: paginationOptsValidator,
    authorId: v.string(),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const res = await ctx.db
      .query("paperAuthors")
      .withIndex("by_author", (q) => q.eq("authorId", args.authorId))
      .order("desc")
      .paginate(args.paginationOpts);
    const page = [];
    // Re-submissions of the same paper are separate jobs; show the work once.
    const seen = new Set<string>();
    for (const row of res.page) {
      const job = await ctx.db.get(row.jobId);
      if (!job) continue;
      const key = job.openAlexId ?? (row.jobId as string);
      if (seen.has(key)) continue;
      seen.add(key);
      const sums = await ctx.db
        .query("summaries")
        .withIndex("by_jobId", (q) => q.eq("jobId", row.jobId))
        .collect();
      const s = sums.find((x) => x.scores?.overall !== undefined);
      page.push({
        jobId: row.jobId,
        title: job.title ?? headOf(sums)?.title ?? "(untitled)",
        // A job's url is required but may be blank, so the fallback tests the
        // value rather than its presence.
        url: job.url || headOf(sums)?.url || "",
        archived: job.archived ?? false,
        createdAt: job.createdAt,
        position: row.position,
        overall: s?.scores?.overall,
        researchLevel: s?.researchLevel,
      });
    }
    return { ...res, page };
  },
});
