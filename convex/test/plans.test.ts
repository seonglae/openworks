import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { auth, withConvex } from "./harness.setup";

type Harness = ReturnType<typeof withConvex>;

type Item = {
  date: string;
  kind: "event" | "todo";
  order: number;
  title: string;
  notes?: string;
  time?: string;
  timeStart?: string;
  timeEnd?: string;
  tier?: number;
  location?: string;
  tags: string[];
  done: boolean;
  calendarEventId?: string;
};

function planItem(date: string, order: number, title: string, over: Partial<Item> = {}): Item {
  return { date, kind: "todo", order, title, tags: [], done: false, ...over };
}

function planDay(date: string, order: number) {
  return { date, order };
}

async function readDays(t: Harness, slug: string) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("planDays")
      .withIndex("by_plan_order", (q) => q.eq("planSlug", slug))
      .collect();
    return rows.sort((a, b) => a.date.localeCompare(b.date));
  });
}

async function readItems(t: Harness, slug: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("planItems")
      .withIndex("by_plan_date_order", (q) => q.eq("planSlug", slug))
      .collect(),
  );
}

describe("recent calendar sync window", () => {
  it("covers the given day and the following range days, never a past day", async () => {
    const t = withConvex();
    const res = await t.mutation(api.plans.requestRecentSync, { ...auth, today: "2025-06-10", rangeDays: 3 });
    expect(res).toEqual({ planSlug: "recent-calendar", days: 4 });
    const days = await readDays(t, "recent-calendar");
    expect(days.map((d) => d.date)).toEqual(["2025-06-10", "2025-06-11", "2025-06-12", "2025-06-13"]);
    expect(days.map((d) => d.order)).toEqual([0, 1, 2, 3]);
  });

  it("produces a single day when the range is zero", async () => {
    const t = withConvex();
    const res = await t.mutation(api.plans.requestRecentSync, { ...auth, today: "2025-06-10", rangeDays: 0 });
    expect(res.days).toBe(1);
    expect((await readDays(t, "recent-calendar")).map((d) => d.date)).toEqual(["2025-06-10"]);
  });

  it("defaults to a four day window when no range is given", async () => {
    const t = withConvex();
    const res = await t.mutation(api.plans.requestRecentSync, { ...auth, today: "2025-06-10" });
    expect(res.days).toBe(4);
  });

  it("rolls the day key over a month and a year boundary", async () => {
    const t = withConvex();
    await t.mutation(api.plans.requestRecentSync, { ...auth, today: "2025-12-31", rangeDays: 2 });
    const days = await readDays(t, "recent-calendar");
    expect(days.map((d) => d.date)).toEqual(["2025-12-31", "2026-01-01", "2026-01-02"]);
  });

  it("counts 29 February in a leap year", async () => {
    const t = withConvex();
    await t.mutation(api.plans.requestRecentSync, { ...auth, today: "2024-02-28", rangeDays: 2 });
    const days = await readDays(t, "recent-calendar");
    expect(days.map((d) => d.date)).toEqual(["2024-02-28", "2024-02-29", "2024-03-01"]);
  });

  it("skips 29 February outside a leap year", async () => {
    const t = withConvex();
    await t.mutation(api.plans.requestRecentSync, { ...auth, today: "2025-02-28", rangeDays: 1 });
    const days = await readDays(t, "recent-calendar");
    expect(days.map((d) => d.date)).toEqual(["2025-02-28", "2025-03-01"]);
  });

  it("stores the caller timezone but does not use it to derive the day keys", async () => {
    const t = withConvex();
    // Kiritimati is UTC+14, so a timezone-aware implementation would land on a
    // different first day than the literal `today` string it was handed.
    await t.mutation(api.plans.requestRecentSync, {
      ...auth,
      today: "2025-06-10",
      timezone: "Pacific/Kiritimati",
      rangeDays: 1,
    });
    const plan = await t.run(async (ctx) =>
      ctx.db
        .query("plans")
        .withIndex("by_slug", (q) => q.eq("slug", "recent-calendar"))
        .first(),
    );
    expect(plan?.timezone).toBe("Pacific/Kiritimati");
    expect((await readDays(t, "recent-calendar")).map((d) => d.date)).toEqual(["2025-06-10", "2025-06-11"]);
  });

  it("falls back to the day of the process clock when the caller sends no date", async () => {
    const t = withConvex();
    // Sampled either side of the call so a midnight rollover cannot make the
    // assertion flaky. Both samples use the process timezone, which is what the
    // handler falls back to: nothing here consults the caller's zone.
    const before = new Date().toLocaleDateString("en-CA");
    await t.mutation(api.plans.requestRecentSync, { ...auth, rangeDays: 0, timezone: "Pacific/Kiritimati" });
    const after = new Date().toLocaleDateString("en-CA");
    const days = await readDays(t, "recent-calendar");
    expect([before, after]).toContain(days[0].date);
  });

  it("queues exactly one pending calendar request per synced day", async () => {
    const t = withConvex();
    await t.mutation(api.plans.requestRecentSync, { ...auth, today: "2025-06-10", rangeDays: 2 });
    const reqs = await t.run(async (ctx) => ctx.db.query("calendarRequests").collect());
    expect(reqs.map((r) => r.date).sort()).toEqual(["2025-06-10", "2025-06-11", "2025-06-12"]);
    expect(reqs.every((r) => r.status === "pending" && r.kind === "syncDay")).toBe(true);
  });

  it("drops days and items left over from an earlier window", async () => {
    const t = withConvex();
    await t.mutation(api.plans.requestRecentSync, { ...auth, today: "2025-06-10", rangeDays: 1 });
    await t.mutation(api.plans.createItem, { ...auth, slug: "recent-calendar", date: "2025-06-10", title: "old" });
    await t.mutation(api.plans.requestRecentSync, { ...auth, today: "2025-06-12", rangeDays: 1 });
    expect((await readDays(t, "recent-calendar")).map((d) => d.date)).toEqual(["2025-06-12", "2025-06-13"]);
    // Items are wiped wholesale, including ones a human added by hand.
    expect(await readItems(t, "recent-calendar")).toEqual([]);
  });

  it("keeps a single plan row across repeated syncs", async () => {
    const t = withConvex();
    await t.mutation(api.plans.requestRecentSync, { ...auth, today: "2025-06-10", rangeDays: 0 });
    await t.mutation(api.plans.requestRecentSync, { ...auth, today: "2025-06-11", rangeDays: 0 });
    const plans = await t.run(async (ctx) => ctx.db.query("plans").collect());
    expect(plans).toHaveLength(1);
  });

  it("leaves other plans untouched when the recent window is rebuilt", async () => {
    const t = withConvex();
    await t.mutation(api.plans.upsertPlan, {
      ...auth,
      slug: "trip",
      title: "Trip",
      rawMarkdown: "",
      days: [planDay("2025-06-10", 0)],
      items: [planItem("2025-06-10", 1, "keep me")],
    });
    await t.mutation(api.plans.requestRecentSync, { ...auth, today: "2025-06-10", rangeDays: 0 });
    expect(await readItems(t, "trip")).toHaveLength(1);
  });
});

