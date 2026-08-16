import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";

// `by_date` is ranged lexicographically, so an unpadded key like "2025-1-9"
// sorts after "2025-01-31" and drops out of a January range. Day keys are the
// user's local calendar day, so this only reshapes the format: no Date, no UTC
// round-trip, nothing that could shift the day across a timezone.
const DAY_KEY = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function normalizeDayKey(date: string): string | null {
  const m = DAY_KEY.exec(date.trim());
  if (!m) return null;
  const [, year, month, day] = m;
  const mo = Number(month);
  const d = Number(day);
  if (mo < 1 || mo > 12) return null;
  const y = Number(year);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const maxDay = mo === 2 && leap ? 29 : MONTH_LENGTHS[mo - 1];
  if (d < 1 || d > maxDay) return null;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function requireDayKey(date: string): string {
  const normalized = normalizeDayKey(date);
  if (!normalized) throw new Error(`Invalid date "${date}": expected YYYY-MM-DD`);
  return normalized;
}

// Reads stay lenient: a query key that cannot be parsed used to match nothing
// and still does, so a cleared date field in the UI is not turned into an error.
function readDayKey(date: string): string {
  return normalizeDayKey(date) ?? date;
}

// Upload URL for a food photo (client PUTs the image, gets a storageId back).
export const generateUploadUrl = mutation({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.storage.generateUploadUrl();
  },
});

// Log a food: create a pending entry the worker agent will analyze.
export const createEntry = mutation({
  args: {
    imageId: v.optional(v.id("_storage")),
    date: v.string(),
    name: v.optional(v.string()),
    notes: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db.insert("foodEntries", {
      imageId: args.imageId,
      date: requireDayKey(args.date),
      status: "pending",
      name: args.name,
      notes: args.notes,
      createdAt: Date.now(),
    });
  },
});

export const imageUrl = query({
  args: { entryId: v.id("foodEntries"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const e = await ctx.db.get(args.entryId);
    if (!e?.imageId) return null;
    return await ctx.storage.getUrl(e.imageId);
  },
});

// All entries for one day (newest first) + the day's running totals.
export const listByDate = query({
  args: { date: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const rows = await ctx.db
      .query("foodEntries")
      .withIndex("by_date", (q) => q.eq("date", readDayKey(args.date)))
      .collect();
    rows.sort((a, b) => b.createdAt - a.createdAt);
    const totals = rows.reduce(
      (t, e) => ({
        kcal: t.kcal + (e.kcal ?? 0),
        protein: t.protein + (e.protein ?? 0),
        carbs: t.carbs + (e.carbs ?? 0),
        fat: t.fat + (e.fat ?? 0),
      }),
      { kcal: 0, protein: 0, carbs: 0, fat: 0 },
    );
    return { entries: rows, totals };
  },
});

// Per-day kcal totals over a date range, for the tracking chart.
export const dailyTotals = query({
  args: { from: v.string(), to: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const rows = await ctx.db
      .query("foodEntries")
      .withIndex("by_date", (q) => q.gte("date", readDayKey(args.from)).lte("date", readDayKey(args.to)))
      .collect();
    const byDay = new Map<string, { kcal: number; protein: number; carbs: number; fat: number }>();
    for (const e of rows) {
      const d = byDay.get(e.date) ?? { kcal: 0, protein: 0, carbs: 0, fat: 0 };
      d.kcal += e.kcal ?? 0;
      d.protein += e.protein ?? 0;
      d.carbs += e.carbs ?? 0;
      d.fat += e.fat ?? 0;
      byDay.set(e.date, d);
    }
    return [...byDay.entries()].map(([date, t]) => ({ date, ...t })).sort((a, b) => a.date.localeCompare(b.date));
  },
});

export const remove = mutation({
  args: { entryId: v.id("foodEntries"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.delete(args.entryId);
  },
});

// --- worker side: claim a pending entry, write the analysis ---

export const getPending = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("foodEntries")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .collect();
  },
});

export const claimEntry = mutation({
  args: { entryId: v.id("foodEntries"), provider: v.optional(v.string()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const e = await ctx.db.get(args.entryId);
    if (!e || e.status !== "pending") return false;
    await ctx.db.patch(args.entryId, { status: "analyzing", provider: args.provider });
    return true;
  },
});

export const setAnalysis = mutation({
  args: {
    entryId: v.id("foodEntries"),
    name: v.optional(v.string()),
    kcal: v.optional(v.number()),
    protein: v.optional(v.number()),
    carbs: v.optional(v.number()),
    fat: v.optional(v.number()),
    notes: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const { entryId, serviceKey: _sk, ...fields } = args;
    await ctx.db.patch(entryId, { ...fields, status: "done" });
  },
});

export const recordError = mutation({
  args: { entryId: v.id("foodEntries"), error: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.entryId, { status: "error", error: args.error });
  },
});
