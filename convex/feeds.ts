import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireOwner } from "./auth";
import type { ActionCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

// Max items registered per feed per poll, so a busy or freshly-parsed feed
// can't flood the jobs queue.
const MAX_PER_POLL = 6;
// Max items registered on a backfill (register-everything-now) subscribe.
const BACKFILL_CAP = 25;
// How many recent item ids to remember per feed for dedupe.
const SEEN_CAP = 120;

// --- helpers (not Convex functions) ---

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&amp;/g, "&");
}

// Strip tracking params (utm_*, ref, source, mc_*, ck_subscriber_id, ...) while
// keeping content-essential params.
function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const drop = ["ref", "source", "mc_cid", "mc_eid", "ck_subscriber_id", "r", "s"];
    for (const k of [...u.searchParams.keys()]) {
      if (k.toLowerCase().startsWith("utm_") || drop.includes(k.toLowerCase())) u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return raw.trim();
  }
}

function deriveTitle(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Parse RSS <item> and Atom <entry> blocks into {title, link, id}. `id` is the
// feed's stable identifier for the item (RSS <guid> / Atom <id>) when present,
// falling back to the link, so dedupe survives URL tracking-param churn.
function parseFeed(xml: string): { title: string; link: string; id: string }[] {
  const out: { title: string; link: string; id: string }[] = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  for (const b of blocks) {
    const titleM = b.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleM ? decodeEntities(stripCdata(titleM[1])) : "(untitled)";
    let link = "";
    const rssLink = b.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
    if (rssLink && rssLink[1].trim()) link = stripCdata(rssLink[1]).trim();
    if (!link) {
      const atom =
        b.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) ??
        b.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']alternate["']/i) ??
        b.match(/<link\b[^>]*href=["']([^"']+)["']/i);
      if (atom) link = atom[1];
    }
    const guidM = b.match(/<(guid|id)\b[^>]*>([\s\S]*?)<\/\1>/i);
    const guid = guidM ? decodeEntities(stripCdata(guidM[2])).trim() : "";
    if (!link && /^https?:\/\//.test(guid)) link = guid;
    link = cleanUrl(decodeEntities(link.trim()));
    if (link) out.push({ title: title || "(untitled)", link, id: guid || link });
  }
  return out;
}

// Fetch + parse one feed and register new items as article jobs. Returns how
// many jobs it created. The first ever poll of a feed only SEEDS the seen-set
// (no backfill flood); subsequent polls register genuinely new items.
async function pollOne(ctx: ActionCtx, feed: Doc<"feeds">): Promise<number> {
  const res = await fetch(feed.url, {
    headers: { "user-agent": "OpenworksFeedBot/1.0 (+https://github.com/seonglae/openworks)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const items = parseFeed(xml).slice(0, 50);
  const seen = new Set(feed.seenLinks ?? []);
  const firstPoll = feed.lastPolledAt == null;

  // First poll: backfill everything (capped) when the user opted in, otherwise
  // just seed the seen-set so only future items register. Later polls register
  // genuinely-new items (id not seen), capped.
  let toCreate: { title: string; link: string; id: string }[];
  if (firstPoll && feed.pendingBackfill) toCreate = items.slice(0, BACKFILL_CAP);
  else if (firstPoll) toCreate = [];
  else toCreate = items.filter((it) => !seen.has(it.id)).slice(0, MAX_PER_POLL);

  for (const it of toCreate) {
    await ctx.runMutation(internal.feeds.ingestItem, { link: it.link, title: it.title, source: feed.title });
  }
  const newSeen = [...items.map((i) => i.id), ...(feed.seenLinks ?? [])].slice(0, SEEN_CAP);
  await ctx.runMutation(internal.feeds.recordPoll, {
    feedId: feed._id,
    seenLinks: newSeen,
    itemCount: items.length,
    clearBackfill: feed.pendingBackfill === true,
  });
  return toCreate.length;
}

// --- public (owner-gated) CRUD ---

export const list = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.db.query("feeds").withIndex("by_createdAt").order("desc").collect();
  },
});

export const add = mutation({
  args: {
    url: v.string(),
    title: v.optional(v.string()),
    // true = register every current item now (backfill); false/omitted = only
    // register items that appear after subscribing.
    backfill: v.optional(v.boolean()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const url = args.url.trim();
    if (!/^https?:\/\//.test(url)) throw new Error("feed url must start with http(s)://");
    const existing = await ctx.db
      .query("feeds")
      .withIndex("by_createdAt")
      .collect()
      .then((all) => all.find((f) => f.url === url));
    if (existing) return existing._id;
    return await ctx.db.insert("feeds", {
      url,
      title: (args.title ?? "").trim() || deriveTitle(url),
      enabled: true,
      ...(args.backfill ? { pendingBackfill: true } : {}),
      createdAt: Date.now(),
    });
  },
});

export const setEnabled = mutation({
  args: { id: v.id("feeds"), enabled: v.boolean(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.id, { enabled: args.enabled });
  },
});

export const rename = mutation({
  args: { id: v.id("feeds"), title: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.id, { title: args.title.trim() || deriveTitle((await ctx.db.get(args.id))?.url ?? "") });
  },
});

export const remove = mutation({
  args: { id: v.id("feeds"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.delete(args.id);
  },
});

// Manual trigger from the UI: poll every enabled feed now.
export const pollNow = action({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ feeds: number; created: number; errors: number }> => {
    await requireOwner(ctx, args.serviceKey);
    return await ctx.runAction(internal.feeds.pollAll, {});
  },
});

// --- internal (cron / action plumbing) ---

export const listEnabled = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("feeds")
      .withIndex("by_enabled", (q) => q.eq("enabled", true))
      .collect();
  },
});

export const ingestItem = internalMutation({
  args: { link: v.string(), title: v.string(), source: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await ctx.db.insert("jobs", {
      url: args.link,
      title: args.title,
      ...(args.source ? { source: args.source } : {}),
      type: "article",
      archived: false,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const recordPoll = internalMutation({
  args: {
    feedId: v.id("feeds"),
    seenLinks: v.optional(v.array(v.string())),
    itemCount: v.optional(v.number()),
    error: v.optional(v.string()),
    clearBackfill: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.feedId, {
      lastPolledAt: Date.now(),
      lastError: args.error,
      ...(args.seenLinks ? { seenLinks: args.seenLinks } : {}),
      ...(args.itemCount != null ? { itemCount: args.itemCount } : {}),
      ...(args.clearBackfill ? { pendingBackfill: false } : {}),
    });
  },
});

// Cron entry point: poll every enabled feed, registering new items as article
// jobs. Per-feed failures are recorded and skipped, never aborting the batch.
export const pollAll = internalAction({
  args: {},
  handler: async (ctx): Promise<{ feeds: number; created: number; errors: number }> => {
    const feeds = await ctx.runQuery(internal.feeds.listEnabled, {});
    let created = 0;
    let errors = 0;
    for (const f of feeds) {
      try {
        created += await pollOne(ctx, f);
      } catch (e) {
        errors++;
        await ctx.runMutation(internal.feeds.recordPoll, {
          feedId: f._id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { feeds: feeds.length, created, errors };
  },
});
