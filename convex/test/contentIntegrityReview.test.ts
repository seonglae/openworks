import { describe, expect, it } from "vitest";
import { anyApi } from "convex/server";
import type { Id } from "../_generated/dataModel";
import { auth, withConvex } from "./harness.setup";

const api = anyApi;

async function queuedRun(config?: string) {
  const t = withConvex();
  const subscription = await t.mutation(api.agentSubscriptions.subscribe, {
    ...auth,
    agentId: "reviewer",
    eventType: "entity.created",
    scope: "global",
    config,
  });
  const saved = await t.mutation(api.researchExperiments.save, {
    ...auth,
    researchSlug: "p",
    expSlug: "e",
    description: "original evidence",
  });
  const run = (await t.run((ctx) => ctx.db.query("agentRuns").first()))!;
  const comment = {
    ...auth,
    researchSlug: "p",
    targetType: "experiment",
    targetKey: "e",
    authorType: "agent",
    authorId: "reviewer",
    body: "Supported output",
    runId: run._id,
    sourceRevisionIds: [saved.revisionId],
  };
  return { t, subscription, saved, run, comment };
}

describe("independent run attribution boundaries", () => {
  it("rejects wrong agent, target, venue, project and source IDs without writing output", async () => {
    const { t, run, comment } = await queuedRun();
    await t.mutation(api.agentSubscriptions.claimRun, { ...auth, id: run._id });
    const foreign = await t.mutation(api.researchMemos.save, {
      ...auth,
      researchSlug: "foreign",
      memoSlug: "m",
      content: "unrelated",
    });
    for (const patch of [
      { authorId: "another-agent" },
      { targetKey: "other" },
      { targetType: "memo" },
      { targetVenueSlug: "other" },
      { researchSlug: "foreign" },
      { sourceRevisionIds: [] },
      { sourceRevisionIds: [foreign.revisionId] },
      { sourceRevisionIds: [...comment.sourceRevisionIds, ...comment.sourceRevisionIds] },
    ]) {
      await expect(t.mutation(api.comments.post, { ...comment, ...patch })).rejects.toThrow();
    }
    expect(await t.run((ctx) => ctx.db.query("comments").collect())).toEqual([]);
  });

  it("preserves queued config and source snapshots after live content and subscription changes", async () => {
    const { t, subscription, saved, run, comment } = await queuedRun('{"language":"ko","instructions":"Original"}');
    await t.run((ctx) => ctx.db.patch(subscription.id, { config: '{"instructions":"Changed"}' }));
    await t.mutation(api.researchExperiments.save, {
      ...auth,
      researchSlug: "p",
      expSlug: "e",
      description: "later evidence",
      expectedRevision: 1,
    });
    await t.mutation(api.researchExperiments.remove, {
      ...auth,
      researchSlug: "p",
      expSlug: "e",
      expectedRevision: 2,
    });
    const claimed = await t.mutation(api.agentSubscriptions.claimRun, { ...auth, id: run._id });
    expect(claimed.configSnapshot).toBe('{"instructions":"Original","language":"ko"}');
    expect(claimed.sourceRevisionIds).toEqual([saved.revisionId]);
    expect((await t.query(api.contentRevisions.get, { ...auth, id: saved.revisionId })).snapshot.description).toBe(
      "original evidence",
    );
    await t.mutation(api.comments.post, comment);
    await t.mutation(api.agentSubscriptions.completeRun, {
      ...auth,
      id: run._id,
      status: "done",
      outcome: "commented",
      sourceRevisionIds: [saved.revisionId],
    });
    expect((await t.run((ctx) => ctx.db.get(run._id)))?.outcome).toBe("commented");
  });

  it("requires real output evidence, deduplicates identical output and freezes attributed text", async () => {
    const { t, run, comment } = await queuedRun();
    await t.mutation(api.agentSubscriptions.claimRun, { ...auth, id: run._id });
    const completion = {
      ...auth,
      id: run._id,
      status: "done",
      outcome: "commented",
      sourceRevisionIds: comment.sourceRevisionIds,
    };
    await expect(t.mutation(api.agentSubscriptions.completeRun, { ...completion, result: "I posted" })).rejects.toThrow(
      /comment/i,
    );
    const first = await t.mutation(api.comments.post, comment);
    expect(await t.mutation(api.comments.post, comment)).toEqual(first);
    await expect(t.mutation(api.comments.post, { ...comment, body: "Changed output" })).rejects.toThrow(/immutable/i);
    await expect(
      t.mutation(api.comments.edit, {
        ...auth,
        commentId: first.id,
        authorType: "agent",
        authorId: "reviewer",
        body: "Changed output",
      }),
    ).rejects.toThrow(/immutable/i);
    const stored = (await t.run((ctx) => ctx.db.get(first.id as Id<"comments">)))!;
    const snapshot = await t.query(api.contentRevisions.get, { ...auth, id: stored.outputRevisionId });
    expect(snapshot.snapshot).toMatchObject({
      body: comment.body,
      runId: run._id,
      sourceRevisionIds: comment.sourceRevisionIds,
    });
    await t.mutation(api.agentSubscriptions.completeRun, completion);
    expect(await t.run((ctx) => ctx.db.query("comments").collect())).toHaveLength(1);
    await expect(t.mutation(api.agentSubscriptions.completeRun, completion)).rejects.toThrow(/running/i);
  });

  it("requires an exact no-action marker and rejects a contradictory output comment", async () => {
    const { t, run, comment } = await queuedRun();
    await t.mutation(api.agentSubscriptions.claimRun, { ...auth, id: run._id });
    const completion = {
      ...auth,
      id: run._id,
      status: "done",
      outcome: "no_action",
      sourceRevisionIds: comment.sourceRevisionIds,
    };
    for (const result of [undefined, "", "NO_ACTION because...", "no_action"]) {
      await expect(t.mutation(api.agentSubscriptions.completeRun, { ...completion, result })).rejects.toThrow(
        /no.action/i,
      );
    }
    await t.mutation(api.comments.post, comment);
    await expect(
      t.mutation(api.agentSubscriptions.completeRun, { ...completion, result: "NO_ACTION" }),
    ).rejects.toThrow(/no.action/i);
    expect((await t.run((ctx) => ctx.db.get(run._id)))?.status).toBe("running");
  });

  it("accepts explicit no action without inventing an output comment", async () => {
    const { t, run, comment } = await queuedRun();
    await t.mutation(api.agentSubscriptions.claimRun, { ...auth, id: run._id });
    await t.mutation(api.agentSubscriptions.completeRun, {
      ...auth,
      id: run._id,
      status: "done",
      outcome: "no_action",
      result: "NO_ACTION",
      sourceRevisionIds: comment.sourceRevisionIds,
    });
    expect((await t.run((ctx) => ctx.db.get(run._id)))?.outcome).toBe("no_action");
    expect(await t.run((ctx) => ctx.db.query("comments").collect())).toEqual([]);
  });

  it("uses configured Unicode character limits on actual output writes", async () => {
    const { t, run, comment } = await queuedRun('{"maxCommentChars":2}');
    await t.mutation(api.agentSubscriptions.claimRun, { ...auth, id: run._id });
    await expect(t.mutation(api.comments.post, { ...comment, body: "😀한a" })).rejects.toThrow(/limit/i);
    await t.mutation(api.comments.post, { ...comment, body: "😀한" });
  });

  it("does not allow a reaped run to emit output or overwrite its terminal error", async () => {
    const { t, run, comment } = await queuedRun();
    await t.mutation(api.agentSubscriptions.claimRun, { ...auth, id: run._id });
    await t.mutation(api.agentSubscriptions.reapStaleRuns, { ...auth, now: Date.now() + 31 * 60_000 });
    await expect(t.mutation(api.comments.post, comment)).rejects.toThrow(/running/i);
    await expect(
      t.mutation(api.agentSubscriptions.completeRun, {
        ...auth,
        id: run._id,
        status: "done",
        outcome: "no_action",
        result: "NO_ACTION",
        sourceRevisionIds: comment.sourceRevisionIds,
      }),
    ).rejects.toThrow(/running/i);
    expect((await t.run((ctx) => ctx.db.get(run._id)))?.status).toBe("error");
  });

  it("rejects unproven completion of a legacy claimed run", async () => {
    const { t, run } = await queuedRun();
    await t.run((ctx) =>
      ctx.db.patch(run._id, { status: "running", sourceRevisionIds: undefined, triggerSnapshot: undefined }),
    );
    await expect(
      t.mutation(api.agentSubscriptions.completeRun, { ...auth, id: run._id, status: "done", result: "done" }),
    ).rejects.toThrow(/outcome/i);
    await expect(
      t.mutation(api.agentSubscriptions.completeRun, { ...auth, id: run._id, status: "done", outcome: "commented" }),
    ).rejects.toThrow(/pinned/i);
    await t.mutation(api.agentSubscriptions.completeRun, {
      ...auth,
      id: run._id,
      status: "error",
      error: "Request a new pinned run",
    });
  });
});

