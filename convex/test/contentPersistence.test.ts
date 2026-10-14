import { describe, expect, it } from "vitest";
import { anyApi } from "convex/server";
import { getDocumentSize } from "convex/values";
import { auth, withConvex, withConvexLimits } from "./harness.setup";
const api = anyApi;
const cases = [
  { kind: "memo", module: "researchMemos", key: "memoSlug", field: "content", defaults: { title: "M" } },
  {
    kind: "experiment",
    module: "researchExperiments",
    key: "expSlug",
    field: "description",
    defaults: { name: "E", status: "planned" },
  },
  {
    kind: "section",
    module: "researchSections",
    key: "sectionSlug",
    field: "content",
    defaults: { title: "S", format: "markdown" },
  },
  { kind: "tex", module: "researchTex", key: "texPath", field: "content", defaults: {} },
] as const;
for (const c of cases)
  describe(`${c.kind} persisted content`, () => {
    const key = { researchSlug: "p", [c.key]: "k" };
    const identity = { kind: c.kind, researchSlug: "p", key: "k" };
    it("returns the same stored revision on a semantic no-op", async () => {
      const t = withConvex();
      const first = await t.mutation(api[c.module].save, { ...auth, ...key, [c.field]: "A" });
      const before = await t.query(api[c.module].get, { ...auth, ...key });
      const next = await t.mutation(api[c.module].save, { ...auth, ...key, [c.field]: "A", expectedRevision: 1 });
      expect(next.revisionId).toBe(first.revisionId);
      expect(next.revision).toBe(1);
      expect(await t.query(api[c.module].get, { ...auth, ...key })).toEqual(before);
      expect(await t.query(api.contentRevisions.list, { ...auth, ...identity })).toHaveLength(1);
    });
    it("requires an original read token and rejects stale or invalid versions", async () => {
      const t = withConvex();
      await t.mutation(api[c.module].save, { ...auth, ...key, [c.field]: "A" });
      for (const expectedRevision of [undefined, 0, -1, 1.5, NaN]) {
        await expect(
          t.mutation(api[c.module].save, { ...auth, ...key, expectedRevision, [c.field]: "bad" }),
        ).rejects.toThrow();
      }
      expect((await t.query(api[c.module].get, { ...auth, ...key }))[c.field]).toBe("A");
    });
    it("allows only one of two writers with the same read token", async () => {
      const t = withConvex();
      await t.mutation(api[c.module].save, { ...auth, ...key, [c.field]: "A" });
      const results = await Promise.allSettled(
        ["B", "C"].map((value) =>
          t.mutation(api[c.module].save, { ...auth, ...key, [c.field]: value, expectedRevision: 1 }),
        ),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect((await t.query(api[c.module].get, { ...auth, ...key })).revision).toBe(2);
    });
    it("keeps old snapshots, deletion tombstones and monotonic versions across recreation", async () => {
      const t = withConvex();
      const first = await t.mutation(api[c.module].save, { ...auth, ...key, [c.field]: "A" });
      const second = await t.mutation(api[c.module].save, { ...auth, ...key, [c.field]: "B", expectedRevision: 1 });
      await expect(t.mutation(api[c.module].remove, { ...auth, ...key, expectedRevision: 1 })).rejects.toThrow(
        /stale/i,
      );
      const removed = await t.mutation(api[c.module].remove, { ...auth, ...key, expectedRevision: 2 });
      expect(removed.revision).toBe(3);
      expect((await t.query(api.contentRevisions.get, { ...auth, id: first.revisionId })).snapshot[c.field]).toBe("A");
      expect((await t.query(api.contentRevisions.get, { ...auth, id: second.revisionId })).snapshot[c.field]).toBe("B");
      expect((await t.query(api.contentRevisions.get, { ...auth, id: removed.revisionId })).deleted).toBe(true);
      await expect(t.mutation(api[c.module].save, { ...auth, ...key, expectedRevision: 0 })).rejects.toThrow(/stale/i);
      expect(
        (await t.mutation(api[c.module].save, { ...auth, ...key, [c.field]: "C", expectedRevision: 3 })).revision,
      ).toBe(4);
    });
    it("atomically adopts legacy revision zero and refuses a second legacy writer", async () => {
      const t = withConvex();
      await t.run((ctx) =>
        ctx.db.insert(c.module, { ...key, ...c.defaults, [c.field]: "legacy", createdAt: 1, updatedAt: 1 } as never),
      );
      expect((await t.query(api[c.module].get, { ...auth, ...key })).revision).toBe(0);
      await t.mutation(api[c.module].save, { ...auth, ...key, [c.field]: "new", expectedRevision: 0 });
      await expect(
        t.mutation(api[c.module].save, { ...auth, ...key, [c.field]: "stale", expectedRevision: 0 }),
      ).rejects.toThrow(/stale/i);
      const history = await t.query(api.contentRevisions.list, { ...auth, ...identity });
      expect(history.map((r: { version: number }) => r.version)).toEqual([1, 0]);
      expect((await t.query(api.contentRevisions.get, { ...auth, id: history[1]._id })).snapshot[c.field]).toBe(
        "legacy",
      );
    });
    for (const action of ["save", "remove"] as const)
      it(`preserves near-limit legacy control-character content on first ${action} within transaction limits`, async () => {
        const t = withConvexLimits();
        const content = "\u0001".repeat(900_000);
        const doc = { ...key, ...c.defaults, [c.field]: content, createdAt: 1, updatedAt: 1 };
        expect(getDocumentSize(doc)).toBeLessThan(1_048_576);
        await t.run((ctx) => ctx.db.insert(c.module, doc as never));
        await t.mutation(api[c.module][action], {
          ...auth,
          ...key,
          ...(action === "save" ? { notes: "first edit" } : {}),
        });
        const history = await t.query(api.contentRevisions.list, { ...auth, ...identity });
        const legacy = history.find((r: { version: number }) => r.version === 0);
        expect((await t.query(api.contentRevisions.get, { ...auth, id: legacy._id })).snapshot[c.field]).toBe(content);
      });
  });
for (const c of cases.filter((c) => c.kind === "section" || c.kind === "tex"))
  describe(`${c.kind} fork integrity`, () => {
    it("pins source and target tokens and retains exact source provenance", async () => {
      const t = withConvex();
      const key = { researchSlug: "p", [c.key]: "k" };
      const source = await t.mutation(api[c.module].save, { ...auth, ...key, content: "source" });
      await t.mutation(api[c.module].save, { ...auth, ...key, venueSlug: "v", content: "old target" });
      const fork = await t.mutation(api[c.module].fork, {
        ...auth,
        ...key,
        toVenueSlug: "v",
        expectedSourceRevision: 1,
        expectedRevision: 1,
      });
      expect((await t.query(api.contentRevisions.get, { ...auth, id: fork.revisionId })).sourceRevisionIds).toEqual([
        source.revisionId,
      ]);
      await t.mutation(api[c.module].save, { ...auth, ...key, content: "changed", expectedRevision: 1 });
      await expect(
        t.mutation(api[c.module].fork, { ...auth, ...key, toVenueSlug: "other", expectedSourceRevision: 1 }),
      ).rejects.toThrow(/stale/i);
      await expect(
        t.mutation(api[c.module].fork, {
          ...auth,
          ...key,
          toVenueSlug: "v",
          expectedSourceRevision: 2,
          expectedRevision: 1,
        }),
      ).rejects.toThrow(/stale/i);
      expect((await t.query(api[c.module].get, { ...auth, ...key, venueSlug: "v" })).content).toBe("source");
    });
    it("names the source token when a fork of a versioned source leaves it out", async () => {
      const t = withConvex();
      const key = { researchSlug: "p", [c.key]: "k" };
      await t.mutation(api[c.module].save, { ...auth, ...key, content: "source" });
      await t.mutation(api[c.module].save, { ...auth, ...key, venueSlug: "v", content: "old target" });
      await expect(
        t.mutation(api[c.module].fork, { ...auth, ...key, toVenueSlug: "v", expectedRevision: 1 }),
      ).rejects.toThrow(/expectedSourceRevision is required/);
    });
    it("preserves two large legacy documents across first fork within transaction limits", async () => {
      const t = withConvexLimits();
      const key = { researchSlug: "p", [c.key]: "k" };
      const a = "\u0000".repeat(900_000),
        b = "\u0002".repeat(900_000);
      await t.run(async (ctx) => {
        await ctx.db.insert(c.module, { ...key, ...c.defaults, content: a, createdAt: 1, updatedAt: 1 } as never);
        await ctx.db.insert(c.module, {
          ...key,
          ...c.defaults,
          venueSlug: "v",
          content: b,
          createdAt: 1,
          updatedAt: 1,
        } as never);
      });
      await t.mutation(api[c.module].fork, {
        ...auth,
        ...key,
        toVenueSlug: "v",
        expectedRevision: 0,
        expectedSourceRevision: 0,
      });
      for (const [venueSlug, expected] of [
        [undefined, a],
        ["v", b],
      ] as const) {
        const history = await t.query(api.contentRevisions.list, {
          ...auth,
          kind: c.kind,
          researchSlug: "p",
          key: "k",
          venueSlug,
        });
        const original = history.find((r: { version: number }) => r.version === 0);
        expect((await t.query(api.contentRevisions.get, { ...auth, id: original._id })).snapshot.content).toBe(
          expected,
        );
      }
      expect((await t.query(api[c.module].get, { ...auth, ...key, venueSlug: "v" })).content).toBe(a);
    });
  });
it("cascades binary chunks with bounded accurate byte accounting and no leftover history", async () => {
  const t = withConvexLimits();
  const p = await t.mutation(api.research.register, { ...auth, slug: "p", title: "P", kind: "own" });
  for (let i = 0; i < 8; i++)
    await t.mutation(api.researchMemos.save, {
      ...auth,
      researchSlug: "p",
      memoSlug: `m${i}`,
      content: "a".repeat(900_000),
    });
  let result = await t.mutation(api.research.remove, { ...auth, id: p.id });
  expect(result.done).toBe(false);
  for (let i = 0; i < 20 && !result.done; i++) result = await t.mutation(api.research.remove, { ...auth, id: p.id });
  expect(result.done).toBe(true);
  for (const table of ["contentRevisionChunks", "contentRevisions", "contentHeads", "researchMemos"] as const)
    expect(await t.run((ctx) => ctx.db.query(table).collect())).toEqual([]);
});
it("blocks content rewrites during a resumable project deletion", async () => {
  const t = withConvex();
  const p = await t.mutation(api.research.register, { ...auth, slug: "p", title: "P", kind: "own" });
  const saved = await t.mutation(api.researchMemos.save, {
    ...auth,
    researchSlug: "p",
    memoSlug: "m",
    content: "before",
  });
  expect((await t.mutation(api.research.remove, { ...auth, id: p.id, limit: 1 })).done).toBe(false);
  await expect(
    t.mutation(api.researchMemos.save, {
      ...auth,
      researchSlug: "p",
      memoSlug: "m",
      expectedRevision: saved.revision,
      content: "after",
    }),
  ).rejects.toThrow(/deletion/i);
});
