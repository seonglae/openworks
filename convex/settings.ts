// Deployment-level singleton settings. No auth — self-hosted OSS, one
// deployment per user. UI calls `get` to render; mutations upsert the
// single "default" row.

import { v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { requireOwner } from "./auth";

const DEFAULT_SLUG = "default";

const TAB_KEYS = ["newsletter", "paper", "article", "pr", "research", "plan", "diet", "vocab", "insights"] as const;
type TabKey = (typeof TAB_KEYS)[number];

// Canonical default tab set (all tabs enabled). Any code path that seeds an
// appSettings row must use this so new tabs never get dropped on first write.
export function defaultTabs(): { key: TabKey; enabled: boolean }[] {
  return TAB_KEYS.map((key) => ({ key, enabled: true }));
}

// Typed ctx rather than `{ db: any }`: this row's shape is what `get` returns,
// so an `any` here erased the type of `settings.tabs` all the way out to the
// browser and cost about fifteen implicit-any errors in the UI.
async function getOrInit(ctx: QueryCtx) {
  const existing = await ctx.db
    .query("appSettings")
    .withIndex("by_slug", (q) => q.eq("slug", DEFAULT_SLUG))
    .first();
  return existing;
}

// Diagnostic: returns ONLY the calling identity (Clerk subject / email / name)
// so the owner can confirm what their JWT carries before locking the gate to an
// email or subject. Reveals nothing but the caller's own identity to themselves,
// so it is intentionally ungated. Accepts an optional serviceKey purely so the
// local dev client (which injects it everywhere) does not trip validation.
export const whoami = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    const ownerEmail = process.env.OPENWORKS_OWNER_EMAIL;
    const ownerId = process.env.OPENWORKS_OWNER_USER_ID;
    if (!identity) return { authenticated: false };
    const isOwner =
      (ownerEmail != null && identity.email === ownerEmail) || (ownerId != null && identity.subject === ownerId);
    // Only ever return the CALLER's own identity (never the configured owner
    // value), so this diagnostic leaks nothing about who the owner is.
    return {
      authenticated: true,
      subject: identity.subject,
      email: identity.email ?? null,
      name: identity.name ?? null,
      isOwner,
    };
  },
});

export const get = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const row = await getOrInit(ctx);
    if (row) {
      // Forward-compat: append any new tab keys that aren't in the stored row
      // yet (disabled by default so new versions don't surprise existing
      // users) and drop unknown keys silently.
      const known = new Set(row.tabs.map((t) => t.key));
      const merged = [
        ...row.tabs.filter((t) => (TAB_KEYS as readonly string[]).includes(t.key)),
        ...TAB_KEYS.filter((k) => !known.has(k)).map((k) => ({ key: k, enabled: false })),
      ];
      return { ...row, language: row.language ?? "ko", tabs: merged };
    }
    // Inline default so the UI never sees null while it waits for first write.
    // Carries the same optional integration keys as the stored row: without
    // them the two branches are different shapes, and callers reading
    // `settings.notion` before the first write do not typecheck.
    return {
      _id: null,
      slug: DEFAULT_SLUG,
      language: "ko",
      tabs: defaultTabs(),
      updatedAt: 0,
      github: undefined,
      google: undefined,
      notion: undefined,
    };
  },
});

export const setLanguage = mutation({
  args: { language: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await getOrInit(ctx);
    if (existing) {
      await ctx.db.patch(existing._id, { language: args.language, updatedAt: Date.now() });
      return existing._id;
    }
    return await ctx.db.insert("appSettings", {
      slug: DEFAULT_SLUG,
      language: args.language,
      tabs: defaultTabs(),
      updatedAt: Date.now(),
    });
  },
});

export const setTabs = mutation({
  args: {
    tabs: v.array(v.object({ key: v.string(), enabled: v.boolean() })),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    // Validate keys — silently drop unknowns rather than reject the call, so
    // a stale client can't brick the settings row.
    const sanitized = args.tabs.filter((t) => (TAB_KEYS as readonly string[]).includes(t.key));
    const existing = await getOrInit(ctx);
    if (existing) {
      await ctx.db.patch(existing._id, { tabs: sanitized, updatedAt: Date.now() });
      return existing._id;
    }
    return await ctx.db.insert("appSettings", {
      slug: DEFAULT_SLUG,
      tabs: sanitized.length > 0 ? sanitized : defaultTabs(),
      updatedAt: Date.now(),
    });
  },
});

export const setGithub = mutation({
  args: {
    username: v.optional(v.string()),
    // The PR search scope. Schema and resolveOrgs have both expected this field
    // from the start, but no mutation accepted it, so nothing could ever write
    // it: the settings form saved to `username` instead, and gh-verify then
    // overwrote that with the logged-in account. The scope was empty on every
    // deployment, always.
    orgs: v.optional(v.string()),
    loggedIn: v.optional(v.boolean()),
    lastVerifiedAt: v.optional(v.number()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await getOrInit(ctx);
    const { serviceKey: _serviceKey, ...fields } = args;
    const patch = { github: { ...(existing?.github ?? {}), ...fields }, updatedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert("appSettings", {
      slug: DEFAULT_SLUG,
      tabs: defaultTabs(),
      ...patch,
    });
  },
});

export const setGoogle = mutation({
  args: {
    account: v.optional(v.string()),
    loggedIn: v.optional(v.boolean()),
    lastVerifiedAt: v.optional(v.number()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await getOrInit(ctx);
    const { serviceKey: _serviceKey, ...fields } = args;
    const patch = { google: { ...(existing?.google ?? {}), ...fields }, updatedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert("appSettings", {
      slug: DEFAULT_SLUG,
      tabs: defaultTabs(),
      ...patch,
    });
  },
});

export const setNotion = mutation({
  args: {
    workspace: v.optional(v.string()),
    rootPageId: v.optional(v.string()),
    databaseId: v.optional(v.string()),
    configured: v.optional(v.boolean()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const existing = await getOrInit(ctx);
    const { serviceKey: _serviceKey, ...fields } = args;
    const patch = { notion: { ...(existing?.notion ?? {}), ...fields }, updatedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert("appSettings", {
      slug: DEFAULT_SLUG,
      tabs: defaultTabs(),
      ...patch,
    });
  },
});
