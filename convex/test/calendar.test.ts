import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { auth, withConvex } from "./harness.setup";

type Harness = ReturnType<typeof withConvex>;

// The handlers derive their day keys with `new Date("<date>T00:00:00")`, which
// parses in the process timezone. Mirroring that here keeps the expectation
// honest about what the code does instead of hard-coding a UTC epoch day.
const epochDay = (date: string) => Math.round(new Date(`${date}T00:00:00`).getTime() / 86_400_000);

async function seedRequest(
  t: Harness,
  planSlug: string,
  date: string,
  createdAt: number,
  status: "pending" | "done" | "error" = "pending",
): Promise<Id<"calendarRequests">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("calendarRequests", { kind: "syncDay", status, planSlug, date, createdAt }),
  );
}

async function readRequests(t: Harness) {
  return await t.run(async (ctx) => ctx.db.query("calendarRequests").collect());
}

async function readItems(t: Harness, planSlug: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("planItems")
      .withIndex("by_plan_date_order", (q) => q.eq("planSlug", planSlug))
      .collect(),
  );
}

async function readDays(t: Harness, planSlug: string) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("planDays")
      .withIndex("by_plan_order", (q) => q.eq("planSlug", planSlug))
      .collect();
    return rows.sort((a, b) => a.date.localeCompare(b.date));
  });
}

describe("queueing a single day sync", () => {
  it("leaves a pending request the worker can pick up", async () => {
    const t = withConvex();
    const { id } = await t.mutation(api.calendar.requestSyncDay, {
      ...auth,
      planSlug: "trip",
      date: "2025-06-10",
    });
    const row = await t.query(api.calendar.getRequest, { ...auth, id });
    expect(row).toMatchObject({ kind: "syncDay", status: "pending", planSlug: "trip", date: "2025-06-10" });
  });

  it("does not create the plan day it refers to", async () => {
    const t = withConvex();
    await t.mutation(api.calendar.requestSyncDay, { ...auth, planSlug: "trip", date: "2025-06-10" });
    expect(await readDays(t, "trip")).toEqual([]);
  });
});