describe("plan listing", () => {
  it("reports the earliest and latest day of each plan", async () => {
    const t = withConvex();
    await t.mutation(api.plans.upsertPlan, {
      ...auth,
      slug: "trip",
      title: "Trip",
      rawMarkdown: "",
      days: [planDay("2025-06-12", 0), planDay("2025-06-09", 1)],
      items: [],
    });
    const [plan] = await t.query(api.plans.listAll, { ...auth });
    expect(plan.firstDate).toBe("2025-06-09");
    expect(plan.lastDate).toBe("2025-06-12");
  });

  it("reports a null date range for a plan with no days", async () => {
    const t = withConvex();
    await t.mutation(api.plans.upsertPlan, {
      ...auth,
      slug: "empty",
      title: "Empty",
      rawMarkdown: "",
      days: [],
      items: [],
    });
    const [plan] = await t.query(api.plans.listAll, { ...auth });
    expect(plan.firstDate).toBeNull();
    expect(plan.lastDate).toBeNull();
  });

  it("orders plans by most recently synced first", async () => {
    const t = withConvex();
    await t.run(async (ctx) => {
      await ctx.db.insert("plans", { slug: "old", title: "Old", rawMarkdown: "", syncedAt: 1_000 });
      await ctx.db.insert("plans", { slug: "new", title: "New", rawMarkdown: "", syncedAt: 9_000 });
    });
    const plans = await t.query(api.plans.listAll, { ...auth });
    expect(plans.map((p) => p.slug)).toEqual(["new", "old"]);
  });

  it("returns null for an unknown slug", async () => {
    const t = withConvex();
    expect(await t.query(api.plans.getBySlug, { ...auth, slug: "nope" })).toBeNull();
  });

  it("orders a plan's days by date even when the stored order disagrees", async () => {
    const t = withConvex();
    await t.mutation(api.plans.upsertPlan, {
      ...auth,
      slug: "trip",
      title: "Trip",
      rawMarkdown: "",
      // Order deliberately inverted against the calendar dates: imports let the
      // two drift apart and the date is the one that must win.
      days: [planDay("2025-06-12", 0), planDay("2025-06-10", 1), planDay("2025-06-11", 2)],
      items: [],
    });
    const res = await t.query(api.plans.getBySlug, { ...auth, slug: "trip" });
    expect(res?.days.map((d) => d.date)).toEqual(["2025-06-10", "2025-06-11", "2025-06-12"]);
  });

  it("returns a plan's items grouped by date and then by order", async () => {
    const t = withConvex();
    await t.mutation(api.plans.upsertPlan, {
      ...auth,
      slug: "trip",
      title: "Trip",
      rawMarkdown: "",
      days: [planDay("2025-06-10", 0), planDay("2025-06-11", 1)],
      items: [
        planItem("2025-06-11", 1, "second day first"),
        planItem("2025-06-10", 2, "first day second"),
        planItem("2025-06-10", 1, "first day first"),
      ],
    });
    const res = await t.query(api.plans.getBySlug, { ...auth, slug: "trip" });
    expect(res?.items.map((i) => i.title)).toEqual(["first day first", "first day second", "second day first"]);
  });

  it("merges days across every plan in date order and strips embeddings", async () => {
    const t = withConvex();
    await t.mutation(api.plans.upsertPlan, {
      ...auth,
      slug: "a",
      title: "A",
      rawMarkdown: "",
      days: [planDay("2025-06-12", 0)],
      items: [planItem("2025-06-12", 1, "a1")],
    });
    await t.mutation(api.plans.upsertPlan, {
      ...auth,
      slug: "b",
      title: "B",
      rawMarkdown: "",
      days: [planDay("2025-06-10", 0)],
      items: [planItem("2025-06-10", 1, "b1")],
    });
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("planItems").collect();
      await ctx.db.patch(rows[0]._id, { embedding: Array.from({ length: 384 }, () => 0.1), embeddedAt: 5 });
    });
    const res = await t.query(api.plans.allItems, { ...auth });
    expect(res.days.map((d) => d.date)).toEqual(["2025-06-10", "2025-06-12"]);
    expect(res.items).toHaveLength(2);
    expect(res.items.every((i) => !("embedding" in i))).toBe(true);
    // embeddedAt survives the strip, only the vector itself is dropped.
    expect(res.items.some((i) => i.embeddedAt === 5)).toBe(true);
  });

  it("returns empty collections when nothing has been synced", async () => {
    const t = withConvex();
    const res = await t.query(api.plans.allItems, { ...auth });
    expect(res).toEqual({ days: [], items: [] });
  });
});

