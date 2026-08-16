// Everything the emailed digest shows, gathered in one query.
//
// The digest is assembled by the worker (gws is a local CLI, so it cannot be
// sent from a Convex action), and the worker should not have to make a dozen
// round trips to build one email. Read shapes here are all bounded: a window
// covers at most SCAN rows per table, because an unbounded `.collect()` over
// jobs is what the 16MB per-transaction read cap punishes, and a digest that
// silently fails once the archive grows is worse than one that says it capped.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";

const KIND = v.union(v.literal("daily"), v.literal("weekly"));

// Per-table ceiling for one window. A day never approaches this; a week of
// heavy reading might, and `truncated` says so rather than quietly shortening
// the digest.
const SCAN = 200;
// Summaries carry a 384-float embedding and the full summary text, and Convex
// has no projection, so every row read costs its vectors too. Only this many
// jobs get their summaries pulled for scoring.
const SCORED_JOBS = 80;
// How far back the recommendation pool reaches. A day is the reporting window,
// not the reading list: the backlog worth triaging is weeks deep.
const RECOMMEND_DAYS = 30;
// How many due cards the mail actually carries. Vocabulary is the tail of this
// digest, not its subject: twelve cards plus a "160 more due" line made the
// study list the longest thing in the mail and buried the work above it. Four
// is a glance, which is all this section is for. The queue itself stays in the
// app, where reviewing them belongs.
const VOCAB_STUDY_N = 4;

type Window = { since: number; until: number };

function inWindow(t: number, w: Window) {
  return t >= w.since && t < w.until;
}

