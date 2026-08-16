import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { auth, withConvex } from "./harness.setup";

type ExpressionSeed = Partial<Omit<Doc<"expressions">, "_id" | "_creationTime">>;

// With no `today` from the caller the scheduler falls back to the server's UTC
// calendar day, so the fallback expectations have to be built the same way
// rather than from local time. "the caller's day" below covers the other side.
const isoDay = (offset = 0): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function seedExpression(t: ReturnType<typeof withConvex>, seed: ExpressionSeed = {}) {
  return await t.run(async (ctx) =>
    ctx.db.insert("expressions", {
      en: "seed phrase",
      due: isoDay(),
      intervalDays: 0,
      reps: 0,
      ease: 250,
      createdAt: 1,
      ...seed,
    }),
  );
}

async function readExpression(t: ReturnType<typeof withConvex>, id: Awaited<ReturnType<typeof seedExpression>>) {
  return await t.run(async (ctx) => ctx.db.get(id));
}

describe("capturing expressions", () => {
  it("starts an English-only phrase due on the server's day when the caller names none", async () => {
    const t = withConvex();
    // Bracket the handler's own clock read rather than taking a second one
    // after it: a UTC midnight landing between the two would otherwise turn
    // this red once a day.
    const before = isoDay();
    const id = await t.mutation(api.expressions.add, { ...auth, en: "bite the bullet" });
    const after = isoDay();
    const row = await readExpression(t, id);
    expect([before, after]).toContain(row?.due);
    expect(row).toMatchObject({ intervalDays: 0, reps: 0, ease: 250, pendingEnrich: true });
  });

  it("skips enrichment once either a translation or a meaning is supplied", async () => {
    const t = withConvex();
    const withJp = await t.mutation(api.expressions.add, { ...auth, en: "bite the bullet", jp: "歯を食いしばる" });
    const withMeaning = await t.mutation(api.expressions.add, { ...auth, en: "call it a day", meaning: "stop" });
    expect((await readExpression(t, withJp))?.pendingEnrich).toBe(false);
    expect((await readExpression(t, withMeaning))?.pendingEnrich).toBe(false);
  });

  it("still queues enrichment when only a reading or an example came in", async () => {
    const t = withConvex();
    const id = await t.mutation(api.expressions.add, { ...auth, en: "hit the sack", reading: "ヒット", example: "x" });
    expect((await readExpression(t, id))?.pendingEnrich).toBe(true);
  });

  it("keeps duplicates typed one at a time, because only the bulk import dedupes", async () => {
    const t = withConvex();
    await t.mutation(api.expressions.add, { ...auth, en: "bite the bullet" });
    await t.mutation(api.expressions.add, { ...auth, en: "bite the bullet" });
    expect((await t.query(api.expressions.list, { ...auth })).length).toBe(2);
  });
});

describe("bulk importing expressions", () => {
  it("drops blanks and case-insensitive repeats inside one import", async () => {
    const t = withConvex();
    const res = await t.mutation(api.expressions.addBatchEn, {
      ...auth,
      ens: ["Hit the sack", "hit the sack", "   ", "HIT THE SACK", "call it a day"],
    });
    expect(res).toEqual({ added: 2 });
    expect((await t.query(api.expressions.list, { ...auth })).map((e) => e.en)).toEqual([
      "call it a day",
      "Hit the sack",
    ]);
  });

  it("matches an existing row on its trimmed form, so padded entries are not re-added", async () => {
    const t = withConvex();
    await seedExpression(t, { en: "  Hit the sack  " });
    expect(await t.mutation(api.expressions.addBatchEn, { ...auth, ens: ["hit the sack"] })).toEqual({ added: 0 });
  });

  it("marks every imported phrase for enrichment", async () => {
    const t = withConvex();
    await t.mutation(api.expressions.addBatchEn, { ...auth, ens: ["hit the sack"] });
    const pending = await t.query(api.expressions.getPendingEnrich, { ...auth });
    expect(pending.map((e) => e.en)).toEqual(["hit the sack"]);
  });
});