describe("plan upsert", () => {
  it("keeps the done flag of an item that stays on the same date and order", async () => {
    const t = withConvex();
    const args = {
      ...auth,
      slug: "trip",
      title: "Trip",
      rawMarkdown: "",
      days: [planDay("2025-06-10", 0)],
      items: [planItem("2025-06-10", 1, "pack")],
    };
    await t.mutation(api.plans.upsertPlan, args);
    const items = await readItems(t, "trip");
    await t.mutation(api.plans.toggleDone, { ...auth, itemId: items[0]._id });
    await t.mutation(api.plans.upsertPlan, args);
    expect((await readItems(t, "trip"))[0].done).toBe(true);
  });

  it("refuses to hand the done flag to a different task that took over that date and order", async () => {
    const t = withConvex();
    await t.mutation(api.plans.upsertPlan, {
      ...auth,
      slug: "trip",
      title: "Trip",
      rawMarkdown: "",
      days: [planDay("2025-06-10", 0)],
      items: [planItem("2025-06-10", 1, "pack")],
    });
    const items = await readItems(t, "trip");
    await t.mutation(api.plans.toggleDone, { ...auth, itemId: items[0]._id });
    await t.mutation(api.plans.upsertPlan, {
      ...auth,
      slug: "trip",
      title: "Trip",
      rawMarkdown: "",
      days: [planDay("2025-06-10", 0)],
      items: [planItem("2025-06-10", 1, "completely different task")],
    });
    // Position is not identity: the tick belonged to "pack", and "pack" is gone.
    expect((await readItems(t, "trip"))[0]).toMatchObject({ title: "completely different task", done: false });
  });

  it("keeps the done flag on an item that an insert above it renumbers", async () => {
    const t = withConvex();
    await t.mutation(api.plans.upsertPlan, {
      ...auth,
      slug: "trip",
      title: "Trip",
      rawMarkdown: "",
      days: [planDay("2025-06-10", 0)],
      items: [planItem("2025-06-10", 1, "pack")],
    });
    const items = await readItems(t, "trip");
    await t.mutation(api.plans.toggleDone, { ...auth, itemId: items[0]._id });
    await t.mutation(api.plans.upsertPlan, {
      ...auth,
      slug: "trip",
      title: "Trip",
      rawMarkdown: "",
      days: [planDay("2025-06-10", 0)],
      // "pack" is pushed from order 1 to order 2 by the new first row.
      items: [planItem("2025-06-10", 1, "new first"), planItem("2025-06-10", 2, "pack")],
    });
    const after = await readItems(t, "trip");
    expect(after.map((i) => [i.title, i.done])).toEqual([
      ["new first", false],
      ["pack", true],
    ]);
  });

  it("matches a re-imported title regardless of case and spacing", async () => {
    const t = withConvex();
    await t.mutation(api.plans.upsertPlan, {
      ...auth,
      slug: "trip",
      title: "Trip",
      rawMarkdown: "",
      days: [planDay("2025-06-10", 0)],
      items: [planItem("2025-06-10", 1, "Pack  the bags")],
    });
    const items = await readItems(t, "trip");
    await t.mutation(api.plans.toggleDone, { ...auth, itemId: items[0]._id });
    await t.mutation(api.plans.upsertPlan, {
      ...auth,
      slug: "trip",
      title: "Trip",
      rawMarkdown: "",
      days: [planDay("2025-06-10", 0)],
      items: [planItem("2025-06-10", 4, "pack the bags")],
    });
    expect((await readItems(t, "trip"))[0].done).toBe(true);
  });

  it("gives each of two identical titles its own carried state, nearest order first", async () => {
    const t = withConvex();
    await t.mutation(api.plans.upsertPlan, {
      ...auth,
      slug: "trip",
      title: "Trip",
      rawMarkdown: "",
      days: [planDay("2025-06-10", 0)],
      items: [planItem("2025-06-10", 1, "call"), planItem("2025-06-10", 5, "call")],
    });
    const items = await readItems(t, "trip");
    await t.mutation(api.plans.toggleDone, { ...auth, itemId: items[1]._id });
    await t.mutation(api.plans.upsertPlan, {
      ...auth,
      slug: "trip",
      title: "Trip",
      rawMarkdown: "",
      days: [planDay("2025-06-10", 0)],
      items: [planItem("2025-06-10", 2, "call"), planItem("2025-06-10", 6, "call")],
    });
    expect((await readItems(t, "trip")).map((i) => i.done)).toEqual([false, true]);
  });

  it("pins identity to a supplied calendar event id even when the title was rewritten", async () => {
    const t = withConvex();
    await t.mutation(api.calendar.upsertItemsFromCalendar, {
      ...auth,
      planSlug: "trip",
      date: "2025-06-10",
      items: [{ title: "standup", calendarEventId: "evt-1" }],
    });
    const items = await readItems(t, "trip");
    await t.mutation(api.plans.toggleDone, { ...auth, itemId: items[0]._id });
    await t.mutation(api.plans.upsertPlan, {
      ...auth,
      slug: "trip",
      title: "Trip",
      rawMarkdown: "",
      days: [planDay("2025-06-10", 0)],
      items: [planItem("2025-06-10", 3, "Daily standup (renamed)", { kind: "event", calendarEventId: "evt-1" })],
    });
    expect((await readItems(t, "trip"))[0]).toMatchObject({ done: true, calendarEventId: "evt-1" });
  });

  it("does not carry a done flag across dates", async () => {
    const t = withConvex();
    await t.mutation(api.plans.upsertPlan, {
      ...auth,
      slug: "trip",
      title: "Trip",
      rawMarkdown: "",
      days: [planDay("2025-06-10", 0)],
      items: [planItem("2025-06-10", 1, "pack")],
    });
    const items = await readItems(t, "trip");
    await t.mutation(api.plans.toggleDone, { ...auth, itemId: items[0]._id });
    await t.mutation(api.plans.upsertPlan, {
      ...auth,
      slug: "trip",
      title: "Trip",
      rawMarkdown: "",
      days: [planDay("2025-06-11", 0)],
      items: [planItem("2025-06-11", 1, "pack")],
    });
    expect((await readItems(t, "trip"))[0].done).toBe(false);
  });

  it("keeps the outlook event id of an item the re-import lists under the same title", async () => {
    const t = withConvex();
    await t.mutation(api.calendar.upsertItemsFromCalendar, {
      ...auth,
      planSlug: "trip",
      date: "2025-06-10",
      items: [{ title: "standup", calendarEventId: "evt-1" }],
    });
    await t.mutation(api.plans.upsertPlan, {
      ...auth,
      slug: "trip",
      title: "Trip",
      rawMarkdown: "",
      days: [planDay("2025-06-10", 0)],
      items: [planItem("2025-06-10", 0, "standup", { kind: "event" })],
    });
    expect((await readItems(t, "trip"))[0].calendarEventId).toBe("evt-1");
  });

  // The cost of "position is not identity", pinned so it stays a decision
  // rather than a surprise. A rename is indistinguishable from a replacement
  // when the markdown carries no event id, and this is the side we chose.
  it("drops the outlook link when a re-import renames the item, and then duplicates it", async () => {
    const t = withConvex();
    await t.mutation(api.calendar.upsertItemsFromCalendar, {
      ...auth,
      planSlug: "trip",
      date: "2025-06-10",
      items: [{ title: "standup", calendarEventId: "evt-1" }],
    });
    await t.mutation(api.plans.upsertPlan, {
      ...auth,
      slug: "trip",
      title: "Trip",
      rawMarkdown: "",
      days: [planDay("2025-06-10", 0)],
      items: [planItem("2025-06-10", 0, "morning standup", { kind: "event" })],
    });
    expect((await readItems(t, "trip"))[0].calendarEventId).toBeUndefined();

    // With the link gone, the calendar's id-only dedupe cannot find the row.
    await t.mutation(api.calendar.upsertItemsFromCalendar, {
      ...auth,
      planSlug: "trip",
      date: "2025-06-10",
      items: [{ title: "standup", calendarEventId: "evt-1" }],
    });
    expect((await readItems(t, "trip")).map((i) => i.title)).toEqual(["morning standup", "standup"]);
  });

  it("discards the stored embedding of every item it rewrites", async () => {
    const t = withConvex();
    const args = {
      ...auth,
      slug: "trip",
      title: "Trip",
      rawMarkdown: "",
      days: [planDay("2025-06-10", 0)],
      items: [planItem("2025-06-10", 1, "pack")],
    };
    await t.mutation(api.plans.upsertPlan, args);
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("planItems").collect();
      await ctx.db.patch(rows[0]._id, { embedding: Array.from({ length: 384 }, () => 0.1), embeddedAt: 5 });
    });
    await t.mutation(api.plans.upsertPlan, args);
    const after = await readItems(t, "trip");
    expect(after[0].embedding).toBeUndefined();
    expect(after[0].embeddedAt).toBeUndefined();
  });

  it("replaces the whole day set rather than merging into it", async () => {
    const t = withConvex();
    await t.mutation(api.plans.upsertPlan, {
      ...auth,
      slug: "trip",
      title: "Trip",
      rawMarkdown: "",
      days: [planDay("2025-06-10", 0), planDay("2025-06-11", 1)],
      items: [],
    });
    await t.mutation(api.plans.upsertPlan, {
      ...auth,
      slug: "trip",
      title: "Trip",
      rawMarkdown: "",
      days: [planDay("2025-06-11", 0)],
      items: [],
    });
    expect((await readDays(t, "trip")).map((d) => d.date)).toEqual(["2025-06-11"]);
  });
});

