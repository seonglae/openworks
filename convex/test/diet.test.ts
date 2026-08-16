import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { auth, withConvex } from "./harness.setup";

type Harness = ReturnType<typeof withConvex>;

type Macros = { kcal?: number; protein?: number; carbs?: number; fat?: number };

// createdAt is seeded explicitly everywhere: the handlers sort on it, and a
// clock-derived value would make the ordering assertions depend on run speed.
async function seedEntry(
  t: Harness,
  date: string,
  createdAt: number,
  over: Macros & { name?: string; status?: "pending" | "analyzing" | "done" | "error" } = {},
): Promise<Id<"foodEntries">> {
  const { status = "done", name = "food", ...macros } = over;
  return await t.run(async (ctx) => ctx.db.insert("foodEntries", { date, status, name, createdAt, ...macros }));
}

describe("logging a food entry", () => {
  it("stores the day key the caller supplies without deriving one server-side", async () => {
    const t = withConvex();
    // The server clock is in whatever zone Convex runs in, so a date the caller
    // could never be in must survive untouched.
    const id = await t.mutation(api.diet.createEntry, { ...auth, date: "1999-01-01", name: "toast" });
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.date).toBe("1999-01-01");
  });

  it("pads an unpadded day key so range queries compare strings correctly", async () => {
    const t = withConvex();
    const id = await t.mutation(api.diet.createEntry, { ...auth, date: "2025-1-9" });
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.date).toBe("2025-01-09");
  });

  it("stores an already-padded day key unchanged", async () => {
    const t = withConvex();
    const id = await t.mutation(api.diet.createEntry, { ...auth, date: "2025-01-09" });
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.date).toBe("2025-01-09");
  });

  it("rejects a day key that is not a calendar date", async () => {
    const t = withConvex();
    for (const date of ["not-a-date", "2025-13-01", "2025-02-30", "20250109", "2025-06-10T09:00:00Z", ""]) {
      await expect(t.mutation(api.diet.createEntry, { ...auth, date })).rejects.toThrow(/Invalid date/);
    }
  });

  it("accepts 29 February only in a leap year", async () => {
    const t = withConvex();
    const id = await t.mutation(api.diet.createEntry, { ...auth, date: "2024-2-29" });
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.date).toBe("2024-02-29");
    await expect(t.mutation(api.diet.createEntry, { ...auth, date: "2025-02-29" })).rejects.toThrow(/Invalid date/);
  });

  it("starts a new entry pending with no macros attached", async () => {
    const t = withConvex();
    const id = await t.mutation(api.diet.createEntry, { ...auth, date: "2025-06-10", notes: "big bowl" });
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row).toMatchObject({ status: "pending", notes: "big bowl" });
    expect(row?.kcal).toBeUndefined();
  });

  it("hands out an upload url for the photo", async () => {
    const t = withConvex();
    const url = await t.mutation(api.diet.generateUploadUrl, { ...auth });
    expect(url).toMatch(/^https?:\/\//);
  });

  it("returns no image url for an entry logged without a photo", async () => {
    const t = withConvex();
    const entryId = await t.mutation(api.diet.createEntry, { ...auth, date: "2025-06-10" });
    expect(await t.query(api.diet.imageUrl, { ...auth, entryId })).toBeNull();
  });

  it("returns the stored image url for an entry logged with a photo", async () => {
    const t = withConvex();
    const imageId = await t.run(async (ctx) => ctx.storage.store(new Blob(["fake-jpeg"])));
    const entryId = await t.mutation(api.diet.createEntry, { ...auth, date: "2025-06-10", imageId });
    expect(await t.query(api.diet.imageUrl, { ...auth, entryId })).toContain("/api/storage/");
  });

  it("drops the row it is asked to remove", async () => {
    const t = withConvex();
    const id = await seedEntry(t, "2025-06-10", 1);
    await t.mutation(api.diet.remove, { ...auth, entryId: id });
    expect(await t.run(async (ctx) => ctx.db.get(id))).toBeNull();
  });
});

