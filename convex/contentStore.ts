import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { encodeSnapshot, SNAPSHOT_CHUNK_BYTES } from "./contentSnapshot";

export const contentKind = v.union(
  v.literal("memo"),
  v.literal("section"),
  v.literal("tex"),
  v.literal("experiment"),
  v.literal("research"),
  v.literal("comment"),
);
export type ContentKind = "memo" | "section" | "tex" | "experiment" | "research" | "comment";
export type ContentIdentity = { kind: ContentKind; researchSlug: string; key: string; venueSlug?: string };
export const identityArgs = {
  kind: contentKind,
  researchSlug: v.string(),
  key: v.string(),
  venueSlug: v.optional(v.string()),
};
export const provenanceArgs = {
  sourceRevisionIds: v.optional(v.array(v.id("contentRevisions"))),
  runId: v.optional(v.id("agentRuns")),
};
export const writeArgs = { expectedRevision: v.optional(v.number()), ...provenanceArgs };
type Provenance = { sourceRevisionIds?: Id<"contentRevisions">[]; runId?: Id<"agentRuns"> };
type WriteOptions = Provenance & { expectedRevision?: number };
type ReadCtx = Pick<QueryCtx, "db">;
export function identityKey(identity: ContentIdentity): string {
  return JSON.stringify([identity.kind, identity.researchSlug, identity.venueSlug ?? null, identity.key]);
}
export async function headFor(ctx: ReadCtx, identity: ContentIdentity) {
  return ctx.db
    .query("contentHeads")
    .withIndex("by_identity", (q) => q.eq("identity", identityKey(identity)))
    .unique();
}
type RevisionToken = { revision: number; revisionId: Id<"contentRevisions"> | undefined };
export function withRevision<T extends object>(
  ctx: ReadCtx,
  identity: ContentIdentity,
  row: T,
): Promise<T & RevisionToken>;
export function withRevision<T extends object>(
  ctx: ReadCtx,
  identity: ContentIdentity,
  row: T | null,
): Promise<(T & RevisionToken) | null>;
export async function withRevision<T extends object>(ctx: ReadCtx, identity: ContentIdentity, row: T | null) {
  if (row === null) return null;
  const head = await headFor(ctx, identity);
  return { ...row, revision: head?.version ?? 0, revisionId: head?.revisionId };
}
export function checkExpected(head: Doc<"contentHeads"> | null, expected?: number): void {
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0))
    throw new Error("Invalid expectedRevision");
  if (head && expected === undefined)
    throw new Error("expectedRevision is required; read the current content before writing");
  if ((expected ?? 0) !== (head?.version ?? 0))
    throw new Error("Stale content revision; read and reconcile before retrying");
}
export async function assertProjectWritable(ctx: ReadCtx, researchSlug: string) {
  const project = await ctx.db
    .query("researchProjects")
    .withIndex("by_slug", (q) => q.eq("slug", researchSlug))
    .unique();
  if (project?.deletionStartedAt !== undefined) throw new Error("Project deletion is in progress");
}
export async function validateProvenance(ctx: ReadCtx, researchSlug: string, options: Provenance) {
  await assertProjectWritable(ctx, researchSlug);
  const sources = options.sourceRevisionIds ?? [];
  if (sources.length > 32 || new Set(sources).size !== sources.length) throw new Error("Invalid source revision list");
  for (const id of sources) {
    const revision = await ctx.db.get(id);
    if (!revision || revision.researchSlug !== researchSlug || revision.deleted)
      throw new Error("Invalid source revision");
  }
  if (options.runId) {
    const run = await ctx.db.get(options.runId);
    if (!run || run.status !== "running") throw new Error("Attributed run must be running");
    if (run.researchSlug !== researchSlug || !run.triggerSnapshot || run.sourceRevisionIds === undefined)
      throw new Error("Run has no matching pinned input snapshot");
    if (sources.length !== run.sourceRevisionIds.length || sources.some((id) => !run.sourceRevisionIds!.includes(id)))
      throw new Error("Source revisions must exactly match the run inputs");
    return run;
  }
  return null;
}
async function insertRevision(
  ctx: MutationCtx,
  identity: ContentIdentity,
  version: number,
  operation: Doc<"contentRevisions">["operation"],
  snapshot: Record<string, unknown>,
  options: Provenance = {},
) {
  const bytes = encodeSnapshot(snapshot);
  const id = await ctx.db.insert("contentRevisions", {
    ...identity,
    identity: identityKey(identity),
    version,
    operation,
    deleted: operation === "delete",
    createdAt: Date.now(),
    codec: "utf16-fields-v1",
    snapshotBytes: bytes.length,
    chunkCount: Math.ceil(bytes.length / SNAPSHOT_CHUNK_BYTES),
    sourceRevisionIds: options.sourceRevisionIds ?? [],
    runId: options.runId,
  });
  for (let position = 0, start = 0; start < bytes.length; position++, start += SNAPSHOT_CHUNK_BYTES) {
    await ctx.db.insert("contentRevisionChunks", {
      researchSlug: identity.researchSlug,
      revisionId: id,
      position,
      bytes: bytes.slice(start, start + SNAPSHOT_CHUNK_BYTES).buffer,
    });
  }
  return id;
}
export function snapshotOf(row: Record<string, unknown>): Record<string, unknown> {
  const { _id, _creationTime, ...snapshot } = row;
  return snapshot;
}
export async function prepareWrite(
  ctx: MutationCtx,
  identity: ContentIdentity,
  existing: Record<string, unknown> | null,
  options: WriteOptions,
) {
  let head = await headFor(ctx, identity);
  checkExpected(head, options.expectedRevision);
  await validateProvenance(ctx, identity.researchSlug, options);
  if (head && head.deleted === Boolean(existing)) throw new Error("Content head does not match stored content");
  if (!head && existing) {
    const revisionId = await insertRevision(ctx, identity, 0, "legacy", snapshotOf(existing));
    const id = await ctx.db.insert("contentHeads", {
      ...identity,
      identity: identityKey(identity),
      version: 0,
      revisionId,
      deleted: false,
    });
    head = (await ctx.db.get(id))!;
  }
  return head;
}
export async function finishWrite(
  ctx: MutationCtx,
  identity: ContentIdentity,
  head: Doc<"contentHeads"> | null,
  operation: Exclude<Doc<"contentRevisions">["operation"], "legacy">,
  snapshot: Record<string, unknown>,
  options: Provenance = {},
) {
  await validateProvenance(ctx, identity.researchSlug, options);
  const revision = (head?.version ?? 0) + 1;
  const revisionId = await insertRevision(ctx, identity, revision, operation, snapshotOf(snapshot), options);
  const fields = { version: revision, revisionId, deleted: operation === "delete" };
  if (head) await ctx.db.patch(head._id, fields);
  else await ctx.db.insert("contentHeads", { ...identity, identity: identityKey(identity), ...fields });
  return { revision, revisionId };
}
export async function pinSource(
  ctx: MutationCtx,
  identity: ContentIdentity,
  source: Record<string, unknown>,
  expectedRevision?: number,
) {
  if (expectedRevision === undefined && (await headFor(ctx, identity)))
    throw new Error("expectedSourceRevision is required; read the fork source before forking");
  const head = await prepareWrite(ctx, identity, source, { expectedRevision });
  return head!.revisionId;
}
// Entity timestamps and database IDs are storage metadata, not a content edit.
export function contentEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const clean = (value: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key, item]) => !["_id", "_creationTime", "createdAt", "updatedAt"].includes(key) && item !== undefined,
        )
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  const left = encodeSnapshot(clean(a));
  const right = encodeSnapshot(clean(b));
  return left.length === right.length && left.every((byte, i) => byte === right[i]);
}
export function headToken(head: Doc<"contentHeads">) {
  return { revision: head.version, revisionId: head.revisionId };
}

// Internal event snapshots use the same immutable/chunked storage as content.
// Only callers that already validated the event can append these snapshots.
export async function pinEventSnapshot(
  ctx: MutationCtx,
  identity: ContentIdentity,
  snapshot: Record<string, unknown>,
  options: Provenance = {},
) {
  const head = await headFor(ctx, identity);
  return finishWrite(ctx, identity, head, head ? "update" : "create", snapshot, options);
}