describe("single item edits", () => {
  it("flips the done flag on each call", async () => {
    const t = withConvex();
    const itemId = await t.mutation(api.plans.createItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      title: "pack",
    });
    await t.mutation(api.plans.toggleDone, { ...auth, itemId });
    expect((await readItems(t, "trip"))[0].done).toBe(true);
    await t.mutation(api.plans.toggleDone, { ...auth, itemId });
    expect((await readItems(t, "trip"))[0].done).toBe(false);
  });

  it("does nothing when the toggled item has already been deleted", async () => {
    const t = withConvex();
    const itemId = await t.mutation(api.plans.createItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      title: "pack",
    });
    await t.mutation(api.plans.deleteItem, { ...auth, itemId });
    await expect(t.mutation(api.plans.toggleDone, { ...auth, itemId })).resolves.toBeNull();
  });

  it("numbers the first item of an empty day 1, so order 0 is never used", async () => {
    const t = withConvex();
    await t.mutation(api.plans.createItem, { ...auth, slug: "trip", date: "2025-06-10", title: "first" });
    expect((await readItems(t, "trip"))[0].order).toBe(1);
  });

  it("appends after the highest order already on that day", async () => {
    const t = withConvex();
    await t.run(async (ctx) => {
      await ctx.db.insert("planItems", {
        planSlug: "trip",
        date: "2025-06-10",
        kind: "event",
        order: 7,
        title: "existing",
        tags: [],
        done: false,
      });
    });
    await t.mutation(api.plans.createItem, { ...auth, slug: "trip", date: "2025-06-10", title: "next" });
    const items = await readItems(t, "trip");
    expect(items.find((i) => i.title === "next")?.order).toBe(8);
  });

  it("numbers each day independently", async () => {
    const t = withConvex();
    await t.mutation(api.plans.createItem, { ...auth, slug: "trip", date: "2025-06-10", title: "a" });
    await t.mutation(api.plans.createItem, { ...auth, slug: "trip", date: "2025-06-10", title: "b" });
    await t.mutation(api.plans.createItem, { ...auth, slug: "trip", date: "2025-06-11", title: "c" });
    const items = await readItems(t, "trip");
    expect(items.map((i) => [i.date, i.order])).toEqual([
      ["2025-06-10", 1],
      ["2025-06-10", 2],
      ["2025-06-11", 1],
    ]);
  });

  it("mirrors a created time into timeStart and leaves timeEnd unset", async () => {
    const t = withConvex();
    await t.mutation(api.plans.createItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      title: "call",
      time: "09:30",
    });
    const created = (await readItems(t, "trip"))[0];
    expect(created).toMatchObject({ time: "09:30", timeStart: "09:30", kind: "event", done: false });
    expect(created.timeEnd).toBeUndefined();
  });

  it("patches only the fields the update supplies", async () => {
    const t = withConvex();
    const itemId = await t.mutation(api.plans.createItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      title: "call",
      time: "09:30",
      location: "office",
    });
    await t.mutation(api.plans.updateItem, { ...auth, itemId, title: "call renamed" });
    expect((await readItems(t, "trip"))[0]).toMatchObject({
      title: "call renamed",
      time: "09:30",
      location: "office",
    });
  });

  it("re-mirrors timeStart whenever the time is updated", async () => {
    const t = withConvex();
    const itemId = await t.mutation(api.plans.createItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      title: "call",
      time: "09:30",
    });
    await t.mutation(api.plans.updateItem, { ...auth, itemId, time: "11:00" });
    expect((await readItems(t, "trip"))[0]).toMatchObject({ time: "11:00", timeStart: "11:00" });
  });

  it("moves an item to another day without renumbering it", async () => {
    const t = withConvex();
    const itemId = await t.mutation(api.plans.createItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      title: "call",
    });
    await t.mutation(api.plans.updateItem, { ...auth, itemId, date: "2025-06-11" });
    const moved = (await readItems(t, "trip"))[0];
    // Order is untouched by the move, so the item can collide with an item
    // already sitting at that order on the destination day.
    expect(moved).toMatchObject({ date: "2025-06-11", order: 1 });
  });

  it("does nothing when the updated item has already been deleted", async () => {
    const t = withConvex();
    const itemId = await t.mutation(api.plans.createItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      title: "call",
    });
    await t.mutation(api.plans.deleteItem, { ...auth, itemId });
    await expect(t.mutation(api.plans.updateItem, { ...auth, itemId, title: "x" })).resolves.toBeNull();
  });

  it("adds and removes the archived tag, matching existing tags case-insensitively", async () => {
    const t = withConvex();
    const itemId = await t.mutation(api.plans.createItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      title: "call",
    });
    await t.run(async (ctx) => ctx.db.patch(itemId, { tags: ["Archived", "flight"] }));
    await t.mutation(api.plans.setArchived, { ...auth, itemId, archived: true });
    expect((await readItems(t, "trip"))[0].tags).toEqual(["flight", "archived"]);
    await t.mutation(api.plans.setArchived, { ...auth, itemId, archived: false });
    expect((await readItems(t, "trip"))[0].tags).toEqual(["flight"]);
  });

  it("removes the row it is asked to delete and leaves the rest of the day alone", async () => {
    const t = withConvex();
    const keep = await t.mutation(api.plans.createItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      title: "keep",
    });
    const drop = await t.mutation(api.plans.createItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      title: "drop",
    });
    await t.mutation(api.plans.deleteItem, { ...auth, itemId: drop });
    const items = await readItems(t, "trip");
    expect(items.map((i) => i._id)).toEqual([keep]);
  });
});