describe("queueing a day range", () => {
  it("covers both endpoints of the range", async () => {
    const t = withConvex();
    const res = await t.mutation(api.calendar.requestSyncRange, {
      ...auth,
      planSlug: "trip",
      start: "2025-06-10",
      end: "2025-06-12",
    });
    expect(res).toEqual({ queued: 3, created: 3 });
    const dates = (await readRequests(t)).map((r) => r.date).sort();
    expect(dates).toEqual(["2025-06-10", "2025-06-11", "2025-06-12"]);
  });

  it("queues a single day when start and end are the same date", async () => {
    const t = withConvex();
    const res = await t.mutation(api.calendar.requestSyncRange, {
      ...auth,
      planSlug: "trip",
      start: "2025-06-10",
      end: "2025-06-10",
    });
    expect(res).toEqual({ queued: 1, created: 1 });
  });

  it("queues nothing when the end precedes the start", async () => {
    const t = withConvex();
    const res = await t.mutation(api.calendar.requestSyncRange, {
      ...auth,
      planSlug: "trip",
      start: "2025-06-12",
      end: "2025-06-10",
    });
    expect(res).toEqual({ queued: 0, created: 0 });
    expect(await readRequests(t)).toEqual([]);
  });

  it("rolls the day key over a month and a year boundary", async () => {
    const t = withConvex();
    await t.mutation(api.calendar.requestSyncRange, {
      ...auth,
      planSlug: "trip",
      start: "2025-12-30",
      end: "2026-01-02",
    });
    expect((await readDays(t, "trip")).map((d) => d.date)).toEqual([
      "2025-12-30",
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
    ]);
  });

  it("counts 29 February in a leap year", async () => {
    const t = withConvex();
    await t.mutation(api.calendar.requestSyncRange, {
      ...auth,
      planSlug: "trip",
      start: "2024-02-28",
      end: "2024-03-01",
    });
    expect((await readDays(t, "trip")).map((d) => d.date)).toEqual(["2024-02-28", "2024-02-29", "2024-03-01"]);
  });

  it("skips 29 February outside a leap year", async () => {
    const t = withConvex();
    await t.mutation(api.calendar.requestSyncRange, {
      ...auth,
      planSlug: "trip",
      start: "2025-02-27",
      end: "2025-03-01",
    });
    expect((await readDays(t, "trip")).map((d) => d.date)).toEqual(["2025-02-27", "2025-02-28", "2025-03-01"]);
  });

  it("emits one day per calendar date across a daylight saving transition", async () => {
    const t = withConvex();
    // The loop steps a local Date by one day at a time, so a zone that shifts
    // its clock inside the range must still yield three distinct dates.
    const res = await t.mutation(api.calendar.requestSyncRange, {
      ...auth,
      planSlug: "trip",
      start: "2025-03-29",
      end: "2025-03-31",
    });
    expect(res.queued).toBe(3);
    expect((await readDays(t, "trip")).map((d) => d.date)).toEqual(["2025-03-29", "2025-03-30", "2025-03-31"]);
  });

  it("stops after 62 days on a range that spans a year", async () => {
    const t = withConvex();
    const res = await t.mutation(api.calendar.requestSyncRange, {
      ...auth,
      planSlug: "trip",
      start: "2025-01-01",
      end: "2025-12-31",
    });
    expect(res).toEqual({ queued: 62, created: 62 });
    const days = await readDays(t, "trip");
    expect(days[days.length - 1].date).toBe("2025-03-03");
  });

  it("reuses a plan day that already exists and only counts the new ones", async () => {
    const t = withConvex();
    await t.run(async (ctx) => ctx.db.insert("planDays", { planSlug: "trip", date: "2025-06-11", order: 99 }));
    const res = await t.mutation(api.calendar.requestSyncRange, {
      ...auth,
      planSlug: "trip",
      start: "2025-06-10",
      end: "2025-06-12",
    });
    expect(res).toEqual({ queued: 3, created: 2 });
    const days = await readDays(t, "trip");
    expect(days).toHaveLength(3);
    expect(days.find((d) => d.date === "2025-06-11")?.order).toBe(99);
  });

  it("queues a second request for a day that already has one pending", async () => {
    const t = withConvex();
    await seedRequest(t, "trip", "2025-06-10", 1);
    const res = await t.mutation(api.calendar.requestSyncRange, {
      ...auth,
      planSlug: "trip",
      start: "2025-06-10",
      end: "2025-06-10",
    });
    expect(res.queued).toBe(1);
    expect(await readRequests(t)).toHaveLength(2);
  });

  it("ignores plan days that belong to another plan when deciding what to create", async () => {
    const t = withConvex();
    await t.run(async (ctx) => ctx.db.insert("planDays", { planSlug: "other", date: "2025-06-10", order: 0 }));
    const res = await t.mutation(api.calendar.requestSyncRange, {
      ...auth,
      planSlug: "trip",
      start: "2025-06-10",
      end: "2025-06-10",
    });
    expect(res.created).toBe(1);
  });

  it("numbers plan days by days since the epoch, unlike the recent sync's 0-based order", async () => {
    const t = withConvex();
    await t.mutation(api.calendar.requestSyncRange, {
      ...auth,
      planSlug: "trip",
      start: "2025-06-10",
      end: "2025-06-11",
    });
    const orders = (await readDays(t, "trip")).map((d) => d.order);
    expect(orders).toEqual([epochDay("2025-06-10"), epochDay("2025-06-11")]);
    expect(orders[1] - orders[0]).toBe(1);

    await t.mutation(api.plans.requestRecentSync, { ...auth, today: "2025-06-10", rangeDays: 1 });
    // Two writers, two unrelated numbering schemes on the same column: the
    // by_plan_order index cannot be compared across plans built by each.
    expect((await readDays(t, "recent-calendar")).map((d) => d.order)).toEqual([0, 1]);
  });
});

