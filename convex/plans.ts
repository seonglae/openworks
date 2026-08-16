import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";

export const listAll = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const plans = await ctx.db.query("plans").collect();
    // Attach the date range so the frontend can decide which plan is "active"
    // (has days near today) vs "archived" (everything older than today-3).
    // Cheaper than another round-trip per plan from the UI.
    const enriched = await Promise.all(
      plans.map(async (p) => {
        const days = await ctx.db
          .query("planDays")
          .withIndex("by_plan_order", (q) => q.eq("planSlug", p.slug))
          .collect();
        const dates = days.map((d) => d.date).sort();
        return {
          ...p,
          firstDate: dates[0] ?? null,
          lastDate: dates[dates.length - 1] ?? null,
        };
      }),
    );
    return enriched.sort((a, b) => b.syncedAt - a.syncedAt);
  },
});

// Create-or-refresh the "Recent Calendar" plan: today through today + range
// days (forward only, never the past), with one calendarRequests row per day
// so the worker pulls outlook events and fills planItems via
// calendar:upsertItemsFromCalendar.
export const requestRecentSync = mutation({
  args: {
    rangeDays: v.optional(v.number()),
    timezone: v.optional(v.string()),
    today: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const range = args.rangeDays ?? 3;
    const now = Date.now();
    const slug = "recent-calendar";
    // Caller passes today's local date string + their timezone so the plan
    // matches the user's wall clock, not the Convex server's.
    const todayLocal = args.today ?? new Date(now).toLocaleDateString("en-CA");

    // Upsert plan row.
    const planRow = await ctx.db
      .query("plans")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    const planData = {
      slug,
      title: "Recent Calendar",
      // Caller-supplied IANA zone wins; the Convex server's resolvedOptions
      // returns "UTC" so we never want that as a real fallback.
      timezone: args.timezone ?? "UTC",
      rawMarkdown: "",
      syncedAt: now,
    };
    if (planRow) {
      await ctx.db.patch(planRow._id, planData);
    } else {
      await ctx.db.insert("plans", planData);
    }

    // Wipe existing days AND items for this plan. Items have to go too —
    // otherwise stale rows from previous syncs (e.g. when we still imported
    // recurring occurrences) survive an empty re-sync and keep showing up.
    // Manual edits aren't a concern: Recent Calendar is fully derived from
    // outlook, nothing user-authored lives here.
    const oldDays = await ctx.db
      .query("planDays")
      .withIndex("by_plan_order", (q) => q.eq("planSlug", slug))
      .collect();
    for (const d of oldDays) await ctx.db.delete(d._id);
    const oldItems = await ctx.db
      .query("planItems")
      .withIndex("by_plan_date_order", (q) => q.eq("planSlug", slug))
      .collect();
    for (const it of oldItems) await ctx.db.delete(it._id);

    // Insert today, today+1, …, today+range planDays in order. Past days
    // are intentionally not synced — the user only cares about today
    // forward.
    const dates: string[] = [];
    const base = new Date(todayLocal + "T00:00:00");
    for (let i = 0; i <= range; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      const iso = d.toLocaleDateString("en-CA");
      dates.push(iso);
      await ctx.db.insert("planDays", { planSlug: slug, date: iso, order: i });
    }

    // One calendar request per day.
    for (const date of dates) {
      await ctx.db.insert("calendarRequests", {
        kind: "syncDay",
        status: "pending",
        planSlug: slug,
        date,
        createdAt: now,
      });
    }
    return { planSlug: slug, days: dates.length };
  },
});

// Merged days + items across ALL plans, for the default (no plan selected)
// calendar view. Embeddings stripped to keep the payload small.
export const allItems = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const days = await ctx.db.query("planDays").collect();
    const rawItems = await ctx.db.query("planItems").collect();
    const items = rawItems.map(({ embedding, ...r }) => r);
    return { days: days.sort((a, b) => a.date.localeCompare(b.date)), items };
  },
});

export const getBySlug = query({
  args: { slug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const plan = await ctx.db
      .query("plans")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    if (!plan) return null;
    const days = await ctx.db
      .query("planDays")
      .withIndex("by_plan_order", (q) => q.eq("planSlug", args.slug))
      .collect();
    const items = await ctx.db
      .query("planItems")
      .withIndex("by_plan_date_order", (q) => q.eq("planSlug", args.slug))
      .collect();
    // Sort by actual calendar date — `order` can drift from date on imports;
    // date is truth. Guarantees earlier-above / later-below in the UI.
    return { plan, days: days.sort((a, b) => a.date.localeCompare(b.date)), items };
  },
});

