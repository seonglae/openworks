import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwner } from "./auth";

// First-party usage: which views get used, for how long, and in what order.
//
// A generic event envelope with an ordered stream, a per-visit rollup so the
// common questions do not replay that stream, and exclusion applied when
// reading rather than when writing. What is deliberately absent is anything about visitors: this
// is a self-hosted tool with one operator, so there is no geo, no IP, no
// referrer and no cross-site anything to collect. The only "who" it keeps is a
// local id that distinguishes this browser from another one of yours.

// A batch bigger than this is a bug or a loop, not a session.
const MAX_EVENTS_PER_CALL = 200;
const MAX_STRING = 200;
// Reading the whole corpus to draw one chart is how a dashboard becomes the
// most expensive page in the app.
const MAX_SESSIONS = 2000;
const MAX_EVENTS = 5000;
// A tab left open over lunch reports a gap, not a visit. The tracker only
// counts time it saw activity in, and this is the ceiling on any single event
// gap it will credit.
const MAX_GAP_MS = 5 * 60_000;

const eventValidator = v.object({
  type: v.string(),
  ts: v.number(),
  tab: v.string(),
  target: v.optional(v.string()),
  value: v.optional(v.union(v.number(), v.string())),
  meta: v.optional(v.any()),
});

function clip(value: unknown, max = MAX_STRING): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

// A dev server is you building the tool, not you using it. Kept out of the
// default view and recoverable with a flag, because the judgement of what
// counts changes and history should re-score when it does.
export function isDevHost(host?: string): boolean {
  if (!host) return false;
  // A host carries its port, so matching the suffix directly misses
  // `mac.local:3000`, the common Bonjour case when a phone tests against a
  // laptop. The bracketed IPv6 form has to be unwrapped rather than
  // port-stripped: `::1` ends in `:1`, so a port regex eats the address.
  const lower = host.toLowerCase();
  const bracketed = /^\[([^\]]+)\]/.exec(lower);
  const h = bracketed ? bracketed[1] : lower.replace(/:\d+$/, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".local");
}

/**
 * One flush from one browser tab. `activeMs` is the running total for this
 * (session, tab) pair rather than a delta, so a flush that never lands costs
 * only the time since the previous one instead of corrupting the count.
 */
export const ingest = mutation({
  args: {
    sessionId: v.string(),
    visitorId: v.string(),
    tab: v.string(),
    activeMs: v.optional(v.number()),
    device: v.optional(v.string()),
    viewport: v.optional(v.string()),
    host: v.optional(v.string()),
    events: v.array(eventValidator),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);

    const sessionId = clip(args.sessionId, 64);
    const visitorId = clip(args.visitorId, 64);
    const tab = clip(args.tab, 40);
    if (!sessionId || !visitorId || !tab) return { accepted: 0 };

    const events = args.events.slice(0, MAX_EVENTS_PER_CALL);
    const now = Date.now();

    const existing = await ctx.db
      .query("usageSessions")
      .withIndex("by_session_tab", (q) => q.eq("sessionId", sessionId).eq("tab", tab))
      .unique();

    // Sequence numbers continue from what is already stored, so two flushes
    // racing cannot both claim seq 0 and make the journey unorderable.
    const last = await ctx.db
      .query("usageEvents")
      .withIndex("by_session_seq", (q) => q.eq("sessionId", sessionId))
      .order("desc")
      .first();
    let seq = (last?.seq ?? -1) + 1;

    for (const e of events) {
      const type = clip(e.type, 40);
      if (!type) continue;
      await ctx.db.insert("usageEvents", {
        sessionId,
        tab: clip(e.tab, 40) ?? tab,
        seq: seq++,
        ts: Number.isFinite(e.ts) ? e.ts : now,
        type,
        target: clip(e.target),
        value: typeof e.value === "string" ? clip(e.value) : e.value,
        meta: e.meta,
      });
    }

    // Monotonic: a late flush carrying a smaller total must not walk the time
    // backwards, which is what an out-of-order retry would otherwise do.
    const activeMs = Math.max(existing?.activeMs ?? 0, Math.max(0, args.activeMs ?? 0));
    if (existing) {
      await ctx.db.patch(existing._id, {
        lastAt: now,
        activeMs,
        eventCount: existing.eventCount + events.length,
      });
    } else {
      await ctx.db.insert("usageSessions", {
        sessionId,
        visitorId,
        tab,
        startedAt: events[0]?.ts ?? now,
        lastAt: now,
        activeMs,
        eventCount: events.length,
        device: clip(args.device, 40),
        viewport: clip(args.viewport, 20),
        host: clip(args.host, 80),
      });
    }
    return { accepted: events.length };
  },
});

const since = (days: number) => Date.now() - Math.max(1, days) * 86_400_000;

/**
 * Everything the dashboard draws from, in one read. Per-tab and per-day
 * rollups are computed here because they need the whole window; the session
 * list comes back raw so the page can resolve any bar back to the visits under
 * it without a second round trip.
 */
