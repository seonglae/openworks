import { v } from "convex/values";
import { addDays } from "@openworks/core";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";

// Fallback only. The scheduler's day boundary belongs to the user's wall clock,
// so callers with a clock of their own (the browser) pass `today` instead: at
// 20:00Z a Seoul user is already on the next calendar day.
const todayUTC = (): string => new Date(Date.now()).toISOString().slice(0, 10);

export const add = mutation({
  args: {
    en: v.string(),
    jp: v.optional(v.string()),
    reading: v.optional(v.string()),
    meaning: v.optional(v.string()),
    example: v.optional(v.string()),
    today: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const { serviceKey: _sk, today, ...fields } = args;
    // Auto-enrich when the user only typed the English phrase: the worker
    // fills in jp / reading / meaning / example.
    const pendingEnrich = !fields.jp && !fields.meaning;
    return await ctx.db.insert("expressions", {
      ...fields,
      due: today ?? todayUTC(),
      intervalDays: 0,
      reps: 0,
      ease: 250,
      pendingEnrich,
      createdAt: Date.now(),
    });
  },
});

// Bulk-add English-only phrases (e.g. imported from a Notion page's databases).
// Dedupes against existing rows and every input, case-insensitively, and marks
// each new row pendingEnrich so the worker fills jp / reading / meaning /
// example. Returns how many were newly added.
export const addBatchEn = mutation({
  args: { ens: v.array(v.string()), today: v.optional(v.string()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const today = args.today ?? todayUTC();
    const existing = await ctx.db.query("expressions").collect();
    const seen = new Set(existing.map((e) => e.en.trim().toLowerCase()));
    let added = 0;
    for (const raw of args.ens) {
      const en = raw.trim();
      if (!en) continue;
      const key = en.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      await ctx.db.insert("expressions", {
        en,
        due: today,
        intervalDays: 0,
        reps: 0,
        ease: 250,
        pendingEnrich: true,
        createdAt: Date.now(),
      });
      added++;
    }
    return { added };
  },
});

// --- worker side: enrich English-only expressions ---

export const getPendingEnrich = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("expressions")
      .withIndex("by_pending", (q) => q.eq("pendingEnrich", true))
      .collect();
  },
});

export const setEnrichment = mutation({
  args: {
    id: v.id("expressions"),
    jp: v.optional(v.string()),
    reading: v.optional(v.string()),
    meaning: v.optional(v.string()),
    example: v.optional(v.string()),
    // Pronunciation of the English headword: phonetic notation and its
    // Hangul approximation.
    ipa: v.optional(v.string()),
    ko: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const { id, serviceKey: _sk, ...fields } = args;
    await ctx.db.patch(id, { ...fields, pendingEnrich: false });
  },
});

// Re-queue cards enriched before pronunciation existed. The worker's normal
// enrich loop picks them up from `pendingEnrich`, so this only has to flip the
// flag; bounded per call so one invocation cannot queue the whole deck at once.
export const requeueMissingPronunciation = mutation({
  args: { limit: v.optional(v.number()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const limit = Math.min(args.limit ?? 25, 100);
    const rows = await ctx.db.query("expressions").withIndex("by_due").take(500);
    const stale = rows.filter((r) => !r.ipa && !r.pendingEnrich).slice(0, limit);
    for (const r of stale) await ctx.db.patch(r._id, { pendingEnrich: true });
    return { queued: stale.length, remaining: rows.filter((r) => !r.ipa).length - stale.length };
  },
});

// Re-queue cards whose gloss was written in the wrong language. `meaning` is
// supposed to be in settings.language, but every card enriched before the
// prompt read that setting came back in English, which is a dictionary entry
// rather than a gloss. The worker only writes meaning/example/ipa/ko, so the
// Japanese side and the review schedule survive a re-run untouched.
//
// `script` is the Unicode range the gloss should be in, passed by the caller
// rather than derived here, because the backend has no business knowing which
// alphabet a language uses. A row already matching it is left alone, so this is
// safe to call repeatedly and converges.
export const requeueGloss = mutation({
  args: { script: v.string(), limit: v.optional(v.number()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const limit = Math.min(args.limit ?? 25, 100);
    const re = new RegExp(args.script, "u");
    const rows = await ctx.db.query("expressions").withIndex("by_due").take(1000);
    const wrong = rows.filter((r) => !r.pendingEnrich && (!r.meaning || !re.test(r.meaning)));
    for (const r of wrong.slice(0, limit)) await ctx.db.patch(r._id, { pendingEnrich: true });
    return { queued: Math.min(wrong.length, limit), remaining: Math.max(0, wrong.length - limit) };
  },
});

export const list = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db.query("expressions").withIndex("by_createdAt").order("desc").collect();
  },
});

// Cards due for review today (or overdue), plus the total counts.
export const due = query({
  args: { today: v.optional(v.string()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const today = args.today ?? todayUTC();
    const all = await ctx.db.query("expressions").withIndex("by_due").collect();
    const dueCards = all.filter((e) => e.due <= today);
    return { due: dueCards, total: all.length, dueCount: dueCards.length };
  },
});

// Grade a review: again | good | easy. Advances the SM-2-ish schedule.
export const review = mutation({
  args: {
    id: v.id("expressions"),
    grade: v.union(v.literal("again"), v.literal("good"), v.literal("easy")),
    today: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const e = await ctx.db.get(args.id);
    if (!e) return;
    let { intervalDays, reps, ease } = e;
    if (args.grade === "again") {
      reps = 0;
      intervalDays = 1;
      ease = Math.max(130, ease - 20);
    } else {
      reps += 1;
      if (args.grade === "easy") ease += 15;
      intervalDays =
        reps === 1 ? 1 : reps === 2 ? 3 : Math.round(intervalDays * (ease / 100) * (args.grade === "easy" ? 1.3 : 1));
    }
    await ctx.db.patch(args.id, { intervalDays, reps, ease, due: addDays(args.today ?? todayUTC(), intervalDays) });
  },
});

export const remove = mutation({
  args: { id: v.id("expressions"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.delete(args.id);
  },
});
