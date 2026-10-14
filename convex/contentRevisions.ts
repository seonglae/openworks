import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireOwner } from "./auth";
import { headFor, identityArgs, identityKey } from "./contentStore";
import { decodeSnapshot, MAX_SNAPSHOT_BYTES } from "./contentSnapshot";
export const head = query({
  args: { ...identityArgs, serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    return headFor(ctx, args);
  },
});
export const list = query({
  args: {
    ...identityArgs,
    beforeVersion: v.optional(v.number()),
    limit: v.optional(v.number()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const limit = args.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be between 1 and 100");
    if (args.beforeVersion !== undefined && (!Number.isSafeInteger(args.beforeVersion) || args.beforeVersion < 0))
      throw new Error("Invalid version cursor");
    return ctx.db
      .query("contentRevisions")
      .withIndex("by_identity_version", (q) => {
        const range = q.eq("identity", identityKey(args));
        return args.beforeVersion === undefined ? range : range.lt("version", args.beforeVersion);
      })
      .order("desc")
      .take(limit);
  },
});
export const get = query({
  args: { id: v.id("contentRevisions"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const revision = await ctx.db.get(args.id);
    if (!revision) return null;
    if (
      revision.codec !== "utf16-fields-v1" ||
      !Number.isSafeInteger(revision.snapshotBytes) ||
      revision.snapshotBytes < 4 ||
      revision.snapshotBytes > MAX_SNAPSHOT_BYTES ||
      !Number.isSafeInteger(revision.chunkCount) ||
      revision.chunkCount < 1 ||
      revision.chunkCount > 24
    )
      throw new Error("Invalid stored snapshot");
    const chunks = await ctx.db
      .query("contentRevisionChunks")
      .withIndex("by_revision_position", (q) => q.eq("revisionId", args.id))
      .take(revision.chunkCount + 1);
    if (chunks.length !== revision.chunkCount) throw new Error("Incomplete stored snapshot");
    const bytes = new Uint8Array(revision.snapshotBytes);
    let position = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      if (chunk.position !== i || chunk.bytes.byteLength > bytes.length - position)
        throw new Error("Invalid stored snapshot");
      bytes.set(new Uint8Array(chunk.bytes), position);
      position += chunk.bytes.byteLength;
    }
    if (position !== bytes.length) throw new Error("Incomplete stored snapshot");
    return { ...revision, snapshot: decodeSnapshot(bytes) };
  },
});