export const overview = query({
  args: { days: v.number(), includeDev: v.optional(v.boolean()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const from = since(args.days);

    const all = await ctx.db
      .query("usageSessions")
      .withIndex("by_startedAt", (q) => q.gte("startedAt", from))
      .order("desc")
      .take(MAX_SESSIONS);

    const devCount = all.filter((s) => isDevHost(s.host)).length;
    const sessions = args.includeDev ? all : all.filter((s) => !isDevHost(s.host));

    const byTab = new Map<string, { tab: string; visits: number; activeMs: number; events: number; lastAt: number }>();
    for (const s of sessions) {
      const row = byTab.get(s.tab) ?? { tab: s.tab, visits: 0, activeMs: 0, events: 0, lastAt: 0 };
      row.visits += 1;
      row.activeMs += s.activeMs;
      row.events += s.eventCount;
      row.lastAt = Math.max(row.lastAt, s.lastAt);
      byTab.set(s.tab, row);
    }

    // Bucketed by UTC day. The browser regroups into its own calendar day if
    // it needs to; the backend has no business guessing the operator's zone.
    const byDay = new Map<string, { day: string; activeMs: number; visits: number }>();
    for (const s of sessions) {
      const day = new Date(s.startedAt).toISOString().slice(0, 10);
      const row = byDay.get(day) ?? { day, activeMs: 0, visits: 0 };
      row.activeMs += s.activeMs;
      row.visits += 1;
      byDay.set(day, row);
    }

    return {
      from,
      truncated: all.length === MAX_SESSIONS,
      devCount,
      totals: {
        visits: sessions.length,
        activeMs: sessions.reduce((n, s) => n + s.activeMs, 0),
        events: sessions.reduce((n, s) => n + s.eventCount, 0),
        tabs: byTab.size,
        browsers: new Set(sessions.map((s) => s.visitorId)).size,
      },
      tabs: [...byTab.values()].sort((a, b) => b.activeMs - a.activeMs || b.visits - a.visits),
      days: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
      sessions: sessions.slice(0, 200).map((s) => ({
        sessionId: s.sessionId,
        tab: s.tab,
        startedAt: s.startedAt,
        lastAt: s.lastAt,
        activeMs: s.activeMs,
        eventCount: s.eventCount,
        device: s.device,
        dev: isDevHost(s.host),
      })),
    };
  },
});

/**
 * Where you go from where. Reconstructed from the pageview stream rather than
 * stored as transitions, because a transition is only knowable in hindsight
 * and storing it would mean writing the previous row again on every move.
 */
export const flow = query({
  args: { days: v.number(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const from = since(args.days);

    const views = await ctx.db
      .query("usageEvents")
      .withIndex("by_type_ts", (q) => q.eq("type", "pageview").gte("ts", from))
      .order("desc")
      .take(MAX_EVENTS);

    const bySession = new Map<string, typeof views>();
    for (const e of views) {
      const list = bySession.get(e.sessionId);
      if (list) list.push(e);
      else bySession.set(e.sessionId, [e]);
    }

    const edges = new Map<string, { from: string; to: string; count: number }>();
    let entries = 0;
    const firstTab = new Map<string, number>();
    for (const list of bySession.values()) {
      const ordered = [...list].sort((a, b) => a.seq - b.seq);
      if (ordered.length > 0) {
        entries += 1;
        firstTab.set(ordered[0].tab, (firstTab.get(ordered[0].tab) ?? 0) + 1);
      }
      for (let i = 1; i < ordered.length; i++) {
        const a = ordered[i - 1].tab;
        const b = ordered[i].tab;
        // A reload is not a move.
        if (a === b) continue;
        const key = `${a} ${b}`;
        const edge = edges.get(key) ?? { from: a, to: b, count: 0 };
        edge.count += 1;
        edges.set(key, edge);
      }
    }

    return {
      truncated: views.length === MAX_EVENTS,
      entries,
      firstTabs: [...firstTab.entries()].map(([tab, count]) => ({ tab, count })).sort((a, b) => b.count - a.count),
      edges: [...edges.values()].sort((a, b) => b.count - a.count).slice(0, 40),
    };
  },
});

/**
 * Drop everything older than `days`. Usage data answers "what did this month
 * look like", and nothing here gets better for being two years old, so the
 * table is not allowed to grow without a bound someone chose.
 */
export const purge = mutation({
  args: { days: v.number(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const cutoff = since(args.days);
    let sessions = 0;
    let events = 0;

    for (const s of await ctx.db
      .query("usageSessions")
      .withIndex("by_startedAt", (q) => q.lt("startedAt", cutoff))
      .take(500)) {
      await ctx.db.delete(s._id);
      sessions += 1;
    }
    for (const e of await ctx.db
      .query("usageEvents")
      .withIndex("by_ts", (q) => q.lt("ts", cutoff))
      .take(2000)) {
      await ctx.db.delete(e._id);
      events += 1;
    }
    // Bounded per call, so the caller repeats until both are zero rather than
    // one transaction trying to delete a year.
    return { sessions, events, done: sessions < 500 && events < 2000 };
  },
});

export { MAX_GAP_MS };
