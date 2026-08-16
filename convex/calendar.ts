import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";

// Frontend asks the worker to sync a single plan-day with outlook.
export const requestSyncDay = mutation({
  args: { planSlug: v.string(), date: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const id = await ctx.db.insert("calendarRequests", {
      kind: "syncDay",
      status: "pending",
      planSlug: args.planSlug,
      date: args.date,
      createdAt: Date.now(),
    });
    return { id };
  },
});

// Sync every date in [start, end]: ensure a planDay exists for each (so the
// calendar/modal can render it) and queue a syncDay request so the worker
// pulls outlook events into planItems. Used by the day-range modal's sync.
export const requestSyncRange = mutation({
  args: { planSlug: v.string(), start: v.string(), end: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const now = Date.now();
    const existing = await ctx.db
      .query("planDays")
      .withIndex("by_plan_order", (q) => q.eq("planSlug", args.planSlug))
      .collect();
    const haveDate = new Set(existing.map((d) => d.date));
    const s = new Date(args.start + "T00:00:00");
    const e = new Date(args.end + "T00:00:00");
    let queued = 0;
    let created = 0;
    const MAX = 62;
    let i = 0;
    for (const d = new Date(s); d <= e && i < MAX; d.setDate(d.getDate() + 1), i++) {
      const iso = d.toLocaleDateString("en-CA");
      if (!haveDate.has(iso)) {
        await ctx.db.insert("planDays", {
          planSlug: args.planSlug,
          date: iso,
          order: Math.round(d.getTime() / 86400000),
        });
        created++;
      }
      await ctx.db.insert("calendarRequests", {
        kind: "syncDay",
        status: "pending",
        planSlug: args.planSlug,
        date: iso,
        createdAt: now,
      });
      queued++;
    }
    return { queued, created };
  },
});

export const getRequest = query({
  args: { id: v.id("calendarRequests"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db.get(args.id);
  },
});

// Worker side.
export const getPendingRequest = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db
      .query("calendarRequests")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "pending"))
      .order("asc")
      .first();
  },
});

export const claimRequest = mutation({
  args: { id: v.id("calendarRequests"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const req = await ctx.db.get(args.id);
    if (!req || req.status !== "pending") return null;
    // FIXME: this should claim into "running" the way mailbox:claimRequest
    // does, so a worker that dies mid-sync leaves a retryable row instead of
    // one that reads as successful. Blocked on calendarRequests.status in
    // convex/schema.ts, which has no "running" literal.
    await ctx.db.patch(args.id, { status: "done" });
    return req;
  },
});

export const completeRequest = mutation({
  args: {
    id: v.id("calendarRequests"),
    status: v.union(v.literal("done"), v.literal("error")),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.id, {
      status: args.status,
      result: args.result,
      error: args.error,
      completedAt: Date.now(),
    });
  },
});

// Find the most recent syncDay request for a plan+date so the UI can show
// status without storing reqId in the parent component for every row.
export const latestForDay = query({
  args: { planSlug: v.string(), date: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const items = await ctx.db
      .query("calendarRequests")
      .withIndex("by_plan_date", (q) => q.eq("planSlug", args.planSlug).eq("date", args.date))
      .order("desc")
      .take(1);
    return items[0] ?? null;
  },
});

// Worker calls this after the planner agent has returned JSON items. We
// upsert by (planSlug, date, calendarEventId) so re-syncs don't duplicate
// the same outlook event.
const incomingItem = v.object({
  title: v.string(),
  kind: v.optional(v.union(v.literal("event"), v.literal("todo"))),
  time: v.optional(v.string()),
  timeStart: v.optional(v.string()),
  timeEnd: v.optional(v.string()),
  location: v.optional(v.string()),
  notes: v.optional(v.string()),
  tier: v.optional(v.number()),
  tags: v.optional(v.array(v.string())),
  calendarEventId: v.string(),
});

// Known gap, deliberately left in place: an event outlook reschedules to
// another day keeps its row on the old day, because the date is part of the
// key. Dropping the date from the key finds that row, but it also drags back
// any item a user re-dated by hand in the editor, since plans:updateItem
// patches only the fields it is given and leaves calendarEventId on the row.
// The two cases are indistinguishable without recording the date the calendar
// itself last reported, which planItems has no column for. Silently undoing a
// user's edit is worse than an extra row a user can delete, so this waits on
// that column.
export const upsertItemsFromCalendar = mutation({
  args: {
    planSlug: v.string(),
    date: v.string(),
    items: v.array(incomingItem),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db
      .query("planItems")
      .withIndex("by_plan_date_order", (q) => q.eq("planSlug", args.planSlug).eq("date", args.date))
      .collect();

    const byEvent = new Map<string, Id<"planItems">>();
    let maxOrder = -1;
    for (const it of existing) {
      maxOrder = Math.max(maxOrder, it.order);
      if (it.calendarEventId) byEvent.set(it.calendarEventId, it._id);
    }

    let inserted = 0;
    let updated = 0;
    for (const inc of args.items) {
      const fields = {
        title: inc.title,
        ...(inc.kind ? { kind: inc.kind } : {}),
        time: inc.time,
        timeStart: inc.timeStart,
        timeEnd: inc.timeEnd,
        location: inc.location,
        notes: inc.notes,
        ...(typeof inc.tier === "number" ? { tier: inc.tier } : {}),
        ...(inc.tags ? { tags: inc.tags } : {}),
      };
      const prevId = byEvent.get(inc.calendarEventId);
      if (prevId) {
        await ctx.db.patch(prevId, fields);
        updated++;
      } else {
        maxOrder++;
        const id = await ctx.db.insert("planItems", {
          planSlug: args.planSlug,
          date: args.date,
          order: maxOrder,
          kind: inc.kind ?? "event",
          title: inc.title,
          time: inc.time,
          timeStart: inc.timeStart,
          timeEnd: inc.timeEnd,
          location: inc.location,
          notes: inc.notes,
          tier: inc.tier ?? 2,
          tags: inc.tags ?? [],
          done: false,
          calendarEventId: inc.calendarEventId,
        });
        // Keep the dedupe map current, otherwise a payload that repeats an id
        // inserts a twin that later syncs can never reach through the map.
        byEvent.set(inc.calendarEventId, id);
        inserted++;
      }
    }
    return { inserted, updated };
  },
});