describe("match-or-insert item edits", () => {
  it("patches the first item on that day whose title starts with the match string", async () => {
    const t = withConvex();
    await t.mutation(api.plans.createItem, { ...auth, slug: "trip", date: "2025-06-10", title: "Flight LH123" });
    const res = await t.mutation(api.plans.editPlanItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      matchTitle: "Flight",
      time: "07:15",
    });
    expect(res).toBe("patched: Flight LH123");
    expect((await readItems(t, "trip"))[0].time).toBe("07:15");
  });

  it("inserts a new item when the matching title lives on a different day", async () => {
    const t = withConvex();
    await t.mutation(api.plans.createItem, { ...auth, slug: "trip", date: "2025-06-10", title: "Flight LH123" });
    const res = await t.mutation(api.plans.editPlanItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-11",
      matchTitle: "Flight",
    });
    expect(res).toBe("inserted: Flight");
    const items = await readItems(t, "trip");
    expect(items.map((i) => [i.date, i.title])).toEqual([
      ["2025-06-10", "Flight LH123"],
      ["2025-06-11", "Flight"],
    ]);
  });

  it("numbers an inserted item after the highest order on that day", async () => {
    const t = withConvex();
    await t.mutation(api.plans.createItem, { ...auth, slug: "trip", date: "2025-06-10", title: "a" });
    await t.mutation(api.plans.editPlanItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      matchTitle: "b",
      addTags: ["hotel"],
    });
    const items = await readItems(t, "trip");
    expect(items.map((i) => [i.title, i.order])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(items[1].tags).toEqual(["hotel"]);
  });

  it("replaces a previous end date tag instead of stacking a second one", async () => {
    const t = withConvex();
    await t.mutation(api.plans.editPlanItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      matchTitle: "Hotel",
      end: "2025-06-12",
    });
    await t.mutation(api.plans.editPlanItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      matchTitle: "Hotel",
      end: "2025-06-14",
    });
    expect((await readItems(t, "trip"))[0].tags).toEqual(["end:2025-06-14"]);
  });

  it("merges added tags into an existing item without duplicating them", async () => {
    const t = withConvex();
    await t.mutation(api.plans.editPlanItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      matchTitle: "Hotel",
      addTags: ["stay"],
    });
    await t.mutation(api.plans.editPlanItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      matchTitle: "Hotel",
      addTags: ["stay", "confirmed"],
    });
    expect((await readItems(t, "trip"))[0].tags).toEqual(["stay", "confirmed"]);
  });

  it("ignores an empty string title but clears an emptied notes and location", async () => {
    const t = withConvex();
    await t.mutation(api.plans.createItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      title: "Hotel Ibis",
      notes: "breakfast included",
      location: "Lyon",
    });
    await t.mutation(api.plans.editPlanItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      matchTitle: "Hotel",
      title: "",
      notes: "",
      location: "",
    });
    // A blank title would erase the item's own handle, so it is ignored; the
    // other blanks are a deliberate "clear this field".
    const item = (await readItems(t, "trip"))[0];
    expect(item.title).toBe("Hotel Ibis");
    expect(item.notes).toBeUndefined();
    expect(item.location).toBeUndefined();
  });

  it("leaves a field alone when the edit does not mention it", async () => {
    const t = withConvex();
    await t.mutation(api.plans.createItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      title: "Hotel Ibis",
      notes: "breakfast included",
    });
    await t.mutation(api.plans.editPlanItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      matchTitle: "Hotel",
      location: "Lyon",
    });
    expect((await readItems(t, "trip"))[0]).toMatchObject({ notes: "breakfast included", location: "Lyon" });
  });

  it("clears the mirrored timeStart when the time is emptied", async () => {
    const t = withConvex();
    await t.mutation(api.plans.createItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      title: "Hotel Ibis",
      time: "18:00",
    });
    await t.mutation(api.plans.editPlanItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      matchTitle: "Hotel",
      time: "",
    });
    const item = (await readItems(t, "trip"))[0];
    expect(item.time).toBeUndefined();
    expect(item.timeStart).toBeUndefined();
  });

  it("falls back to the match title when an inserted item is given a blank title", async () => {
    const t = withConvex();
    const res = await t.mutation(api.plans.editPlanItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      matchTitle: "Hotel",
      title: "",
      notes: "",
    });
    expect(res).toBe("inserted: Hotel");
    const item = (await readItems(t, "trip"))[0];
    expect(item.title).toBe("Hotel");
    expect(item.notes).toBeUndefined();
  });

  it("keeps the done flag and the order of the item it patches", async () => {
    const t = withConvex();
    const itemId: Id<"planItems"> = await t.mutation(api.plans.createItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      title: "Hotel Ibis",
    });
    await t.mutation(api.plans.toggleDone, { ...auth, itemId });
    await t.mutation(api.plans.editPlanItem, {
      ...auth,
      slug: "trip",
      date: "2025-06-10",
      matchTitle: "Hotel",
      location: "Lyon",
    });
    expect((await readItems(t, "trip"))[0]).toMatchObject({ done: true, order: 1, location: "Lyon" });
  });
});