const itemValidator = v.object({
  date: v.string(),
  kind: v.union(v.literal("event"), v.literal("todo")),
  order: v.number(),
  title: v.string(),
  notes: v.optional(v.string()),
  time: v.optional(v.string()),
  timeStart: v.optional(v.string()),
  timeEnd: v.optional(v.string()),
  tier: v.optional(v.number()),
  location: v.optional(v.string()),
  tags: v.array(v.string()),
  done: v.boolean(),
  // Optional so a caller that already knows the outlook id can pin an item's
  // identity across a re-upsert instead of relying on the title match below.
  calendarEventId: v.optional(v.string()),
});

const dayValidator = v.object({
  date: v.string(),
  dayLabel: v.optional(v.string()),
  summary: v.optional(v.string()),
  order: v.number(),
});

// Titles come back from markdown re-exports with drifting case and whitespace,
// so identity matching compares a folded form.
const normalizeTitle = (title: string) => title.trim().replace(/\s+/g, " ").toLowerCase();

export const upsertPlan = mutation({
  args: {
    slug: v.string(),
    title: v.string(),
    timezone: v.optional(v.string()),
    location: v.optional(v.string()),
    theme: v.optional(v.string()),
    strategy: v.optional(v.string()),
    rawMarkdown: v.string(),
    days: v.array(dayValidator),
    items: v.array(itemValidator),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await ctx.db
      .query("plans")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();

    const oldItems = await ctx.db
      .query("planItems")
      .withIndex("by_plan_date_order", (q) => q.eq("planSlug", args.slug))
      .collect();
    // User-owned state (`done`) and the outlook link (`calendarEventId`) are
    // carried across the rewrite by identity, never by position: `order` is
    // renumbered on every import, so a positional key hands one task's tick to
    // whatever task later lands in that slot. Precedence when re-attaching an
    // incoming item to an old row:
    //   1. same calendarEventId, when the caller supplies one (external id)
    //   2. same date + same normalized title
    //   3. among several old rows equally matched by 2, the nearest `order`
    // Position alone never carries state: a different task at the same slot is
    // a different task, and inherits nothing.
    //
    // The cost of that rule, which main did not pay: renaming an item in the
    // plan markdown looks identical to replacing it, so a rename drops both the
    // tick and the outlook link, and calendar:upsertItemsFromCalendar dedupes
    // only on calendarEventId, so the next sync inserts a duplicate row rather
    // than reclaiming the renamed one. Carrying the link positionally instead
    // is not obviously safer: it would bind an unrelated task to the event and
    // let the next sync overwrite that task's title and time. Both directions
    // lose something, and neither is recoverable automatically.
    const carriers = oldItems.map((it) => ({
      done: it.done,
      calendarEventId: it.calendarEventId,
      date: it.date,
      order: it.order,
      titleKey: normalizeTitle(it.title),
      taken: false,
    }));
    type Carrier = (typeof carriers)[number];
    const claim = (pick: (candidates: Carrier[]) => Carrier | undefined) => {
      const hit = pick(carriers.filter((c) => !c.taken));
      if (hit) hit.taken = true;
      return hit;
    };

    // Clear existing
    for (const d of await ctx.db
      .query("planDays")
      .withIndex("by_plan_order", (q) => q.eq("planSlug", args.slug))
      .collect()) {
      await ctx.db.delete(d._id);
    }
    for (const it of oldItems) {
      await ctx.db.delete(it._id);
    }

    // Upsert plan
    const now = Date.now();
    const planData = {
      slug: args.slug,
      title: args.title,
      timezone: args.timezone,
      location: args.location,
      theme: args.theme,
      strategy: args.strategy,
      rawMarkdown: args.rawMarkdown,
      syncedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, planData);
    } else {
      await ctx.db.insert("plans", planData);
    }

    // Insert days
    for (const d of args.days) {
      await ctx.db.insert("planDays", {
        planSlug: args.slug,
        ...d,
      });
    }

    // Insert items, restoring done/calendarEventId from the old row that each
    // one continues (see the precedence note above).
    for (const it of args.items) {
      const titleKey = normalizeTitle(it.title);
      const carried =
        (it.calendarEventId ? claim((cs) => cs.find((c) => c.calendarEventId === it.calendarEventId)) : undefined) ??
        claim((cs) => {
          const sameTitle = cs.filter((c) => c.date === it.date && c.titleKey === titleKey);
          return sameTitle.sort((a, b) => Math.abs(a.order - it.order) - Math.abs(b.order - it.order))[0];
        });
      await ctx.db.insert("planItems", {
        planSlug: args.slug,
        ...it,
        done: carried?.done ?? it.done,
        calendarEventId: it.calendarEventId ?? carried?.calendarEventId,
      });
    }
  },
});

