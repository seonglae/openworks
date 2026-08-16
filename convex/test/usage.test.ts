import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import { isDevHost } from "../usage";
import { auth, withConvex } from "./harness.setup";

type Harness = ReturnType<typeof withConvex>;

// Relative to the real clock, because `overview` and `purge` both answer
// "within the last N days" and a fixed 2023 constant falls outside every
// window they are ever asked about.
const NOW = Date.now();
const DAY = 86_400_000;

function flush(
  t: Harness,
  over: {
    sessionId?: string;
    visitorId?: string;
    tab?: string;
    activeMs?: number;
    host?: string;
    events?: { type: string; ts: number; tab: string; target?: string }[];
  } = {},
) {
  const tab = over.tab ?? "research";
  return t.mutation(api.usage.ingest, {
    sessionId: over.sessionId ?? "s1",
    visitorId: over.visitorId ?? "v1",
    tab,
    activeMs: over.activeMs ?? 60_000,
    host: over.host ?? "openworks.example",
    events: over.events ?? [{ type: "pageview", ts: NOW, tab }],
    ...auth,
  });
}

describe("usage ingest", () => {
  it("keeps one row per view per browser tab, not one per flush", async () => {
    const t = withConvex();
    await flush(t, { activeMs: 30_000 });
    await flush(t, { activeMs: 90_000 });
    const rows = await t.run(async (ctx) => await ctx.db.query("usageSessions").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].eventCount).toBe(2);
  });

  // A retry or a reordered flush carrying a smaller total must not walk the
  // engaged time backwards.
  it("never lowers the engaged time it already has", async () => {
    const t = withConvex();
    await flush(t, { activeMs: 90_000 });
    await flush(t, { activeMs: 10_000 });
    const rows = await t.run(async (ctx) => await ctx.db.query("usageSessions").collect());
    expect(rows[0].activeMs).toBe(90_000);
  });

  it("separates two views inside one browser tab", async () => {
    const t = withConvex();
    await flush(t, { tab: "research" });
    await flush(t, { tab: "vocab" });
    const rows = await t.run(async (ctx) => await ctx.db.query("usageSessions").collect());
    expect(rows.map((r) => r.tab).sort()).toEqual(["research", "vocab"]);
  });

  // Ordering the journey is the whole point of the stream, and a client that
  // retries out of order would otherwise make it unorderable.
  it("assigns sequence numbers server-side, continuing across flushes", async () => {
    const t = withConvex();
    await flush(t, { events: [{ type: "pageview", ts: NOW, tab: "research" }] });
    await flush(t, {
      events: [
        { type: "click", ts: NOW + 1, tab: "research" },
        { type: "click", ts: NOW + 2, tab: "research" },
      ],
    });
    const seqs = await t.run(async (ctx) => {
      const rows = await ctx.db.query("usageEvents").collect();
      return rows.map((r) => r.seq).sort((a, b) => a - b);
    });
    expect(seqs).toEqual([0, 1, 2]);
  });

  it("refuses a batch with no session or view to attach it to", async () => {
    const t = withConvex();
    const r = await t.mutation(api.usage.ingest, {
      sessionId: "  ",
      visitorId: "v1",
      tab: "research",
      events: [{ type: "pageview", ts: NOW, tab: "research" }],
      ...auth,
    });
    expect(r.accepted).toBe(0);
    expect(await t.run(async (ctx) => await ctx.db.query("usageEvents").collect())).toHaveLength(0);
  });
});