describe("one day's entries", () => {
  it("returns the most recently logged entry first", async () => {
    const t = withConvex();
    await seedEntry(t, "2025-06-10", 100, { name: "breakfast" });
    await seedEntry(t, "2025-06-10", 300, { name: "dinner" });
    await seedEntry(t, "2025-06-10", 200, { name: "lunch" });
    const res = await t.query(api.diet.listByDate, { ...auth, date: "2025-06-10" });
    expect(res.entries.map((e) => e.name)).toEqual(["dinner", "lunch", "breakfast"]);
  });

  it("returns zero totals and no entries for a day nothing was logged on", async () => {
    const t = withConvex();
    await seedEntry(t, "2025-06-10", 100, { kcal: 500 });
    const res = await t.query(api.diet.listByDate, { ...auth, date: "2025-06-11" });
    expect(res).toEqual({ entries: [], totals: { kcal: 0, protein: 0, carbs: 0, fat: 0 } });
  });

  it("excludes the adjacent days on both sides of the requested one", async () => {
    const t = withConvex();
    await seedEntry(t, "2025-06-09", 100, { kcal: 111 });
    await seedEntry(t, "2025-06-10", 200, { kcal: 222 });
    await seedEntry(t, "2025-06-11", 300, { kcal: 333 });
    const res = await t.query(api.diet.listByDate, { ...auth, date: "2025-06-10" });
    expect(res.totals.kcal).toBe(222);
    expect(res.entries).toHaveLength(1);
  });

  it("sums the macros of every entry on the day", async () => {
    const t = withConvex();
    await seedEntry(t, "2025-06-10", 100, { kcal: 500, protein: 30, carbs: 40, fat: 10 });
    await seedEntry(t, "2025-06-10", 200, { kcal: 250, protein: 5, carbs: 60, fat: 2 });
    const res = await t.query(api.diet.listByDate, { ...auth, date: "2025-06-10" });
    expect(res.totals).toEqual({ kcal: 750, protein: 35, carbs: 100, fat: 12 });
  });

  it("answers an unpadded day key with the padded day's entries", async () => {
    const t = withConvex();
    await seedEntry(t, "2025-01-09", 100, { kcal: 500 });
    const res = await t.query(api.diet.listByDate, { ...auth, date: "2025-1-9" });
    expect(res.entries).toHaveLength(1);
    expect(res.totals.kcal).toBe(500);
  });

  it("counts an entry still waiting for analysis as zero rather than skipping it", async () => {
    const t = withConvex();
    await seedEntry(t, "2025-06-10", 100, { kcal: 500, protein: 30, carbs: 40, fat: 10 });
    await seedEntry(t, "2025-06-10", 200, { status: "pending" });
    const res = await t.query(api.diet.listByDate, { ...auth, date: "2025-06-10" });
    expect(res.entries).toHaveLength(2);
    expect(res.totals.kcal).toBe(500);
  });
});

describe("daily totals over a range", () => {
  it("includes both endpoints of the range", async () => {
    const t = withConvex();
    await seedEntry(t, "2025-06-09", 1, { kcal: 1 });
    await seedEntry(t, "2025-06-10", 2, { kcal: 10 });
    await seedEntry(t, "2025-06-11", 3, { kcal: 100 });
    await seedEntry(t, "2025-06-12", 4, { kcal: 1000 });
    const res = await t.query(api.diet.dailyTotals, { ...auth, from: "2025-06-10", to: "2025-06-11" });
    expect(res.map((d) => [d.date, d.kcal])).toEqual([
      ["2025-06-10", 10],
      ["2025-06-11", 100],
    ]);
  });

  it("returns a single day when the range collapses to one date", async () => {
    const t = withConvex();
    await seedEntry(t, "2025-06-10", 1, { kcal: 10 });
    const res = await t.query(api.diet.dailyTotals, { ...auth, from: "2025-06-10", to: "2025-06-10" });
    expect(res).toEqual([{ date: "2025-06-10", kcal: 10, protein: 0, carbs: 0, fat: 0 }]);
  });

  it("omits days with no entries instead of filling them with zeroes", async () => {
    const t = withConvex();
    await seedEntry(t, "2025-06-10", 1, { kcal: 10 });
    await seedEntry(t, "2025-06-13", 2, { kcal: 20 });
    const res = await t.query(api.diet.dailyTotals, { ...auth, from: "2025-06-10", to: "2025-06-13" });
    expect(res.map((d) => d.date)).toEqual(["2025-06-10", "2025-06-13"]);
  });

  it("crosses a month boundary in ascending date order", async () => {
    const t = withConvex();
    await seedEntry(t, "2025-02-01", 2, { kcal: 20 });
    await seedEntry(t, "2025-01-31", 1, { kcal: 10 });
    const res = await t.query(api.diet.dailyTotals, { ...auth, from: "2025-01-31", to: "2025-02-01" });
    expect(res.map((d) => d.date)).toEqual(["2025-01-31", "2025-02-01"]);
  });

  it("includes 29 February when the range spans a leap day", async () => {
    const t = withConvex();
    await seedEntry(t, "2024-02-29", 1, { kcal: 42 });
    const res = await t.query(api.diet.dailyTotals, { ...auth, from: "2024-02-28", to: "2024-03-01" });
    expect(res).toEqual([{ date: "2024-02-29", kcal: 42, protein: 0, carbs: 0, fat: 0 }]);
  });

  it("aggregates several entries logged on the same day into one bucket", async () => {
    const t = withConvex();
    await seedEntry(t, "2025-06-10", 1, { kcal: 100, protein: 10 });
    await seedEntry(t, "2025-06-10", 2, { kcal: 200, protein: 20 });
    const res = await t.query(api.diet.dailyTotals, { ...auth, from: "2025-06-10", to: "2025-06-10" });
    expect(res).toEqual([{ date: "2025-06-10", kcal: 300, protein: 30, carbs: 0, fat: 0 }]);
  });

  it("finds an entry logged with an unpadded day key inside a zero-padded month range", async () => {
    const t = withConvex();
    // The range is a string comparison on the index, so an unpadded "2025-1-9"
    // would sort after "2025-01-31"; createEntry pads it into the same bucket
    // as the entry logged with the padded key.
    const unpadded = await t.mutation(api.diet.createEntry, { ...auth, date: "2025-1-9" });
    await t.mutation(api.diet.setAnalysis, { ...auth, entryId: unpadded, kcal: 10 });
    const padded = await t.mutation(api.diet.createEntry, { ...auth, date: "2025-01-09" });
    await t.mutation(api.diet.setAnalysis, { ...auth, entryId: padded, kcal: 20 });
    const res = await t.query(api.diet.dailyTotals, { ...auth, from: "2025-01-01", to: "2025-01-31" });
    expect(res).toEqual([{ date: "2025-01-09", kcal: 30, protein: 0, carbs: 0, fat: 0 }]);
  });

  it("matches a range asked for with unpadded endpoints", async () => {
    const t = withConvex();
    await seedEntry(t, "2025-01-09", 1, { kcal: 10 });
    const res = await t.query(api.diet.dailyTotals, { ...auth, from: "2025-1-1", to: "2025-1-31" });
    expect(res.map((d) => d.date)).toEqual(["2025-01-09"]);
  });

  it("returns nothing when the range runs backwards", async () => {
    const t = withConvex();
    await seedEntry(t, "2025-06-10", 1, { kcal: 10 });
    const res = await t.query(api.diet.dailyTotals, { ...auth, from: "2025-06-11", to: "2025-06-09" });
    expect(res).toEqual([]);
  });

  it("returns an empty series when nothing has been logged at all", async () => {
    const t = withConvex();
    const res = await t.query(api.diet.dailyTotals, { ...auth, from: "2025-06-01", to: "2025-06-30" });
    expect(res).toEqual([]);
  });
});

