import { describe, expect, it } from "vitest";
import { anyApi } from "convex/server";
import type { Id } from "../_generated/dataModel";
import { auth, withConvex } from "./harness.setup";
const api = anyApi;
async function queued() {
  const t = withConvex();
  await t.mutation(api.agentSubscriptions.subscribe, {
    ...auth,
    agentId: "reader",
    eventType: "entity.created",
    scope: "global",
  });
  const source = await t.mutation(api.researchExperiments.save, {
    ...auth,
    researchSlug: "p",
    expSlug: "e",
    description: "exact input",
  });
  const run = (await t.run((ctx) => ctx.db.query("agentRuns").first()))!;
  await t.mutation(api.agentSubscriptions.claimRun, { ...auth, id: run._id });
  return {
    t,
    run,
    source,
    args: {
      ...auth,
      researchSlug: "p",
      targetType: "experiment",
      targetKey: "e",
      authorType: "agent",
      authorId: "reader",
      runId: run._id,
      sourceRevisionIds: [source.revisionId],
    },
  };
}
describe("attributed output proof", () => {
  it.each(["", " \n\t", "\u00a0"])("rejects blank attributed output %#", async (body) => {
    const { t, run, args } = await queued();
    await expect(t.mutation(api.comments.post, { ...args, body })).rejects.toThrow(/blank/i);
    await expect(
      t.mutation(api.agentSubscriptions.completeRun, {
        ...auth,
        id: run._id,
        status: "done",
        outcome: "commented",
        sourceRevisionIds: args.sourceRevisionIds,
      }),
    ).rejects.toThrow(/output comment/i);
  });
  it("backstops preexisting blank attributed comments at completion", async () => {
    const { t, run, args } = await queued();
    await t.run((ctx) =>
      ctx.db.insert("comments", {
        researchSlug: "p",
        targetType: "experiment",
        targetKey: "e",
        authorType: "agent",
        authorId: "reader",
        runId: run._id,
        sourceRevisionIds: args.sourceRevisionIds,
        body: " \t",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await expect(
      t.mutation(api.agentSubscriptions.completeRun, {
        ...auth,
        id: run._id,
        status: "done",
        outcome: "commented",
        sourceRevisionIds: args.sourceRevisionIds,
      }),
    ).rejects.toThrow(/output comment/i);
  });
  it("preserves exact old input and retry-safe output after source edits", async () => {
    const { t, run, source, args } = await queued();
    await t.mutation(api.researchExperiments.save, {
      ...auth,
      researchSlug: "p",
      expSlug: "e",
      description: "new input",
      expectedRevision: 1,
    });
    const posted = await t.mutation(api.comments.post, { ...args, body: "Based on the exact queued input." });
    expect(await t.mutation(api.comments.post, { ...args, body: "Based on the exact queued input." })).toEqual(posted);
    await t.mutation(api.agentSubscriptions.completeRun, {
      ...auth,
      id: run._id,
      status: "done",
      outcome: "commented",
      sourceRevisionIds: args.sourceRevisionIds,
    });
    const row = (await t.run((ctx) => ctx.db.get(posted.id as Id<"comments">)))!;
    const output = await t.query(api.contentRevisions.get, { ...auth, id: row.outputRevisionId });
    expect(output.runId).toBe(run._id);
    expect(output.sourceRevisionIds).toEqual([source.revisionId]);
    expect((await t.query(api.contentRevisions.get, { ...auth, id: source.revisionId })).snapshot.description).toBe(
      "exact input",
    );
    await expect(
      t.mutation(api.comments.edit, {
        ...auth,
        commentId: posted.id,
        authorType: "agent",
        authorId: "reader",
        body: "changed",
      }),
    ).rejects.toThrow(/immutable/i);
    await t.mutation(api.comments.remove, { ...auth, commentId: posted.id, authorType: "agent", authorId: "reader" });
    expect((await t.query(api.contentRevisions.get, { ...auth, id: row.outputRevisionId })).snapshot.body).toBe(
      "Based on the exact queued input.",
    );
  });
});
it("retains server-applied inference history instead of a replacement completion transcript", async () => {
  const t = withConvex();
  await t.mutation(api.research.register, { ...auth, slug: "p", title: "P", kind: "own" });
  const run = await t.mutation(api.researchPhaseInfer.request, { ...auth, researchSlug: "p" });
  await t.mutation(api.researchPhaseInfer.claimRun, { ...auth, id: run.id });
  const history = [{ state: "literature", note: "actual evidence" }];
  await t.mutation(api.researchPhaseInfer.applyInferred, {
    ...auth,
    researchSlug: "p",
    runId: run.id,
    phase: "literature",
    history,
  });
  await t.mutation(api.researchPhaseInfer.completeRun, {
    ...auth,
    id: run.id,
    status: "done",
    inferredPhase: "literature",
    inferredHistory: "forged replacement",
  });
  const stored = await t.run((ctx) => ctx.db.get(run.id as Id<"researchPhaseRuns">));
  expect(JSON.parse(stored!.inferredHistory!)).toEqual(history);
});
it("does not fan out a write made inside an agent run, so a run cannot re-trigger itself", async () => {
  const { t, run, source } = await queued();
  const pending = () =>
    t.run((ctx) =>
      ctx.db
        .query("agentRuns")
        .filter((q) => q.eq(q.field("status"), "pending"))
        .collect(),
    );
  await t.mutation(api.researchMemos.save, {
    ...auth,
    researchSlug: "p",
    memoSlug: "from-run",
    content: "written by the run",
    runId: run._id,
    sourceRevisionIds: [source.revisionId],
  });
  expect(await pending()).toHaveLength(0);
  await t.mutation(api.researchMemos.save, { ...auth, researchSlug: "p", memoSlug: "by-hand", content: "typed" });
  expect(await pending()).toHaveLength(1);
});