describe("independent state and subscription boundaries", () => {
  it("counts an automatically pinned fork source against the final provenance limit", async () => {
    const t = withConvex();
    const sources: string[] = [];
    for (let index = 0; index < 32; index++) {
      const saved = await t.mutation(api.researchMemos.save, {
        ...auth,
        researchSlug: "p",
        memoSlug: `input-${index}`,
        content: "source",
      });
      sources.push(saved.revisionId);
    }
    await t.mutation(api.researchSections.save, {
      ...auth,
      researchSlug: "p",
      sectionSlug: "s",
      content: "fork source",
    });
    await expect(
      t.mutation(api.researchSections.fork, {
        ...auth,
        researchSlug: "p",
        sectionSlug: "s",
        toVenueSlug: "v",
        expectedSourceRevision: 1,
        sourceRevisionIds: sources,
      }),
    ).rejects.toThrow(/source revision list/i);
    expect(
      await t.query(api.researchSections.get, {
        ...auth,
        researchSlug: "p",
        sectionSlug: "s",
        venueSlug: "v",
      }),
    ).toBeNull();
    expect(
      await t.query(api.contentRevisions.head, {
        ...auth,
        kind: "section",
        researchSlug: "p",
        key: "s",
        venueSlug: "v",
      }),
    ).toBeNull();
  });

  it("returns workspace subscriptions through both accepted scope aliases", async () => {
    const t = withConvex();
    const workspace = await t.run((ctx) =>
      ctx.db.insert("workspaces", {
        slug: "home",
        name: "Home",
        ownerId: "owner",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const saved = await t.mutation(api.agentSubscriptions.subscribe, {
      ...auth,
      agentId: "reader",
      eventType: "entity.created",
      scope: "workspace",
      scopeId: "home",
    });
    for (const scopeId of ["home", workspace]) {
      const rows = await t.query(api.agentSubscriptions.listByScope, { ...auth, scope: "workspace", scopeId });
      expect(rows.map((row: { _id: string }) => row._id)).toEqual([saved.id]);
    }
  });

  it("rejects stale inference after human change without appending or replacing history", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "p", title: "P", kind: "own", actor: "human" });
    const run = await t.mutation(api.researchPhaseInfer.request, { ...auth, researchSlug: "p" });
    await t.mutation(api.researchPhaseInfer.claimRun, { ...auth, id: run.id });
    await t.mutation(api.research.advance, {
      ...auth,
      slug: "p",
      state: "literature",
      actor: "human",
      expectedStateVersion: 0,
    });
    const before = await t.run((ctx) => ctx.db.query("researchTimeline").collect());
    await expect(
      t.mutation(api.researchPhaseInfer.applyInferred, {
        ...auth,
        researchSlug: "p",
        runId: run.id,
        phase: "ideation",
        history: [{ state: "ideation", note: "stale evidence" }],
      }),
    ).rejects.toThrow(/stale/i);
    expect(await t.run((ctx) => ctx.db.query("researchTimeline").collect())).toEqual(before);
    expect((await t.run((ctx) => ctx.db.query("researchProjects").first()))?.phase).toBe("literature");
  });

  it("records a validated inference once and refuses a mismatching completion phase", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "p", title: "P", kind: "own", actor: "human" });
    const run = await t.mutation(api.researchPhaseInfer.request, { ...auth, researchSlug: "p" });
    await t.mutation(api.researchPhaseInfer.claimRun, { ...auth, id: run.id });
    const input = {
      ...auth,
      researchSlug: "p",
      runId: run.id,
      phase: "literature",
      history: [
        { state: "ideation", note: "known" },
        { state: "literature", note: "new" },
      ],
    };
    await t.mutation(api.researchPhaseInfer.applyInferred, input);
    const before = await t.run((ctx) => ctx.db.query("researchTimeline").collect());
    expect(before).toHaveLength(2);
    expect(before[0]).toMatchObject({ actor: "human", note: "registered" });
    expect(await t.mutation(api.researchPhaseInfer.applyInferred, input)).toMatchObject({
      changed: false,
      inserted: 0,
    });
    await expect(
      t.mutation(api.researchPhaseInfer.completeRun, {
        ...auth,
        id: run.id,
        status: "done",
        inferredPhase: "ideation",
      }),
    ).rejects.toThrow(/match/i);
    await t.mutation(api.researchPhaseInfer.completeRun, {
      ...auth,
      id: run.id,
      status: "done",
      inferredPhase: "literature",
    });
    expect(await t.run((ctx) => ctx.db.query("researchTimeline").collect())).toEqual(before);
  });

  it("does not label an unapplied legacy phase run successful", async () => {
    const t = withConvex();
    const id = await t.run((ctx) =>
      ctx.db.insert("researchPhaseRuns", { researchSlug: "p", status: "running", createdAt: 1 }),
    );
    await expect(
      t.mutation(api.researchPhaseInfer.completeRun, { ...auth, id, status: "done", inferredPhase: "literature" }),
    ).rejects.toThrow();
    await t.mutation(api.researchPhaseInfer.completeRun, {
      ...auth,
      id,
      status: "error",
      error: "Request a new pinned run",
    });
  });
});