describe("worker enrichment", () => {
  it("hands the worker only the rows still missing a translation", async () => {
    const t = withConvex();
    await t.mutation(api.expressions.add, { ...auth, en: "already done", jp: "済み" });
    await t.mutation(api.expressions.add, { ...auth, en: "needs work" });
    const pending = await t.query(api.expressions.getPendingEnrich, { ...auth });
    expect(pending.map((e) => e.en)).toEqual(["needs work"]);
  });

  it("takes a row out of the queue once enrichment lands", async () => {
    const t = withConvex();
    const id = await t.mutation(api.expressions.add, { ...auth, en: "hit the sack" });
    await t.mutation(api.expressions.setEnrichment, { ...auth, id, jp: "寝る", meaning: "go to bed" });
    expect(await t.query(api.expressions.getPendingEnrich, { ...auth })).toEqual([]);
    expect(await readExpression(t, id)).toMatchObject({ jp: "寝る", meaning: "go to bed", pendingEnrich: false });
  });

  it("leaves fields the second enrichment omitted untouched", async () => {
    const t = withConvex();
    const id = await t.mutation(api.expressions.add, { ...auth, en: "hit the sack" });
    await t.mutation(api.expressions.setEnrichment, { ...auth, id, jp: "寝る", meaning: "go to bed" });
    await t.mutation(api.expressions.setEnrichment, { ...auth, id, jp: "床につく" });
    expect(await readExpression(t, id)).toMatchObject({ jp: "床につく", meaning: "go to bed" });
  });
});

describe("listing and the review queue", () => {
  it("lists newest first regardless of the review schedule", async () => {
    const t = withConvex();
    await seedExpression(t, { en: "oldest", createdAt: 10 });
    await seedExpression(t, { en: "newest", createdAt: 30 });
    await seedExpression(t, { en: "middle", createdAt: 20 });
    const rows = await t.query(api.expressions.list, { ...auth });
    expect(rows.map((e) => e.en)).toEqual(["newest", "middle", "oldest"]);
  });

  it("serves overdue cards before today's and never a card scheduled ahead", async () => {
    const t = withConvex();
    await seedExpression(t, { en: "tomorrow", due: isoDay(1) });
    await seedExpression(t, { en: "today", due: isoDay() });
    await seedExpression(t, { en: "overdue", due: isoDay(-3) });
    const res = await t.query(api.expressions.due, { ...auth });
    expect(res.due.map((e) => e.en)).toEqual(["overdue", "today"]);
    expect(res).toMatchObject({ total: 3, dueCount: 2 });
  });
});

describe("grading a review", () => {
  it("schedules the first good review one day out", async () => {
    const t = withConvex();
    const id = await seedExpression(t);
    await t.mutation(api.expressions.review, { ...auth, id, grade: "good" });
    expect(await readExpression(t, id)).toMatchObject({ reps: 1, intervalDays: 1, ease: 250, due: isoDay(1) });
  });

  it("schedules the second good review three days out", async () => {
    const t = withConvex();
    const id = await seedExpression(t);
    await t.mutation(api.expressions.review, { ...auth, id, grade: "good" });
    await t.mutation(api.expressions.review, { ...auth, id, grade: "good" });
    expect(await readExpression(t, id)).toMatchObject({ reps: 2, intervalDays: 3, due: isoDay(3) });
  });

  it("compounds the interval by the ease factor from the third good review on", async () => {
    const t = withConvex();
    const id = await seedExpression(t);
    for (let i = 0; i < 3; i++) await t.mutation(api.expressions.review, { ...auth, id, grade: "good" });
    expect(await readExpression(t, id)).toMatchObject({ reps: 3, intervalDays: 8, due: isoDay(8) });
  });

  it("raises ease on an easy grade while the first interval stays fixed at one day", async () => {
    const t = withConvex();
    const id = await seedExpression(t);
    await t.mutation(api.expressions.review, { ...auth, id, grade: "easy" });
    expect(await readExpression(t, id)).toMatchObject({ reps: 1, intervalDays: 1, ease: 265 });
  });

  it("applies the easy bonus on top of the raised ease once the interval compounds", async () => {
    const t = withConvex();
    const id = await seedExpression(t);
    await t.mutation(api.expressions.review, { ...auth, id, grade: "good" });
    await t.mutation(api.expressions.review, { ...auth, id, grade: "good" });
    await t.mutation(api.expressions.review, { ...auth, id, grade: "easy" });
    expect(await readExpression(t, id)).toMatchObject({ reps: 3, ease: 265, intervalDays: 10, due: isoDay(10) });
  });

  it("resets the streak to tomorrow when the answer was forgotten", async () => {
    const t = withConvex();
    const id = await seedExpression(t, { intervalDays: 30, reps: 6 });
    await t.mutation(api.expressions.review, { ...auth, id, grade: "again" });
    expect(await readExpression(t, id)).toMatchObject({ reps: 0, intervalDays: 1, ease: 230, due: isoDay(1) });
  });

  it("stops lowering ease at the floor no matter how often a card is forgotten", async () => {
    const t = withConvex();
    const id = await seedExpression(t);
    for (let i = 0; i < 8; i++) await t.mutation(api.expressions.review, { ...auth, id, grade: "again" });
    expect((await readExpression(t, id))?.ease).toBe(130);
  });

  it("does nothing when the card was deleted between the draw and the grade", async () => {
    const t = withConvex();
    const id = await seedExpression(t);
    await t.mutation(api.expressions.remove, { ...auth, id });
    await expect(t.mutation(api.expressions.review, { ...auth, id, grade: "good" })).resolves.toBeNull();
  });

  it("rejects a grade outside again / good / easy", async () => {
    const t = withConvex();
    const id = await seedExpression(t);
    await expect(t.mutation(api.expressions.review, { ...auth, id, grade: "hard" as "good" })).rejects.toThrow(/hard/);
  });
});