describe("worker analysis pipeline", () => {
  it("offers only the entries still waiting for analysis", async () => {
    const t = withConvex();
    await seedEntry(t, "2025-06-10", 1, { status: "pending", name: "waiting" });
    await seedEntry(t, "2025-06-10", 2, { status: "analyzing", name: "in flight" });
    await seedEntry(t, "2025-06-10", 3, { status: "done", name: "finished" });
    const pending = await t.query(api.diet.getPending, { ...auth });
    expect(pending.map((e) => e.name)).toEqual(["waiting"]);
  });

  it("lets exactly one worker claim an entry", async () => {
    const t = withConvex();
    const entryId = await seedEntry(t, "2025-06-10", 1, { status: "pending" });
    expect(await t.mutation(api.diet.claimEntry, { ...auth, entryId, provider: "gemini" })).toBe(true);
    expect(await t.mutation(api.diet.claimEntry, { ...auth, entryId, provider: "codex" })).toBe(false);
    const row = await t.run(async (ctx) => ctx.db.get(entryId));
    expect(row).toMatchObject({ status: "analyzing", provider: "gemini" });
  });

  it("refuses to claim an entry that already finished", async () => {
    const t = withConvex();
    const entryId = await seedEntry(t, "2025-06-10", 1, { status: "done" });
    expect(await t.mutation(api.diet.claimEntry, { ...auth, entryId })).toBe(false);
  });

  it("marks an analyzed entry done without moving it to another day", async () => {
    const t = withConvex();
    const entryId = await seedEntry(t, "2025-06-10", 1, { status: "analyzing", name: "unknown" });
    await t.mutation(api.diet.setAnalysis, {
      ...auth,
      entryId,
      name: "bibimbap",
      kcal: 620,
      protein: 22,
      carbs: 85,
      fat: 18,
    });
    const row = await t.run(async (ctx) => ctx.db.get(entryId));
    expect(row).toMatchObject({ status: "done", name: "bibimbap", kcal: 620, date: "2025-06-10" });
  });

  it("counts a newly analyzed entry into its day's totals", async () => {
    const t = withConvex();
    const entryId = await seedEntry(t, "2025-06-10", 1, { status: "pending" });
    await t.mutation(api.diet.setAnalysis, { ...auth, entryId, kcal: 300, protein: 10 });
    const res = await t.query(api.diet.listByDate, { ...auth, date: "2025-06-10" });
    expect(res.totals).toEqual({ kcal: 300, protein: 10, carbs: 0, fat: 0 });
  });

  it("records a failure without clearing the day it was logged on", async () => {
    const t = withConvex();
    const entryId = await seedEntry(t, "2025-06-10", 1, { status: "analyzing" });
    await t.mutation(api.diet.recordError, { ...auth, entryId, error: "no photo" });
    const row = await t.run(async (ctx) => ctx.db.get(entryId));
    expect(row).toMatchObject({ status: "error", error: "no photo", date: "2025-06-10" });
    expect(await t.query(api.diet.getPending, { ...auth })).toEqual([]);
  });
});
