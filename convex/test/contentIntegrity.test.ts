import { describe, expect, it } from "vitest";
import { anyApi } from "convex/server";
import { auth, withConvex } from "./harness.setup";
const api = anyApi;

describe("content integrity acceptance cases", () => {
  it("queues workspace subscriptions only for projects in that workspace", async () => {
    const t = withConvex();
    const workspace = await t.run((ctx) =>
      ctx.db.insert("workspaces", { slug: "home", name: "Home", ownerId: "owner", createdAt: 1, updatedAt: 1 }),
    );
    await t.run((ctx) =>
      ctx.db.insert("researchProjects", {
        slug: "p",
        title: "P",
        kind: "own",
        phase: "ideation",
        workspaceId: workspace,
        updatedAt: 1,
      }),
    );
    await t.mutation(api.agentSubscriptions.subscribe, {
      ...auth,
      agentId: "reader",
      eventType: "entity.created",
      scope: "workspace",
      scopeId: workspace,
    });
    await t.mutation(api.researchExperiments.save, { ...auth, researchSlug: "p", expSlug: "e" });
    const runs = await t.run((ctx) => ctx.db.query("agentRuns").collect());
    expect(runs).toHaveLength(1);
    await t.mutation(api.researchExperiments.save, { ...auth, researchSlug: "other", expSlug: "e" });
    expect(await t.run((ctx) => ctx.db.query("agentRuns").collect())).toHaveLength(1);
  });
  it("pins canonical config and exact source revisions when queuing a run", async () => {
    const t = withConvex();
    await t.mutation(api.agentSubscriptions.subscribe, {
      ...auth,
      agentId: "reader",
      eventType: "entity.created",
      scope: "global",
      config: '{ "instructions": "summarize", "language": "ko" }',
    });
    const saved = await t.mutation(api.researchExperiments.save, {
      ...auth,
      researchSlug: "p",
      expSlug: "e",
      description: "first",
    });
    const run = await t.run((ctx) => ctx.db.query("agentRuns").first());
    expect(run).toMatchObject({
      configSnapshot: '{"instructions":"summarize","language":"ko"}',
      sourceRevisionIds: [saved.revisionId],
    });
  });
  it("routes phase changes in upsert through the timeline and trigger path", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "p", title: "P", kind: "own" });
    await t.mutation(api.agentSubscriptions.subscribe, {
      ...auth,
      agentId: "reader",
      eventType: "state.transitioned",
      scope: "global",
    });
    await t.mutation(api.research.upsert, { ...auth, slug: "p", title: "P", kind: "own", phase: "literature" });
    const timeline = await t.run((ctx) => ctx.db.query("researchTimeline").collect());
    expect(timeline.map((r) => r.state)).toEqual(["ideation", "literature"]);
    expect(await t.run((ctx) => ctx.db.query("agentRuns").collect())).toHaveLength(1);
  });
  it("preserves human history while appending validated inference history", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "p", title: "P", kind: "own", actor: "human" });
    await t.mutation(api.researchPhaseInfer.applyInferred, {
      ...auth,
      researchSlug: "p",
      phase: "literature",
      history: [{ state: "literature", note: "evidence" }],
    });
    const timeline = await t.run((ctx) => ctx.db.query("researchTimeline").collect());
    expect(timeline.some((r) => r.actor === "human" && r.note === "registered")).toBe(true);
    expect(timeline.some((r) => r.actor === "phase-infer")).toBe(true);
  });
  it("rejects a stale overwrite after first save instead of losing newer content", async () => {
    const t = withConvex();
    const first = await t.mutation(api.researchMemos.save, {
      ...auth,
      researchSlug: "p",
      memoSlug: "m",
      content: "first",
    });
    expect(first.revision).toBe(1);
    await t.mutation(api.researchMemos.save, {
      ...auth,
      researchSlug: "p",
      memoSlug: "m",
      content: "second",
      expectedRevision: first.revision,
    });
    await expect(
      t.mutation(api.researchMemos.save, {
        ...auth,
        researchSlug: "p",
        memoSlug: "m",
        content: "stale",
        expectedRevision: first.revision,
      }),
    ).rejects.toThrow(/stale/i);
    expect((await t.query(api.researchMemos.get, { ...auth, researchSlug: "p", memoSlug: "m" })).content).toBe(
      "second",
    );
  });
  it("keeps immutable persisted snapshots after deletion", async () => {
    const t = withConvex();
    const first = await t.mutation(api.researchMemos.save, {
      ...auth,
      researchSlug: "p",
      memoSlug: "m",
      content: "preserved",
    });
    expect(first.revisionId).toBeDefined();
    await t.mutation(api.researchMemos.remove, {
      ...auth,
      researchSlug: "p",
      memoSlug: "m",
      expectedRevision: first.revision,
    });
    const revision = await t.query(api.contentRevisions.get, { ...auth, id: first.revisionId });
    expect(revision.snapshot.content).toBe("preserved");
    expect(await t.query(api.researchMemos.get, { ...auth, researchSlug: "p", memoSlug: "m" })).toBeNull();
  });
  it("rejects completion of an unclaimed run", async () => {
    const t = withConvex();
    await t.mutation(api.agentSubscriptions.subscribe, {
      ...auth,
      agentId: "reader",
      eventType: "entity.created",
      scope: "global",
    });
    await t.mutation(api.researchExperiments.save, { ...auth, researchSlug: "p", expSlug: "e" });
    const run = await t.run((ctx) => ctx.db.query("agentRuns").first());
    await expect(
      t.mutation(api.agentSubscriptions.completeRun, {
        ...auth,
        id: run!._id,
        status: "done",
        result: "never claimed",
      }),
    ).rejects.toThrow(/running/i);
  });
  it("preserves a large legacy document verbatim on its first save", async () => {
    const t = withConvex();
    const content = "\u0001".repeat(900_000);
    await t.run((ctx) =>
      ctx.db.insert("researchMemos", {
        researchSlug: "p",
        memoSlug: "m",
        title: "M",
        content,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const result = await t.mutation(api.researchMemos.save, {
      ...auth,
      researchSlug: "p",
      memoSlug: "m",
      title: "Renamed",
    });
    expect(result.revision).toBe(1);
    const history = await t.query(api.contentRevisions.list, { ...auth, kind: "memo", researchSlug: "p", key: "m" });
    const original = history.find((r: { version: number }) => r.version === 0);
    expect(original).toBeDefined();
    expect((await t.query(api.contentRevisions.get, { ...auth, id: original._id })).snapshot.content).toBe(content);
  });
});