export const snapshot = query({
  args: {
    since: v.number(),
    until: v.number(),
    // The previous window of equal length, so the digest can show deltas
    // rather than bare counts. Omitted for the daily digest, which does not
    // show trends.
    prevSince: v.optional(v.number()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const w: Window = { since: args.since, until: args.until };
    const prev: Window | null = args.prevSince === undefined ? null : { since: args.prevSince, until: args.since };

    // ── Jobs in the window (papers, newsletters, articles) ────────────────
    const windowJobs = await ctx.db
      .query("jobs")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", w.since).lt("createdAt", w.until))
      .order("desc")
      .take(SCAN + 1);
    const jobsTruncated = windowJobs.length > SCAN;
    const jobs = windowJobs.slice(0, SCAN);

    const prevJobs = prev
      ? await ctx.db
          .query("jobs")
          .withIndex("by_createdAt", (q) => q.gte("createdAt", prev.since).lt("createdAt", prev.until))
          .take(SCAN)
      : [];

    const byType: Record<string, number> = {};
    for (const j of jobs) byType[j.type ?? "unknown"] = (byType[j.type ?? "unknown"] ?? 0) + 1;

    // ── Archived: the number this digest exists to report ─────────────────
    // Reading something is not the outcome; clearing it is. Indexed on
    // (type, archived, archivedAt), so this is a range per type rather than a
    // scan of the archive.
    const archivedByType: Record<string, number> = {};
    let archivedTotal = 0;
    for (const t of ["newsletter", "paper", "article", "pr-fix"] as const) {
      const rows = await ctx.db
        .query("jobs")
        .withIndex("by_type_archived_archivedAt", (q) =>
          q.eq("type", t).eq("archived", true).gte("archivedAt", w.since).lt("archivedAt", w.until),
        )
        .take(SCAN);
      if (rows.length > 0) archivedByType[t] = rows.length;
      archivedTotal += rows.length;
    }
    let archivedPrev = 0;
    if (prev) {
      for (const t of ["newsletter", "paper", "article", "pr-fix"] as const) {
        const rows = await ctx.db
          .query("jobs")
          .withIndex("by_type_archived_archivedAt", (q) =>
            q.eq("type", t).eq("archived", true).gte("archivedAt", prev.since).lt("archivedAt", prev.until),
          )
          .take(SCAN);
        archivedPrev += rows.length;
      }
    }

    // Notion suggestions the user acted on. `suggestions` carries no timestamp
    // of its own, so the window is taken from _creationTime.
    const suggestionRows = await ctx.db
      .query("suggestions")
      .order("desc")
      .take(SCAN * 2);
    const inWin = suggestionRows.filter((r) => inWindow(r._creationTime, w));
    const suggestions = {
      approved: inWin.filter((r) => r.status === "approved" || r.status === "executed").length,
      rejected: inWin.filter((r) => r.status === "rejected").length,
      pending: inWin.filter((r) => r.status === "pending").length,
    };

    // Summaries, one job at a time. Only paper jobs carry `scores.overall`, so
    // counting scored summaries next to a job count made 13 read / 9 scored
    // look like four papers went unscored when the other four were a newsletter
    // and an article that are not scored at all. Papers and articles are kept
    // apart here so the digest can say that plainly.
    type Item = {
      title: string;
      url: string;
      summary: string;
      overall?: number;
      category: string;
      jobId: string;
      type: string;
      tldr?: string[];
    };
    const papers: Item[] = [];
    // Articles and newsletters used to share one bucket, which put a link roundup
    // next to a piece that was actually read. They are separate sections now, and
    // the reading, papers then articles, outranks the roundup.
    const articles: Item[] = [];
    const newsletters: Item[] = [];

    const itemsOf = async (j: (typeof jobs)[number]): Promise<Item[]> => {
      const sums = await ctx.db
        .query("summaries")
        .withIndex("by_jobId", (q) => q.eq("jobId", j._id))
        .collect();
      return sums.map((s) => ({
        title: s.title,
        url: s.url,
        summary: s.summary.slice(0, 1200),
        overall: s.scores?.overall,
        category: s.category,
        // What the piece is about, as opposed to what kind of thing it is.
        // `category` answers "paper or article", which is not a topic, so the
        // digest groups on these instead.
        keywords: s.keywords ?? [],
        jobId: j._id as string,
        type: j.type ?? "unknown",
        // `tldr` belongs to the job, so it only describes this row when the
        // job produced this row alone. A newsletter fans out to a summary per
        // article, and stamping all of them with the newsletter's tldr made
        // eleven different articles read as one repeated blurb while their
        // own summaries went unshown.
        tldr: sums.length === 1 ? j.tldr : undefined,
      }));
    };

    for (const j of jobs.slice(0, SCORED_JOBS)) {
      for (const item of await itemsOf(j)) {
        if (j.type === "paper") papers.push(item);
        else if (j.type === "newsletter") newsletters.push(item);
        else articles.push(item);
      }
    }
    papers.sort((a, b) => (b.overall ?? 0) - (a.overall ?? 0));
    const scored = papers.filter((p) => p.overall !== undefined);
    const scoreMean = scored.length > 0 ? scored.reduce((n, s) => n + (s.overall ?? 0), 0) / scored.length : null;

    // ── What to read today ────────────────────────────────────────────────
    // The window above answers "what did I read yesterday", and on any day
    // nothing was processed that is an empty mail. The reading the digest
    // leads with is a recommendation instead: everything still unarchived in
    // the recent backlog, best first. A quiet day then still arrives with a
    // queue to triage rather than a page of headings with nothing under them.
    const recPapers: Item[] = [];
    const recArticles: Item[] = [];
    const recNewsletters: Item[] = [];
    const seen = new Set(jobs.map((j) => j._id as string));
    const backlog = await ctx.db
      .query("jobs")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", w.until - RECOMMEND_DAYS * 86_400_000))
      .order("desc")
      .take(SCAN);
    for (const j of backlog.filter((j) => !j.archived).slice(0, SCORED_JOBS)) {
      // Anything inside the window is already reported above as read.
      if (seen.has(j._id as string)) continue;
      for (const item of await itemsOf(j)) {
        if (j.type === "paper") recPapers.push(item);
        else if (j.type === "newsletter") recNewsletters.push(item);
        else recArticles.push(item);
      }
    }
    recPapers.sort((a, b) => (b.overall ?? 0) - (a.overall ?? 0));

    // ── Insights ──────────────────────────────────────────────────────────
    const insights = (
      await ctx.db
        .query("insights")
        .withIndex("by_createdAt", (q) => q.gte("createdAt", w.since).lt("createdAt", w.until))
        .order("desc")
        .take(SCAN)
    ).map((i) => ({
      text: i.text,
      source: i.source,
      sourceUrl: i.sourceUrl,
      origin: i.origin,
      status: i.status,
      notionPageName: i.notionPageName,
      notionPageUrl: i.notionPageUrl,
    }));

    // ── Research projects ─────────────────────────────────────────────────
    // Small table, and the digest wants the whole board rather than a window:
    // a project that did not move this week is exactly what the user should
    // see. Embeddings are stripped on the way out.
    const projects = (await ctx.db.query("researchProjects").take(SCAN)).map((p) => ({
      slug: p.slug,
      title: p.title,
      kind: p.kind,
      phase: p.phase,
      venue: p.venue,
      deadline: p.deadline,
    }));

    // Phase moves inside the window, so the digest can say what advanced.
    // The timeline is only indexed per project, so this is a bounded newest-
    // first scan filtered by `at` rather than an index range.
    const moves = (await ctx.db.query("researchTimeline").order("desc").take(SCAN))
      .filter((t) => inWindow(t.at, w))
      .map((t) => ({ researchSlug: t.researchSlug, state: t.state, note: t.note, at: t.at, actor: t.actor }));

    const sinceDay = new Date(w.since).toISOString().slice(0, 10);
    const untilDay = new Date(w.until).toISOString().slice(0, 10);

    // ── Agent reports ─────────────────────────────────────────────────────
    // What each agent said it did, day by day. `moves` above only exists where
    // a phase changed, which is a minority of days; this is the record of the
    // rest of them. Indexed range rather than a scan, since `day` sorts.
    const reports = (
      await ctx.db
        .query("researchReports")
        .withIndex("by_day", (q) => q.gte("day", sinceDay).lte("day", untilDay))
        .take(SCAN)
    ).map((r) => ({ researchSlug: r.researchSlug, day: r.day, author: r.author, body: r.body }));

    // ── Plans ─────────────────────────────────────────────────────────────
    const allItems = await ctx.db.query("planItems").take(SCAN);
    const planItems = allItems
      .filter((p) => p.date >= sinceDay && p.date <= untilDay)
      .map((p) => ({ title: p.title, date: p.date, kind: p.kind, done: p.done, time: p.time, tags: p.tags }));

    // ── Vocab ─────────────────────────────────────────────────────────────
    const vocabAdded = (
      await ctx.db
        .query("expressions")
        .withIndex("by_createdAt", (q) => q.gte("createdAt", w.since).lt("createdAt", w.until))
        .order("desc")
        .take(SCAN)
    ).map((x) => ({ en: x.en, jp: x.jp, meaning: x.meaning, reps: x.reps }));

    // Today's study list, not just how many are waiting. The queue runs to
    // hundreds, so the digest carries the most overdue first and says how many
    // it left behind: a mail with 172 cards in it is not a study list.
    const allDue = (
      await ctx.db
        .query("expressions")
        .withIndex("by_due")
        .take(SCAN * 4)
    ).filter((x) => x.due <= untilDay);
    allDue.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
    const study = allDue.slice(0, VOCAB_STUDY_N).map((x) => ({
      // Carried so the mail can link a card back to the row it came from.
      id: x._id,
      en: x.en,
      jp: x.jp,
      reading: x.reading,
      meaning: x.meaning,
      example: x.example,
      ipa: x.ipa,
      ko: x.ko,
      due: x.due,
      reps: x.reps,
    }));

    // ── Diet ──────────────────────────────────────────────────────────────
    const food = (await ctx.db.query("foodEntries").withIndex("by_date").order("desc").take(SCAN)).filter(
      (f) => f.date >= sinceDay && f.date <= untilDay && f.status === "done",
    );
    const dietDays = new Set(food.map((f) => f.date));
    const diet = {
      entries: food.length,
      days: dietDays.size,
      kcal: food.reduce((n, f) => n + (f.kcal ?? 0), 0),
      protein: food.reduce((n, f) => n + (f.protein ?? 0), 0),
      carbs: food.reduce((n, f) => n + (f.carbs ?? 0), 0),
      fat: food.reduce((n, f) => n + (f.fat ?? 0), 0),
    };

    return {
      window: { since: w.since, until: w.until, hasPrev: prev !== null },
      truncated: jobsTruncated || jobs.length > SCORED_JOBS,
      // The headline: what was cleared, not what arrived.
      archived: { total: archivedTotal, prevTotal: prev ? archivedPrev : null, byType: archivedByType },
      suggestions,
      jobs: {
        total: jobs.length,
        prevTotal: prev ? prevJobs.length : null,
        byType,
        errored: jobs.filter((j) => j.status === "error").length,
      },
      papers: { count: byType.paper ?? 0, scored: scored.length, mean: scoreMean, items: papers.slice(0, 10) },
      articles: { count: byType.article ?? 0, items: articles.slice(0, 12) },
      newsletters: { count: byType.newsletter ?? 0, items: newsletters.slice(0, 12) },
      recommend: {
        papers: recPapers.slice(0, 30),
        articles: recArticles.slice(0, 30),
        newsletters: recNewsletters.slice(0, 20),
      },
      insights,
      research: { projects, moves, reports },
      planItems,
      vocab: { added: vocabAdded, due: allDue.length, study, moreDue: Math.max(0, allDue.length - study.length) },
      diet,
    };
  },
});

// Claim one period for sending. Returns false when this period already has a
// row, which is what makes the send exactly-once across worker restarts and
// across machines: two workers waking at 08:00 both call this, one wins, and
// the loser mails nothing. Same shape as every other claim in this backend.
export const claimSend = mutation({
  args: { kind: KIND, periodKey: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db
      .query("digestSends")
      .withIndex("by_kind_period", (q) => q.eq("kind", args.kind).eq("periodKey", args.periodKey))
      .first();
    if (existing) return false;
    await ctx.db.insert("digestSends", { kind: args.kind, periodKey: args.periodKey, claimedAt: Date.now() });
    return true;
  },
});

// A failed send keeps its row, so a broken mailbox does not turn into one
// retry per sweep for the rest of the day. The error is stored to be read
// back rather than only landing in the worker's stdout.
export const recordSend = mutation({
  args: {
    kind: KIND,
    periodKey: v.string(),
    subject: v.optional(v.string()),
    error: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const row = await ctx.db
      .query("digestSends")
      .withIndex("by_kind_period", (q) => q.eq("kind", args.kind).eq("periodKey", args.periodKey))
      .first();
    if (!row) return;
    await ctx.db.patch(row._id, { sentAt: Date.now(), subject: args.subject, error: args.error });
  },
});

export const recentSends = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db.query("digestSends").order("desc").take(20);
  },
});