describe("usage overview", () => {
  it("adds up engaged time per view, heaviest first", async () => {
    const t = withConvex();
    await flush(t, { sessionId: "a", tab: "research", activeMs: 120_000 });
    await flush(t, { sessionId: "b", tab: "vocab", activeMs: 30_000 });
    await flush(t, { sessionId: "c", tab: "research", activeMs: 60_000 });
    const o = await t.query(api.usage.overview, { days: 30, ...auth });
    expect(o.tabs[0]).toMatchObject({ tab: "research", activeMs: 180_000, visits: 2 });
    expect(o.tabs[1]).toMatchObject({ tab: "vocab", activeMs: 30_000 });
    expect(o.totals.activeMs).toBe(210_000);
  });

  // A dev server is you building the tool, not using it. Excluded when read
  // rather than dropped when written, so changing your mind re-scores history.
  it("leaves localhost out by default and can put it back", async () => {
    const t = withConvex();
    await flush(t, { sessionId: "a", host: "openworks.example", activeMs: 60_000 });
    await flush(t, { sessionId: "b", host: "localhost:6001", activeMs: 600_000 });
    const clean = await t.query(api.usage.overview, { days: 30, ...auth });
    expect(clean.totals.visits).toBe(1);
    expect(clean.totals.activeMs).toBe(60_000);
    expect(clean.devCount).toBe(1);
    const all = await t.query(api.usage.overview, { days: 30, includeDev: true, ...auth });
    expect(all.totals.visits).toBe(2);
  });

  it("counts distinct browsers, not visits", async () => {
    const t = withConvex();
    await flush(t, { sessionId: "a", visitorId: "v1" });
    await flush(t, { sessionId: "b", visitorId: "v1" });
    await flush(t, { sessionId: "c", visitorId: "v2" });
    const o = await t.query(api.usage.overview, { days: 30, ...auth });
    expect(o.totals.visits).toBe(3);
    expect(o.totals.browsers).toBe(2);
  });

  it("ignores visits older than the window", async () => {
    const t = withConvex();
    await flush(t, { sessionId: "old" });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("usageSessions").first();
      if (row) await ctx.db.patch(row._id, { startedAt: Date.now() - 60 * DAY });
    });
    expect((await t.query(api.usage.overview, { days: 7, ...auth })).totals.visits).toBe(0);
  });
});

describe("usage flow", () => {
  it("reads the moves between views out of the pageview order", async () => {
    const t = withConvex();
    await flush(t, {
      sessionId: "s1",
      tab: "newsletter",
      events: [
        { type: "pageview", ts: NOW, tab: "newsletter" },
        { type: "pageview", ts: NOW + 1, tab: "paper" },
        { type: "pageview", ts: NOW + 2, tab: "research" },
      ],
    });
    const f = await t.query(api.usage.flow, { days: 30, ...auth });
    expect(f.edges).toEqual(
      expect.arrayContaining([
        { from: "newsletter", to: "paper", count: 1 },
        { from: "paper", to: "research", count: 1 },
      ]),
    );
    expect(f.firstTabs[0]).toEqual({ tab: "newsletter", count: 1 });
  });

  // A reload emits a pageview for the view you are already on. Counting it as
  // a move invents a research → research edge that no one ever made.
  it("does not count a reload as a move", async () => {
    const t = withConvex();
    await flush(t, {
      sessionId: "s1",
      tab: "research",
      events: [
        { type: "pageview", ts: NOW, tab: "research" },
        { type: "pageview", ts: NOW + 1, tab: "research" },
      ],
    });
    expect((await t.query(api.usage.flow, { days: 30, ...auth })).edges).toEqual([]);
  });

  it("does not join one browser tab's journey to another's", async () => {
    const t = withConvex();
    await flush(t, { sessionId: "s1", tab: "vocab", events: [{ type: "pageview", ts: NOW, tab: "vocab" }] });
    await flush(t, { sessionId: "s2", tab: "diet", events: [{ type: "pageview", ts: NOW + 1, tab: "diet" }] });
    const f = await t.query(api.usage.flow, { days: 30, ...auth });
    expect(f.edges).toEqual([]);
    expect(f.entries).toBe(2);
  });
});

describe("retention", () => {
  it("drops what is older than the cutoff and keeps the rest", async () => {
    const t = withConvex();
    await flush(t, { sessionId: "old" });
    await t.run(async (ctx) => {
      for (const s of await ctx.db.query("usageSessions").collect()) {
        await ctx.db.patch(s._id, { startedAt: Date.now() - 400 * DAY });
      }
      for (const e of await ctx.db.query("usageEvents").collect()) {
        await ctx.db.patch(e._id, { ts: Date.now() - 400 * DAY });
      }
    });
    await flush(t, { sessionId: "new" });
    const r = await t.mutation(api.usage.purge, { days: 90, ...auth });
    expect(r).toMatchObject({ sessions: 1, events: 1, done: true });
    const left = await t.run(async (ctx) => await ctx.db.query("usageSessions").collect());
    expect(left.map((s) => s.sessionId)).toEqual(["new"]);
  });
});

describe("dev host detection", () => {
  it("knows a dev server from a deployment", () => {
    for (const host of ["localhost:6001", "127.0.0.1:5173", "[::1]:8080", "mac.local:3000"]) {
      expect(isDevHost(host)).toBe(true);
    }
    for (const host of ["openworks.example", "app.openworks.example", undefined]) {
      expect(isDevHost(host)).toBe(false);
    }
  });
});