// The server's UTC day is nine hours behind a Seoul user's, so the browser sends
// the day it is actually living in and the handlers schedule against that.
describe("the caller's day", () => {
  it("captures a new phrase on the day the caller named", async () => {
    const t = withConvex();
    const id = await t.mutation(api.expressions.add, { ...auth, en: "bite the bullet", today: "2026-03-09" });
    expect(await readExpression(t, id)).toMatchObject({ due: "2026-03-09" });
  });

  it("bulk imports onto the day the caller named", async () => {
    const t = withConvex();
    await t.mutation(api.expressions.addBatchEn, { ...auth, ens: ["hit the sack"], today: "2026-03-09" });
    expect((await t.query(api.expressions.list, { ...auth }))[0]).toMatchObject({ due: "2026-03-09" });
  });

  it("moves the review queue's cut-off with the day the caller named", async () => {
    const t = withConvex();
    await seedExpression(t, { en: "the ninth", due: "2026-03-09" });
    await seedExpression(t, { en: "the eighth", due: "2026-03-08" });
    const onTheEighth = await t.query(api.expressions.due, { ...auth, today: "2026-03-08" });
    const onTheNinth = await t.query(api.expressions.due, { ...auth, today: "2026-03-09" });
    expect(onTheEighth.due.map((e) => e.en)).toEqual(["the eighth"]);
    expect(onTheNinth.due.map((e) => e.en)).toEqual(["the eighth", "the ninth"]);
  });

  it("schedules the next review forward from the day the caller named", async () => {
    const t = withConvex();
    const id = await seedExpression(t);
    await t.mutation(api.expressions.review, { ...auth, id, grade: "good", today: "2026-03-09" });
    await t.mutation(api.expressions.review, { ...auth, id, grade: "good", today: "2026-03-10" });
    expect(await readExpression(t, id)).toMatchObject({ reps: 2, intervalDays: 3, due: "2026-03-13" });
  });

  it("falls back to the server's day for the worker and any other caller that names none", async () => {
    const t = withConvex();
    const id = await t.mutation(api.expressions.add, { ...auth, en: "bite the bullet" });
    await t.mutation(api.expressions.review, { ...auth, id, grade: "good" });
    expect(await readExpression(t, id)).toMatchObject({ due: isoDay(1) });
    expect((await t.query(api.expressions.due, { ...auth })).dueCount).toBe(0);
  });
});

describe("removing an expression", () => {
  it("takes the card out of both the list and the review queue", async () => {
    const t = withConvex();
    const id = await seedExpression(t, { due: isoDay(-1) });
    await t.mutation(api.expressions.remove, { ...auth, id });
    expect(await t.query(api.expressions.list, { ...auth })).toEqual([]);
    expect(await t.query(api.expressions.due, { ...auth })).toMatchObject({ total: 0, dueCount: 0 });
  });

  it("rejects an id that does not belong to the expressions table", async () => {
    const t = withConvex();
    await expect(t.mutation(api.expressions.remove, { ...auth, id: "not-an-id" as never })).rejects.toThrow();
  });
});
