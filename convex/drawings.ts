import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireOwner } from "./auth";

// Per-field size caps. Convex's per-doc limit is 1 MiB; these guards stop
// runaway clients from saturating bandwidth long before they hit that.
const MAX_ELEMENTS_BYTES = 512_000;
const MAX_APPSTATE_BYTES = 32_000;
const MAX_THUMBNAIL_BYTES = 64_000;

function assertSize(name: string, val: string | undefined, limit: number) {
  if (val !== undefined && val.length > limit) {
    throw new Error(`${name} too large: ${val.length}B exceeds ${limit}B cap`);
  }
}

async function contentRow(ctx: { db: any }, drawingId: Id<"drawings">) {
  return await ctx.db
    .query("drawingContents")
    .withIndex("by_drawingId", (q: any) => q.eq("drawingId", drawingId))
    .first();
}

// Gallery listing: title / thumbnail / timestamps. Trimming the response was
// never the hard part — the read was. Now that the canvas body sits in its own
// table, listing every drawing reads only what it returns.
export const list = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const rows = await ctx.db.query("drawings").withIndex("by_updatedAt").order("desc").collect();
    return rows.map((r) => ({
      _id: r._id,
      title: r.title,
      thumbnail: r.thumbnail,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  },
});

export const getById = query({
  args: { id: v.id("drawings"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const row = await ctx.db.get(args.id);
    if (!row) return null;
    // Falls back to the row's own fields for drawings migrateContents has not
    // drained yet.
    const body = await contentRow(ctx, args.id);
    return {
      _id: row._id,
      title: row.title,
      elements: body?.elements ?? row.elements ?? "[]",
      appState: body?.appState ?? row.appState,
      thumbnail: row.thumbnail,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  },
});

export const create = mutation({
  args: { title: v.optional(v.string()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const now = Date.now();
    const id = await ctx.db.insert("drawings", {
      title: args.title ?? "Untitled",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("drawingContents", { drawingId: id, elements: "[]" });
    return id;
  },
});

export const update = mutation({
  args: {
    id: v.id("drawings"),
    elements: v.string(),
    appState: v.optional(v.string()),
    thumbnail: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    assertSize("elements", args.elements, MAX_ELEMENTS_BYTES);
    assertSize("appState", args.appState, MAX_APPSTATE_BYTES);
    assertSize("thumbnail", args.thumbnail, MAX_THUMBNAIL_BYTES);
    const body = { elements: args.elements, ...(args.appState !== undefined ? { appState: args.appState } : {}) };
    const existing = await contentRow(ctx, args.id);
    if (existing) {
      await ctx.db.patch(existing._id, body);
    } else {
      await ctx.db.insert("drawingContents", { drawingId: args.id, ...body });
    }
    await ctx.db.patch(args.id, {
      // Clears whatever a pre-split row was still carrying, so the gallery read
      // shrinks the first time each drawing is saved even before the migration.
      elements: undefined,
      appState: undefined,
      ...(args.thumbnail !== undefined ? { thumbnail: args.thumbnail } : {}),
      updatedAt: Date.now(),
    });
  },
});

export const rename = mutation({
  args: { id: v.id("drawings"), title: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.patch(args.id, { title: args.title, updatedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { id: v.id("drawings"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const body = await contentRow(ctx, args.id);
    if (body) await ctx.db.delete(body._id);
    await ctx.db.delete(args.id);
  },
});

// One-shot: drain elements / appState off the drawings rows into their own
// table. Idempotent, and safe to run while the app is live because getById and
// update both read either shape.
export const migrateContents = mutation({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const rows = await ctx.db.query("drawings").withIndex("by_updatedAt").collect();
    let moved = 0;
    for (const r of rows) {
      if (r.elements === undefined && r.appState === undefined) continue;
      const existing = await contentRow(ctx, r._id);
      const body = { elements: r.elements ?? "[]", ...(r.appState !== undefined ? { appState: r.appState } : {}) };
      if (existing) {
        await ctx.db.patch(existing._id, body);
      } else {
        await ctx.db.insert("drawingContents", { drawingId: r._id, ...body });
      }
      await ctx.db.patch(r._id, { elements: undefined, appState: undefined });
      moved++;
    }
    return { scanned: rows.length, moved };
  },
});