describe("worker request queue", () => {
  it("hands out the oldest pending request first", async () => {
    const t = withConvex();
    await seedRequest(t, "trip", "2025-06-11", 300);
    await seedRequest(t, "trip", "2025-06-09", 100);
    await seedRequest(t, "trip", "2025-06-10", 200);
    const next = await t.query(api.calendar.getPendingRequest, { ...auth });
    expect(next?.date).toBe("2025-06-09");
  });

  it("hands out nothing once every request has been handled", async () => {
    const t = withConvex();
    await seedRequest(t, "trip", "2025-06-10", 100, "done");
    await seedRequest(t, "trip", "2025-06-11", 200, "error");
    expect(await t.query(api.calendar.getPendingRequest, { ...auth })).toBeNull();
  });

  it("takes a request off the queue as soon as it is claimed", async () => {
    const t = withConvex();
    const id = await seedRequest(t, "trip", "2025-06-10", 100);
    const claimed = await t.mutation(api.calendar.claimRequest, { ...auth, id });
    expect(claimed?.date).toBe("2025-06-10");
    // The claim writes the terminal status straight away, so a worker that dies
    // mid-sync leaves the row looking successful. Fixing this means claiming
    // into "running" like mailbox:claimRequest, which calendarRequests.status
    // in convex/schema.ts does not yet permit.
    expect((await t.query(api.calendar.getRequest, { ...auth, id }))?.status).toBe("done");
    expect(await t.query(api.calendar.getPendingRequest, { ...auth })).toBeNull();
  });

  it("refuses a second claim of the same request", async () => {
    const t = withConvex();
    const id = await seedRequest(t, "trip", "2025-06-10", 100);
    await t.mutation(api.calendar.claimRequest, { ...auth, id });
    expect(await t.mutation(api.calendar.claimRequest, { ...auth, id })).toBeNull();
  });

  it("records the failure of a request that was already claimed", async () => {
    const t = withConvex();
    const id = await seedRequest(t, "trip", "2025-06-10", 100);
    await t.mutation(api.calendar.claimRequest, { ...auth, id });
    await t.mutation(api.calendar.completeRequest, { ...auth, id, status: "error", error: "mgc timed out" });
    const row = await t.query(api.calendar.getRequest, { ...auth, id });
    expect(row).toMatchObject({ status: "error", error: "mgc timed out" });
    expect(typeof row?.completedAt).toBe("number");
  });

  it("stores the worker's summary on a successful completion", async () => {
    const t = withConvex();
    const id = await seedRequest(t, "trip", "2025-06-10", 100);
    await t.mutation(api.calendar.completeRequest, { ...auth, id, status: "done", result: "3 events" });
    expect((await t.query(api.calendar.getRequest, { ...auth, id }))?.result).toBe("3 events");
  });

  it("shows the newest request for a day, ignoring the same day on another plan", async () => {
    const t = withConvex();
    await seedRequest(t, "trip", "2025-06-10", 100, "error");
    await seedRequest(t, "other", "2025-06-10", 150);
    const newest = await seedRequest(t, "trip", "2025-06-10", 200);
    const row = await t.query(api.calendar.latestForDay, { ...auth, planSlug: "trip", date: "2025-06-10" });
    expect(row?._id).toBe(newest);
  });

  it("shows nothing for a day that was never queued", async () => {
    const t = withConvex();
    await seedRequest(t, "trip", "2025-06-10", 100);
    expect(await t.query(api.calendar.latestForDay, { ...auth, planSlug: "trip", date: "2025-06-11" })).toBeNull();
  });
});