export const toggleDone = mutation({
  args: { itemId: v.id("planItems"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const item = await ctx.db.get(args.itemId);
    if (!item) return;
    await ctx.db.patch(args.itemId, { done: !item.done });
  },
});

// Create a single calendar event in a plan. Order goes after the day's items.
export const createItem = mutation({
  args: {
    slug: v.string(),
    date: v.string(),
    title: v.string(),
    time: v.optional(v.string()),
    location: v.optional(v.string()),
    notes: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const items = await ctx.db
      .query("planItems")
      .withIndex("by_plan_date_order", (q) => q.eq("planSlug", args.slug).eq("date", args.date))
      .collect();
    const maxOrder = items.reduce((m, i) => Math.max(m, i.order), 0);
    return await ctx.db.insert("planItems", {
      planSlug: args.slug,
      date: args.date,
      kind: "event",
      order: maxOrder + 1,
      title: args.title,
      time: args.time,
      timeStart: args.time,
      location: args.location,
      notes: args.notes,
      tags: [],
      done: false,
    });
  },
});

// Patch an existing event's editable fields (only provided keys change).
export const updateItem = mutation({
  args: {
    itemId: v.id("planItems"),
    title: v.optional(v.string()),
    date: v.optional(v.string()),
    time: v.optional(v.string()),
    location: v.optional(v.string()),
    notes: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const item = await ctx.db.get(args.itemId);
    if (!item) return;
    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.date !== undefined) patch.date = args.date;
    if (args.location !== undefined) patch.location = args.location;
    if (args.notes !== undefined) patch.notes = args.notes;
    if (args.time !== undefined) {
      patch.time = args.time;
      patch.timeStart = args.time;
    }
    await ctx.db.patch(args.itemId, patch);
  },
});

// Soft-hide / restore an event via an `archived` tag (kept out of the cells).
export const setArchived = mutation({
  args: { itemId: v.id("planItems"), archived: v.boolean(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const item = await ctx.db.get(args.itemId);
    if (!item) return;
    const tags = item.tags.filter((t) => t.toLowerCase() !== "archived");
    if (args.archived) tags.push("archived");
    await ctx.db.patch(args.itemId, { tags });
  },
});

export const deleteItem = mutation({
  args: { itemId: v.id("planItems"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.delete(args.itemId);
  },
});

// A cleared optional field is dropped rather than stored as "", so readers only
// ever have to test for absence.
const blankToUndefined = (value: string | undefined) =>
  value === undefined || value.trim() === "" ? undefined : value;

// Patch a single existing item (matched by date + title prefix) or insert a new
// one when none matches. Lets us fill arrival/end dates, fix times, and add
// confirmed events without re-upserting (and re-embedding) a whole plan.
export const editPlanItem = mutation({
  args: {
    slug: v.string(),
    date: v.string(),
    matchTitle: v.string(),
    title: v.optional(v.string()),
    time: v.optional(v.string()),
    notes: v.optional(v.string()),
    location: v.optional(v.string()),
    end: v.optional(v.string()),
    addTags: v.optional(v.array(v.string())),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const items = await ctx.db
      .query("planItems")
      .withIndex("by_plan_date_order", (q) => q.eq("planSlug", args.slug).eq("date", args.date))
      .collect();
    const existing = items.find((i) => i.title.startsWith(args.matchTitle));
    let tags = existing ? [...existing.tags] : [...(args.addTags ?? [])];
    if (args.end) tags = [...tags.filter((t) => !t.toLowerCase().startsWith("end:")), `end:${args.end}`];
    if (existing && args.addTags) for (const t of args.addTags) if (!tags.includes(t)) tags.push(t);
    if (existing) {
      // "not supplied" (undefined) and "supplied as empty" are different
      // requests: the second one clears the field. Title is the exception, it
      // is the item's handle for matching, so a blank one is ignored rather
      // than allowed to erase the row's name.
      const patch: Record<string, unknown> = { tags };
      if (args.title !== undefined && args.title.trim() !== "") patch.title = args.title;
      if (args.notes !== undefined) patch.notes = blankToUndefined(args.notes);
      if (args.location !== undefined) patch.location = blankToUndefined(args.location);
      if (args.time !== undefined) {
        patch.time = blankToUndefined(args.time);
        patch.timeStart = blankToUndefined(args.time);
      }
      await ctx.db.patch(existing._id, patch);
      return `patched: ${existing.title}`;
    }
    const maxOrder = items.reduce((m, i) => Math.max(m, i.order), 0);
    const title = args.title !== undefined && args.title.trim() !== "" ? args.title : args.matchTitle;
    await ctx.db.insert("planItems", {
      planSlug: args.slug,
      date: args.date,
      kind: "event",
      order: maxOrder + 1,
      title,
      time: blankToUndefined(args.time),
      notes: blankToUndefined(args.notes),
      location: blankToUndefined(args.location),
      tags,
      done: false,
    });
    return `inserted: ${title}`;
  },
});