describe("folding outlook events into a plan day", () => {
  it("numbers the first event of an empty day 0, where a hand-made item would start at 1", async () => {
    const t = withConvex();
    const res = await t.mutation(api.calendar.upsertItemsFromCalendar, {
      ...auth,
      planSlug: "trip",
      date: "2025-06-10",
      items: [{ title: "standup", calendarEventId: "evt-1" }],
    });
    expect(res).toEqual({ inserted: 1, updated: 0 });
    expect((await readItems(t, "trip"))[0]).toMatchObject({ order: 0, kind: "event", tier: 2, done: false });
  });

  it("appends after items a human already put on that day", async () => {
    const t = withConvex();
    await t.mutation(api.plans.createItem, { ...auth, slug: "trip", date: "2025-06-10", title: "manual" });
    await t.mutation(api.calendar.upsertItemsFromCalendar, {
      ...auth,
      planSlug: "trip",
      date: "2025-06-10",
      items: [{ title: "standup", calendarEventId: "evt-1" }],
    });
    const items = await readItems(t, "trip");
    expect(items.map((i) => [i.title, i.order])).toEqual([
      ["manual", 1],
      ["standup", 2],
    ]);
  });

  it("updates an event in place on a re-sync instead of duplicating it", async () => {
    const t = withConvex();
    const send = (title: string, time: string) =>
      t.mutation(api.calendar.upsertItemsFromCalendar, {
        ...auth,
        planSlug: "trip",
        date: "2025-06-10",
        items: [{ title, time, timeStart: time, calendarEventId: "evt-1" }],
      });
    await send("standup", "09:00");
    const res = await send("standup moved", "09:30");
    expect(res).toEqual({ inserted: 0, updated: 1 });
    const items = await readItems(t, "trip");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "standup moved", time: "09:30", order: 0 });
  });

  it("keeps the done flag a user set on a re-synced event", async () => {
    const t = withConvex();
    await t.mutation(api.calendar.upsertItemsFromCalendar, {
      ...auth,
      planSlug: "trip",
      date: "2025-06-10",
      items: [{ title: "standup", calendarEventId: "evt-1" }],
    });
    const itemId = (await readItems(t, "trip"))[0]._id;
    await t.mutation(api.plans.toggleDone, { ...auth, itemId });
    await t.mutation(api.calendar.upsertItemsFromCalendar, {
      ...auth,
      planSlug: "trip",
      date: "2025-06-10",
      items: [{ title: "standup", calendarEventId: "evt-1" }],
    });
    expect((await readItems(t, "trip"))[0].done).toBe(true);
  });

  it("clears the times of an event that came back without them", async () => {
    const t = withConvex();
    await t.mutation(api.calendar.upsertItemsFromCalendar, {
      ...auth,
      planSlug: "trip",
      date: "2025-06-10",
      items: [{ title: "standup", time: "09:00", timeStart: "09:00", timeEnd: "09:15", calendarEventId: "evt-1" }],
    });
    await t.mutation(api.calendar.upsertItemsFromCalendar, {
      ...auth,
      planSlug: "trip",
      date: "2025-06-10",
      items: [{ title: "standup", calendarEventId: "evt-1" }],
    });
    const item = (await readItems(t, "trip"))[0];
    expect(item.time).toBeUndefined();
    expect(item.timeEnd).toBeUndefined();
  });

  it("keeps a tier the previous sync assigned when the new payload omits it", async () => {
    const t = withConvex();
    await t.mutation(api.calendar.upsertItemsFromCalendar, {
      ...auth,
      planSlug: "trip",
      date: "2025-06-10",
      items: [{ title: "standup", tier: 1, tags: ["work"], calendarEventId: "evt-1" }],
    });
    await t.mutation(api.calendar.upsertItemsFromCalendar, {
      ...auth,
      planSlug: "trip",
      date: "2025-06-10",
      items: [{ title: "standup", calendarEventId: "evt-1" }],
    });
    expect((await readItems(t, "trip"))[0]).toMatchObject({ tier: 1, tags: ["work"] });
  });

  it("leaves behind an item whose outlook event has disappeared", async () => {
    const t = withConvex();
    await t.mutation(api.calendar.upsertItemsFromCalendar, {
      ...auth,
      planSlug: "trip",
      date: "2025-06-10",
      items: [
        { title: "standup", calendarEventId: "evt-1" },
        { title: "cancelled", calendarEventId: "evt-2" },
      ],
    });
    await t.mutation(api.calendar.upsertItemsFromCalendar, {
      ...auth,
      planSlug: "trip",
      date: "2025-06-10",
      items: [{ title: "standup", calendarEventId: "evt-1" }],
    });
    // Nothing deletes stale rows, which is why the recent-calendar plan wipes
    // its items on every sync instead of relying on this.
    expect((await readItems(t, "trip")).map((i) => i.title)).toEqual(["standup", "cancelled"]);
  });

  it("folds a payload that repeats the same event id into one row", async () => {
    const t = withConvex();
    const res = await t.mutation(api.calendar.upsertItemsFromCalendar, {
      ...auth,
      planSlug: "trip",
      date: "2025-06-10",
      items: [
        { title: "standup", calendarEventId: "evt-1" },
        { title: "standup again", calendarEventId: "evt-1" },
      ],
    });
    // The dedupe map is updated as rows are written, so the repeat upserts the
    // row the same payload just inserted and the later title wins.
    expect(res).toEqual({ inserted: 1, updated: 1 });
    const items = await readItems(t, "trip");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "standup again", order: 0 });
  });

  it("syncs only the last of a twin pair sharing an event id and leaves the other alone", async () => {
    const t = withConvex();
    // A payload that repeated an id used to write two rows on one day. That is
    // fixed, so a pair like this can only be a leftover; seed it directly.
    await t.run(async (ctx) => {
      for (const [order, title] of [
        [0, "standup"],
        [1, "standup again"],
      ] as const) {
        await ctx.db.insert("planItems", {
          planSlug: "trip",
          date: "2025-06-10",
          order,
          kind: "event",
          title,
          tags: [],
          done: false,
          calendarEventId: "evt-1",
        });
      }
    });
    await t.mutation(api.calendar.upsertItemsFromCalendar, {
      ...auth,
      planSlug: "trip",
      date: "2025-06-10",
      items: [{ title: "renamed", calendarEventId: "evt-1" }],
    });
    expect((await readItems(t, "trip")).map((i) => i.title)).toEqual(["standup", "renamed"]);
  });

  it("duplicates an event that moved to another day rather than moving the row", async () => {
    const t = withConvex();
    await t.mutation(api.calendar.upsertItemsFromCalendar, {
      ...auth,
      planSlug: "trip",
      date: "2025-06-10",
      items: [{ title: "standup", calendarEventId: "evt-1" }],
    });
    await t.mutation(api.calendar.upsertItemsFromCalendar, {
      ...auth,
      planSlug: "trip",
      date: "2025-06-11",
      items: [{ title: "standup", calendarEventId: "evt-1" }],
    });
    // Known and accepted: the upsert key includes the date, so the old day
    // keeps a copy of an event that is no longer scheduled there. The next test
    // is why the obvious fix is not taken.
    expect((await readItems(t, "trip")).map((i) => [i.date, i.title])).toEqual([
      ["2025-06-10", "standup"],
      ["2025-06-11", "standup"],
    ]);
  });

  it("keeps an imported item on the day a user re-dated it to", async () => {
    const t = withConvex();
    await t.mutation(api.calendar.upsertItemsFromCalendar, {
      ...auth,
      planSlug: "trip",
      date: "2025-06-10",
      items: [{ title: "standup", calendarEventId: "evt-1" }],
    });
    const itemId = (await readItems(t, "trip"))[0]._id;
    await t.mutation(api.plans.updateItem, { ...auth, itemId, date: "2025-06-12" });
    // Outlook still reports the event on the 10th, so this is the re-sync that
    // an event-id-keyed upsert would use to undo the user's move.
    await t.mutation(api.calendar.upsertItemsFromCalendar, {
      ...auth,
      planSlug: "trip",
      date: "2025-06-10",
      items: [{ title: "standup", calendarEventId: "evt-1" }],
    });
    const items = await readItems(t, "trip");
    expect(items.map((i) => [i.date, i.title])).toEqual([
      ["2025-06-10", "standup"],
      ["2025-06-12", "standup"],
    ]);
  });

  it("keeps the same event id independent across plans", async () => {
    const t = withConvex();
    for (const planSlug of ["trip", "other"]) {
      await t.mutation(api.calendar.upsertItemsFromCalendar, {
        ...auth,
        planSlug,
        date: "2025-06-10",
        items: [{ title: "standup", calendarEventId: "evt-1" }],
      });
    }
    expect(await readItems(t, "trip")).toHaveLength(1);
    expect(await readItems(t, "other")).toHaveLength(1);
  });

  it("writes nothing for an empty payload", async () => {
    const t = withConvex();
    const res = await t.mutation(api.calendar.upsertItemsFromCalendar, {
      ...auth,
      planSlug: "trip",
      date: "2025-06-10",
      items: [],
    });
    expect(res).toEqual({ inserted: 0, updated: 0 });
    expect(await readItems(t, "trip")).toEqual([]);
  });

  it("imports a todo when the payload asks for one", async () => {
    const t = withConvex();
    await t.mutation(api.calendar.upsertItemsFromCalendar, {
      ...auth,
      planSlug: "trip",
      date: "2025-06-10",
      items: [{ title: "book flight", kind: "todo", calendarEventId: "evt-1" }],
    });
    expect((await readItems(t, "trip"))[0].kind).toBe("todo");
  });
});
