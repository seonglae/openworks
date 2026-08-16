import { describe, expect, it } from "vitest";
import { canTransition, initialState, nextStates, OWN_STATES, OWN_TRANSITIONS } from "@openworks/domain";
import type { Id } from "../_generated/dataModel";
import { api } from "../_generated/api";
import { CASCADE_BYTES, CASCADE_PAGE, CORPUS_SCAN, MAX_DOC_BYTES, READ_CAP } from "../research";
import { auth, withConvex } from "./harness.setup";

type Harness = ReturnType<typeof withConvex>;

async function projectIdBySlug(t: Harness, slug: string): Promise<Id<"researchProjects">> {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("researchProjects")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (!row) throw new Error(`no project seeded for slug ${slug}`);
    return row._id;
  });
}

async function phaseOf(t: Harness, slug: string): Promise<string> {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("researchProjects")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    return row?.phase ?? "";
  });
}

async function setPhase(t: Harness, id: Id<"researchProjects">, phase: string) {
  await t.run(async (ctx) => ctx.db.patch(id, { phase }));
}

async function timelineOf(t: Harness, slug: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("researchTimeline")
      .withIndex("by_research_at", (q) => q.eq("researchSlug", slug))
      .collect(),
  );
}

async function pendingRuns(t: Harness) {
  return await t.run(async (ctx) => ctx.db.query("agentRuns").collect());
}

async function seedSubscription(
  t: Harness,
  sub: {
    agentId: string;
    eventType: "entity.created" | "entity.updated" | "state.transitioned" | "comment.posted";
    scope: "global" | "project" | "workspace";
    scopeId?: string;
    targetType?: "research" | "memo" | "experiment";
    enabled?: boolean;
  },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("agentSubscriptions", {
      agentId: sub.agentId,
      eventType: sub.eventType,
      targetType: sub.targetType,
      scope: sub.scope,
      scopeId: sub.scopeId,
      enabled: sub.enabled ?? true,
      createdAt: 1,
      updatedAt: 1,
    }),
  );
}

describe("registering a project", () => {
  it("starts a new own-kind project at the state the domain FSM calls initial", async () => {
    const t = withConvex();
    const res = await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    expect(res.created).toBe(true);
    expect(res.phase).toBe(initialState("own"));
    expect(res.phase).toBe("ideation");
  });

  it("starts a new review-kind project at its own initial state, not the own-kind one", async () => {
    const t = withConvex();
    const res = await t.mutation(api.research.register, { ...auth, slug: "rev", title: "Rev", kind: "review" });
    expect(res.phase).toBe(initialState("review"));
    expect(res.phase).toBe("setup");
  });

  it("writes a registration entry into the timeline", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own", actor: "codex" });
    const entries = await timelineOf(t, "sae");
    expect(entries).toHaveLength(1);
    expect(entries[0].state).toBe("ideation");
    expect(entries[0].note).toBe("registered");
    expect(entries[0].actor).toBe("codex");
  });

  it("updates the existing row instead of creating a second project for the same slug", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    const second = await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE v2", kind: "own" });
    expect(second.created).toBe(false);
    const rows = await t.run(async (ctx) => ctx.db.query("researchProjects").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("SAE v2");
  });

  it("leaves an already-advanced project on its current phase when it is re-registered", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    await t.mutation(api.research.advance, { ...auth, slug: "sae", state: "literature" });
    const again = await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    expect(again.phase).toBe("literature");
    expect(await phaseOf(t, "sae")).toBe("literature");
  });

  it("adds no second timeline entry when a project is re-registered", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    expect(await timelineOf(t, "sae")).toHaveLength(1);
  });

  it("claims the project for the signed-in caller and makes it private by default", async () => {
    const t = withConvex();
    const owner = t.withIdentity({ subject: "user_owner" });
    await owner.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    const row = await t.run(async (ctx) => ctx.db.query("researchProjects").first());
    expect(row?.ownerId).toBe("user_owner");
    expect(row?.visibility).toBe("private");
  });

  it("gives the signed-in creator an owner membership", async () => {
    const t = withConvex();
    const owner = t.withIdentity({ subject: "user_owner" });
    await owner.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    const memberships = await t.run(async (ctx) => ctx.db.query("projectMemberships").collect());
    expect(memberships).toHaveLength(1);
    expect(memberships[0].userId).toBe("user_owner");
    expect(memberships[0].role).toBe("owner");
  });

  it("leaves a project unclaimed when the caller is signed out", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    const row = await t.run(async (ctx) => ctx.db.query("researchProjects").first());
    expect(row?.ownerId).toBeUndefined();
    expect(row?.visibility).toBeUndefined();
    expect(await t.run(async (ctx) => ctx.db.query("projectMemberships").collect())).toHaveLength(0);
  });

  it("refuses to let a stranger re-register someone else's project", async () => {
    const t = withConvex();
    const owner = t.withIdentity({ subject: "user_owner" });
    await owner.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    const stranger = t.withIdentity({ subject: "user_stranger" });
    await expect(
      stranger.mutation(api.research.register, { ...auth, slug: "sae", title: "Hijacked", kind: "own" }),
    ).rejects.toThrow(/forbidden/);
  });
});

describe("FSM enforcement on advance", () => {
  it("accepts a move along an edge the domain FSM declares", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    expect(canTransition("own", "ideation", "literature")).toBe(true);
    const res = await t.mutation(api.research.advance, { ...auth, slug: "sae", state: "literature" });
    expect(res.phase).toBe("literature");
    expect(await phaseOf(t, "sae")).toBe("literature");
  });

  it("rejects a move to a state that is real but not a successor of the current one", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    expect(canTransition("own", "ideation", "poc")).toBe(false);
    await expect(t.mutation(api.research.advance, { ...auth, slug: "sae", state: "poc" })).rejects.toThrow(
      /not allowed/,
    );
  });

  it("names the legal successors in the rejection message", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    await expect(t.mutation(api.research.advance, { ...auth, slug: "sae", state: "poc" })).rejects.toThrow(
      new RegExp(`\\[${nextStates("own", "ideation").join(", ")}\\]`),
    );
  });

  it("leaves the phase and the timeline untouched when a move is rejected", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    await expect(t.mutation(api.research.advance, { ...auth, slug: "sae", state: "poc" })).rejects.toThrow();
    expect(await phaseOf(t, "sae")).toBe("ideation");
    expect(await timelineOf(t, "sae")).toHaveLength(1);
  });

  it("lets force push a project across an edge the FSM does not declare", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    const res = await t.mutation(api.research.advance, { ...auth, slug: "sae", state: "poc", force: true });
    expect(res.phase).toBe("poc");
    expect(await phaseOf(t, "sae")).toBe("poc");
  });

  it("still refuses a state belonging to the other kind's vocabulary even under force", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    // `lit_review` exists only in REVIEW_STATES, and the validity check runs
    // before the force escape hatch, so force cannot smuggle it in.
    await expect(
      t.mutation(api.research.advance, { ...auth, slug: "sae", state: "lit_review", force: true }),
    ).rejects.toThrow(/invalid state/);
    expect(await phaseOf(t, "sae")).toBe("ideation");
  });

  it("refuses an entirely unknown state name", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    await expect(t.mutation(api.research.advance, { ...auth, slug: "sae", state: "banana" })).rejects.toThrow(
      /invalid state/,
    );
  });

  it("refuses to advance a slug that was never registered", async () => {
    const t = withConvex();
    await expect(t.mutation(api.research.advance, { ...auth, slug: "ghost", state: "literature" })).rejects.toThrow(
      /unknown project/,
    );
  });

  it("answers identically to the domain FSM for every ordered pair of own-kind states", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sweep", title: "Sweep", kind: "own" });
    const id = await projectIdBySlug(t, "sweep");
    for (const from of OWN_STATES) {
      for (const to of OWN_STATES) {
        await setPhase(t, id, from);
        const call = t.mutation(api.research.advance, { ...auth, slug: "sweep", state: to });
        if (canTransition("own", from, to)) {
          const res = await call;
          expect(res.phase).toBe(to);
        } else {
          await expect(call).rejects.toThrow();
        }
      }
    }
  });

  it("records every accepted move in the timeline", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    await t.mutation(api.research.advance, { ...auth, slug: "sae", state: "literature", note: "read 12 papers" });
    await t.mutation(api.research.advance, { ...auth, slug: "sae", state: "poc", artifactRef: "poc.ipynb" });
    const entries = await timelineOf(t, "sae");
    expect(entries.map((e) => e.state)).toEqual(["ideation", "literature", "poc"]);
    expect(entries[1].note).toBe("read 12 papers");
    expect(entries[2].artifactRef).toBe("poc.ipynb");
  });

  it("uses the review vocabulary for a review-kind project", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "rev", title: "Rev", kind: "review" });
    const ok = await t.mutation(api.research.advance, { ...auth, slug: "rev", state: "lit_review" });
    expect(ok.phase).toBe("lit_review");
    // `poc` is an own-kind state, so it is not merely unreachable here, it does
    // not exist for this project's kind.
    await expect(t.mutation(api.research.advance, { ...auth, slug: "rev", state: "poc" })).rejects.toThrow(
      /invalid state/,
    );
  });

  it("keeps the terminal own-kind state terminal", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    const id = await projectIdBySlug(t, "sae");
    await setPhase(t, id, "poster");
    expect(OWN_TRANSITIONS.poster).toEqual([]);
    await expect(t.mutation(api.research.advance, { ...auth, slug: "sae", state: "takeaway" })).rejects.toThrow(
      /not allowed/,
    );
  });
});

describe("trigger fan-out on a transition", () => {
  it("queues a pending run for a global subscriber", async () => {
    const t = withConvex();
    await seedSubscription(t, { agentId: "gemini", eventType: "state.transitioned", scope: "global" });
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    await t.mutation(api.research.advance, { ...auth, slug: "sae", state: "literature" });
    const runs = await pendingRuns(t);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("pending");
    expect(runs[0].agentId).toBe("gemini");
    expect(runs[0].triggerType).toBe("state.transitioned");
    expect(runs[0].triggerEntityKey).toBe("sae");
    expect(runs[0].researchSlug).toBe("sae");
  });

  it("queues nothing for a project-scoped subscriber watching a different project", async () => {
    const t = withConvex();
    await seedSubscription(t, {
      agentId: "gemini",
      eventType: "state.transitioned",
      scope: "project",
      scopeId: "other",
    });
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    await t.mutation(api.research.advance, { ...auth, slug: "sae", state: "literature" });
    expect(await pendingRuns(t)).toHaveLength(0);
  });

  it("queues a run for a project-scoped subscriber watching that project", async () => {
    const t = withConvex();
    await seedSubscription(t, { agentId: "codex", eventType: "state.transitioned", scope: "project", scopeId: "sae" });
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    await t.mutation(api.research.advance, { ...auth, slug: "sae", state: "literature" });
    expect(await pendingRuns(t)).toHaveLength(1);
  });

  it("ignores a disabled subscription", async () => {
    const t = withConvex();
    await seedSubscription(t, { agentId: "gemini", eventType: "state.transitioned", scope: "global", enabled: false });
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    await t.mutation(api.research.advance, { ...auth, slug: "sae", state: "literature" });
    expect(await pendingRuns(t)).toHaveLength(0);
  });

  it("ignores a subscription pinned to a different entity type", async () => {
    const t = withConvex();
    await seedSubscription(t, {
      agentId: "gemini",
      eventType: "state.transitioned",
      scope: "global",
      targetType: "memo",
    });
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    await t.mutation(api.research.advance, { ...auth, slug: "sae", state: "literature" });
    expect(await pendingRuns(t)).toHaveLength(0);
  });

  it("ignores a subscription bound to a different event", async () => {
    const t = withConvex();
    await seedSubscription(t, { agentId: "gemini", eventType: "entity.created", scope: "global" });
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    await t.mutation(api.research.advance, { ...auth, slug: "sae", state: "literature" });
    expect(await pendingRuns(t)).toHaveLength(0);
  });

  it("queues one run per matching subscriber", async () => {
    const t = withConvex();
    await seedSubscription(t, { agentId: "gemini", eventType: "state.transitioned", scope: "global" });
    await seedSubscription(t, { agentId: "codex", eventType: "state.transitioned", scope: "project", scopeId: "sae" });
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    await t.mutation(api.research.advance, { ...auth, slug: "sae", state: "literature" });
    const runs = await pendingRuns(t);
    expect(runs.map((r) => r.agentId).sort()).toEqual(["codex", "gemini"]);
  });

  it("queues nothing when registration creates a project, because only transitions fan out", async () => {
    const t = withConvex();
    await seedSubscription(t, { agentId: "gemini", eventType: "entity.created", scope: "global" });
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    expect(await pendingRuns(t)).toHaveLength(0);
  });
});

describe("setting a phase directly from the UI", () => {
  it("refuses a phase that is not in the project kind's vocabulary", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    const id = await projectIdBySlug(t, "sae");
    await expect(t.mutation(api.research.updatePhase, { ...auth, id, phase: "banana" })).rejects.toThrow(
      /invalid state/,
    );
    expect(await phaseOf(t, "sae")).toBe("ideation");
  });

  it("refuses a state that belongs to the other kind's vocabulary", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    const id = await projectIdBySlug(t, "sae");
    await expect(t.mutation(api.research.updatePhase, { ...auth, id, phase: "lit_review" })).rejects.toThrow(
      /invalid state/,
    );
    expect(await phaseOf(t, "sae")).toBe("ideation");
  });

  it("allows a jump to any valid state, because the graph is a direct-set surface", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    const id = await projectIdBySlug(t, "sae");
    // Clicking a far node is the intended interaction, so adjacency is not
    // enforced here even though `advance` refuses the same move.
    expect(canTransition("own", "ideation", "poster")).toBe(false);
    const res = await t.mutation(api.research.updatePhase, { ...auth, id, phase: "poster" });
    expect(res.phase).toBe("poster");
    expect(await phaseOf(t, "sae")).toBe("poster");
  });

  it("records the change in the timeline, like advance does", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    const id = await projectIdBySlug(t, "sae");
    await t.mutation(api.research.updatePhase, { ...auth, id, phase: "literature" });
    const entries = await timelineOf(t, "sae");
    expect(entries.map((e) => e.state)).toEqual(["ideation", "literature"]);
  });

  it("writes no timeline entry when the phase is rejected", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    const id = await projectIdBySlug(t, "sae");
    await expect(t.mutation(api.research.updatePhase, { ...auth, id, phase: "banana" })).rejects.toThrow();
    expect(await timelineOf(t, "sae")).toHaveLength(1);
  });

  it("queues an agent run, like advance does", async () => {
    const t = withConvex();
    await seedSubscription(t, { agentId: "gemini", eventType: "state.transitioned", scope: "global" });
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    const id = await projectIdBySlug(t, "sae");
    await t.mutation(api.research.updatePhase, { ...auth, id, phase: "literature" });
    const runs = await pendingRuns(t);
    expect(runs).toHaveLength(1);
    expect(runs[0].triggerType).toBe("state.transitioned");
    expect(runs[0].researchSlug).toBe("sae");
  });

  it("fails for a project that no longer exists", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    const id = await projectIdBySlug(t, "sae");
    await t.run(async (ctx) => ctx.db.delete(id));
    await expect(t.mutation(api.research.updatePhase, { ...auth, id, phase: "literature" })).rejects.toThrow(
      /project not found/,
    );
  });

  it("refuses a phase that is not in the vocabulary through upsert", async () => {
    const t = withConvex();
    await expect(
      t.mutation(api.research.upsert, { ...auth, slug: "sae", title: "SAE", kind: "own", phase: "banana" }),
    ).rejects.toThrow(/invalid state/);
    expect(await t.run(async (ctx) => ctx.db.query("researchProjects").collect())).toHaveLength(0);
  });

  it("refuses the other kind's vocabulary through upsert", async () => {
    const t = withConvex();
    await expect(
      t.mutation(api.research.upsert, { ...auth, slug: "rev", title: "Rev", kind: "review", phase: "poc" }),
    ).rejects.toThrow(/invalid state/);
  });

  it("still edits a row whose stored phase left the vocabulary, when the edit carries that phase back", async () => {
    const t = withConvex();
    // researchChecklists:migrateLegacyPhases rewrites phases without looking at
    // kind, so a review-kind project in `submitted` ends up holding
    // `submit_main`, which REVIEW_STATES does not have. The browser's title
    // edit resends that phase verbatim, and it must not be rejected.
    await t.run(async (ctx) =>
      ctx.db.insert("researchProjects", {
        slug: "rev",
        title: "Old",
        kind: "review",
        phase: "submit_main",
        updatedAt: 1,
      }),
    );
    await t.mutation(api.research.upsert, {
      ...auth,
      slug: "rev",
      title: "New",
      kind: "review",
      phase: "submit_main",
    });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("researchProjects")
        .withIndex("by_slug", (q) => q.eq("slug", "rev"))
        .first(),
    );
    expect(row?.title).toBe("New");
    expect(row?.phase).toBe("submit_main");
  });

  it("refuses a move to a different invalid phase even on a row already outside the vocabulary", async () => {
    const t = withConvex();
    await t.run(async (ctx) =>
      ctx.db.insert("researchProjects", {
        slug: "rev",
        title: "Rev",
        kind: "review",
        phase: "submit_main",
        updatedAt: 1,
      }),
    );
    await expect(
      t.mutation(api.research.upsert, { ...auth, slug: "rev", title: "Rev", kind: "review", phase: "banana" }),
    ).rejects.toThrow(/invalid state/);
    expect(await phaseOf(t, "rev")).toBe("submit_main");
  });
});

describe("upsert by slug", () => {
  it("inserts a row the first time a slug is seen", async () => {
    const t = withConvex();
    const id = await t.mutation(api.research.upsert, {
      ...auth,
      slug: "sae",
      title: "SAE",
      kind: "own",
      phase: "ideation",
      keywords: ["sparse", "autoencoder"],
    });
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.keywords).toEqual(["sparse", "autoencoder"]);
  });

  it("returns the same id and keeps a single row when the slug repeats", async () => {
    const t = withConvex();
    const first = await t.mutation(api.research.upsert, {
      ...auth,
      slug: "sae",
      title: "SAE",
      kind: "own",
      phase: "ideation",
    });
    const second = await t.mutation(api.research.upsert, {
      ...auth,
      slug: "sae",
      title: "SAE renamed",
      kind: "own",
      phase: "literature",
    });
    expect(second).toBe(first);
    const rows = await t.run(async (ctx) => ctx.db.query("researchProjects").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("SAE renamed");
    expect(rows[0].phase).toBe("literature");
  });

  it("writes no timeline entry, unlike register", async () => {
    const t = withConvex();
    await t.mutation(api.research.upsert, { ...auth, slug: "sae", title: "SAE", kind: "own", phase: "ideation" });
    expect(await timelineOf(t, "sae")).toHaveLength(0);
  });
});

describe("listing projects", () => {
  it("returns only the requested kind, most recently updated first", async () => {
    const t = withConvex();
    await t.run(async (ctx) => {
      await ctx.db.insert("researchProjects", { slug: "a", title: "A", kind: "own", phase: "ideation", updatedAt: 10 });
      await ctx.db.insert("researchProjects", { slug: "b", title: "B", kind: "own", phase: "ideation", updatedAt: 30 });
      await ctx.db.insert("researchProjects", { slug: "c", title: "C", kind: "review", phase: "setup", updatedAt: 20 });
    });
    const own = await t.query(api.research.listByKind, { ...auth, kind: "own" });
    expect(own.map((p) => p.slug)).toEqual(["b", "a"]);
  });

  it("returns every kind as a compact summary row when no kind is given", async () => {
    const t = withConvex();
    await t.run(async (ctx) => {
      await ctx.db.insert("researchProjects", { slug: "a", title: "A", kind: "own", phase: "ideation", updatedAt: 10 });
      await ctx.db.insert("researchProjects", { slug: "c", title: "C", kind: "review", phase: "setup", updatedAt: 20 });
    });
    const all = await t.query(api.research.listAllProjects, { ...auth });
    expect(all.map((p) => p.slug)).toEqual(["c", "a"]);
    expect(Object.keys(all[0]).sort()).toEqual(["kind", "phase", "slug", "title", "updatedAt"]);
  });

  it("narrows to one kind when a kind is given", async () => {
    const t = withConvex();
    await t.run(async (ctx) => {
      await ctx.db.insert("researchProjects", { slug: "a", title: "A", kind: "own", phase: "ideation", updatedAt: 10 });
      await ctx.db.insert("researchProjects", { slug: "c", title: "C", kind: "review", phase: "setup", updatedAt: 20 });
    });
    const reviews = await t.query(api.research.listAllProjects, { ...auth, kind: "review" });
    expect(reviews.map((p) => p.slug)).toEqual(["c"]);
  });
});

describe("removing a project", () => {
  it("deletes the project row", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    const id = await projectIdBySlug(t, "sae");
    await t.mutation(api.research.remove, { ...auth, id });
    expect(await t.run(async (ctx) => ctx.db.get(id))).toBeNull();
  });

  it("takes the project's timeline with it, so a re-registered slug starts clean", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    const id = await projectIdBySlug(t, "sae");
    await t.mutation(api.research.remove, { ...auth, id });
    expect(await timelineOf(t, "sae")).toHaveLength(0);
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE again", kind: "own" });
    expect(await timelineOf(t, "sae")).toHaveLength(1);
  });

  it("empties every table scoped to the project", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    const id = await projectIdBySlug(t, "sae");
    await t.mutation(api.researchMemos.save, {
      ...auth,
      researchSlug: "sae",
      memoSlug: "m1",
      title: "M",
      content: "c",
    });
    await t.mutation(api.researchExperiments.save, { ...auth, researchSlug: "sae", expSlug: "e1", name: "E" });
    await t.mutation(api.comments.post, {
      ...auth,
      researchSlug: "sae",
      targetType: "research",
      targetKey: "sae",
      authorType: "agent",
      authorId: "codex",
      body: "b",
    });
    await t.mutation(api.research.remove, { ...auth, id });
    const left = await t.run(async (ctx) => ({
      memos: (await ctx.db.query("researchMemos").collect()).length,
      experiments: (await ctx.db.query("researchExperiments").collect()).length,
      comments: (await ctx.db.query("comments").collect()).length,
    }));
    expect(left).toEqual({ memos: 0, experiments: 0, comments: 0 });
  });

  // The bound is the point: a cascade that always restarts in the same order
  // and cannot afford its first slice would abort identically on every retry,
  // leaving the project permanently undeletable.
  it("stops at the row budget, keeps the project, and finishes when the caller loops", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    const id = await projectIdBySlug(t, "sae");
    for (let i = 0; i < 5; i++) {
      await t.mutation(api.researchMemos.save, {
        ...auth,
        researchSlug: "sae",
        memoSlug: `m${i}`,
        title: "M",
        content: "c",
      });
    }
    const first = await t.mutation(api.research.remove, { ...auth, id, limit: 2 });
    expect(first.done).toBe(false);
    expect(first.deleted).toBe(2);
    // Still deletable, rather than children orphaned where nothing reaches them.
    expect(await t.run(async (ctx) => ctx.db.get(id))).not.toBeNull();

    let guard = 0;
    let done = first.done;
    while (!done && guard++ < 20) done = (await t.mutation(api.research.remove, { ...auth, id, limit: 2 })).done;
    expect(done).toBe(true);
    expect(await t.run(async (ctx) => ctx.db.get(id))).toBeNull();
    expect(await t.run(async (ctx) => (await ctx.db.query("researchMemos").collect()).length)).toBe(0);
  });

  // The budget is only re-checked between pages, so a whole page lands on top of
  // it. This is the arithmetic that a comment used to assert and nothing
  // checked; it was wrong, because 13 of the 19 steps ran at page 50 and three
  // of those tables hold unbounded text.
  it("can afford a whole page of maximum-size documents on top of a spent budget", async () => {
    expect(CASCADE_BYTES + CASCADE_PAGE * MAX_DOC_BYTES).toBeLessThan(READ_CAP);
  });

  it("stops on the byte budget even when the row budget is untouched", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    const id = await projectIdBySlug(t, "sae");
    // Six memos of 1.2MB each: over CASCADE_BYTES in total, under it individually.
    const big = "x".repeat(1_200_000);
    for (let i = 0; i < 6; i++) {
      await t.mutation(api.researchMemos.save, {
        ...auth,
        researchSlug: "sae",
        memoSlug: `m${i}`,
        title: "M",
        content: big,
      });
    }
    const first = await t.mutation(api.research.remove, { ...auth, id });
    // No `limit`, so only the byte budget can stop it.
    expect(first.done).toBe(false);
    expect(first.remainingIn).toBe("researchMemos");
    expect(await t.run(async (ctx) => (await ctx.db.query("researchMemos").collect()).length)).toBeGreaterThan(0);
    expect(await t.run(async (ctx) => ctx.db.get(id))).not.toBeNull();

    let guard = 0;
    let done = first.done;
    while (!done && guard++ < 20) done = (await t.mutation(api.research.remove, { ...auth, id })).done;
    expect(done).toBe(true);
    expect(await t.run(async (ctx) => ctx.db.get(id))).toBeNull();
  });

  // Hangul is one unit of `.length` and three bytes on the wire, so measuring
  // the budget with `.length` would admit ~3x what it accounts for.
  it("counts the budget in UTF-8 bytes, not string length", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    const id = await projectIdBySlug(t, "sae");
    // 2.4M Hangul syllables = 2.4M `.length` but 7.2MB of UTF-8, so this is
    // under the budget by the wrong measure and over it by the right one.
    const hangul = "\uAC00".repeat(2_400_000);
    for (let i = 0; i < 2; i++) {
      await t.mutation(api.researchMemos.save, {
        ...auth,
        researchSlug: "sae",
        memoSlug: `m${i}`,
        title: "M",
        content: hangul,
      });
    }
    expect((await t.mutation(api.research.remove, { ...auth, id })).done).toBe(false);
  });

  it("treats a NaN limit as no limit rather than reporting work forever", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    const id = await projectIdBySlug(t, "sae");
    const res = await t.mutation(api.research.remove, { ...auth, id, limit: Number.NaN });
    expect(res.done).toBe(true);
    expect(await t.run(async (ctx) => ctx.db.get(id))).toBeNull();
  });

  it("is a no-op on a project that is already gone, so the caller's loop terminates", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    const id = await projectIdBySlug(t, "sae");
    await t.mutation(api.research.remove, { ...auth, id });
    expect(await t.mutation(api.research.remove, { ...auth, id })).toEqual({
      done: true,
      deleted: 0,
      remainingIn: null,
    });
  });
});

describe("project visibility", () => {
  it("stores the new visibility and echoes it back", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    const id = await projectIdBySlug(t, "sae");
    const res = await t.mutation(api.research.setVisibility, { ...auth, id, visibility: "public" });
    expect(res.visibility).toBe("public");
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.visibility).toBe("public");
  });

  it("fails for a project that no longer exists", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    const id = await projectIdBySlug(t, "sae");
    await t.run(async (ctx) => ctx.db.delete(id));
    await expect(t.mutation(api.research.setVisibility, { ...auth, id, visibility: "public" })).rejects.toThrow(
      /project not found/,
    );
  });

  it("lets a signed-out caller through while no auth issuer is configured", async () => {
    const t = withConvex();
    const id = await t.run(async (ctx) =>
      ctx.db.insert("researchProjects", {
        slug: "owned",
        title: "Owned",
        kind: "own",
        phase: "ideation",
        ownerId: "user_owner",
        visibility: "private",
        updatedAt: 1,
      }),
    );
    // The ownership gate is deliberately skipped on a single-user deployment;
    // without it every edit would be refused for lack of a signed-in user.
    const res = await t.mutation(api.research.setVisibility, { ...auth, id, visibility: "unlisted" });
    expect(res.visibility).toBe("unlisted");
  });

  it("refuses a non-owner once an auth issuer is configured", async () => {
    const t = withConvex();
    const id = await t.run(async (ctx) =>
      ctx.db.insert("researchProjects", {
        slug: "owned",
        title: "Owned",
        kind: "own",
        phase: "ideation",
        ownerId: "user_owner",
        visibility: "private",
        updatedAt: 1,
      }),
    );
    const previous = process.env.CLERK_ISSUER_URL;
    process.env.CLERK_ISSUER_URL = "https://example.clerk.accounts.dev";
    try {
      const stranger = t.withIdentity({ subject: "user_stranger" });
      await expect(
        stranger.mutation(api.research.setVisibility, { ...auth, id, visibility: "public" }),
      ).rejects.toThrow(/forbidden/);
    } finally {
      if (previous === undefined) delete process.env.CLERK_ISSUER_URL;
      else process.env.CLERK_ISSUER_URL = previous;
    }
  });
});

describe("artifact logging", () => {
  it("appends a timeline entry at the phase the project is already in", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    await t.mutation(api.research.advance, { ...auth, slug: "sae", state: "literature" });
    const res = await t.mutation(api.research.logArtifact, {
      ...auth,
      slug: "sae",
      artifactRef: "notes/lit.md",
      note: "survey draft",
    });
    expect(res.phase).toBe("literature");
    expect(await phaseOf(t, "sae")).toBe("literature");
    const entries = await timelineOf(t, "sae");
    expect(entries).toHaveLength(3);
    expect(entries[2].artifactRef).toBe("notes/lit.md");
    expect(entries[2].state).toBe("literature");
  });

  it("fails for a slug that was never registered", async () => {
    const t = withConvex();
    await expect(t.mutation(api.research.logArtifact, { ...auth, slug: "ghost", artifactRef: "x" })).rejects.toThrow(
      /unknown project/,
    );
  });
});

describe("state info", () => {
  it("reports the successors the domain FSM declares for the current phase", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    await t.mutation(api.research.advance, { ...auth, slug: "sae", state: "literature" });
    const info = await t.query(api.research.getStateInfo, { ...auth, slug: "sae" });
    expect(info?.phase).toBe("literature");
    expect(info?.next).toEqual(nextStates("own", "literature"));
    expect(info?.allStates).toEqual([...OWN_STATES]);
  });

  it("is null for a slug that was never registered", async () => {
    const t = withConvex();
    expect(await t.query(api.research.getStateInfo, { ...auth, slug: "ghost" })).toBeNull();
  });
});

describe("timeline reads", () => {
  it("comes back newest first", async () => {
    const t = withConvex();
    await t.run(async (ctx) => {
      await ctx.db.insert("researchTimeline", { researchSlug: "sae", state: "ideation", at: 10 });
      await ctx.db.insert("researchTimeline", { researchSlug: "sae", state: "literature", at: 20 });
      await ctx.db.insert("researchTimeline", { researchSlug: "sae", state: "poc", at: 30 });
    });
    const entries = await t.query(api.research.getTimeline, { ...auth, slug: "sae" });
    expect(entries.map((e) => e.state)).toEqual(["poc", "literature", "ideation"]);
  });

  it("takes the newest entries when a limit is given", async () => {
    const t = withConvex();
    await t.run(async (ctx) => {
      await ctx.db.insert("researchTimeline", { researchSlug: "sae", state: "ideation", at: 10 });
      await ctx.db.insert("researchTimeline", { researchSlug: "sae", state: "literature", at: 20 });
      await ctx.db.insert("researchTimeline", { researchSlug: "sae", state: "poc", at: 30 });
    });
    const entries = await t.query(api.research.getTimeline, { ...auth, slug: "sae", limit: 2 });
    expect(entries.map((e) => e.state)).toEqual(["poc", "literature"]);
  });

  it("is scoped to one project", async () => {
    const t = withConvex();
    await t.run(async (ctx) => {
      await ctx.db.insert("researchTimeline", { researchSlug: "sae", state: "ideation", at: 10 });
      await ctx.db.insert("researchTimeline", { researchSlug: "other", state: "ideation", at: 20 });
    });
    const entries = await t.query(api.research.getTimeline, { ...auth, slug: "sae" });
    expect(entries).toHaveLength(1);
  });
});

// The relevance queries score jaccard overlap of >2-char lowercase tokens, so
// the fixtures below are written so the shared vocabulary is unmistakable.
async function seedJobWithSummary(
  t: Harness,
  opts: { url: string; type: "paper" | "article" | "newsletter"; title: string; summary: string; keywords: string[] },
) {
  return await t.run(async (ctx) => {
    const jobId = await ctx.db.insert("jobs", {
      url: opts.url,
      type: opts.type,
      status: "done",
      archived: false,
      createdAt: 1,
    });
    await ctx.db.insert("summaries", {
      jobId,
      index: 0,
      title: opts.title,
      category: "research",
      summary: opts.summary,
      keywords: opts.keywords,
      url: opts.url,
    });
    return jobId;
  });
}

describe("jobs related to a project", () => {
  it("returns a job whose summary shares the project's vocabulary, tagged with the job type", async () => {
    const t = withConvex();
    const researchId = await t.run(async (ctx) =>
      ctx.db.insert("researchProjects", {
        slug: "sae",
        title: "sparse autoencoder interpretability",
        kind: "own",
        phase: "ideation",
        updatedAt: 1,
      }),
    );
    const jobId = await seedJobWithSummary(t, {
      url: "https://example.com/sae",
      type: "paper",
      title: "sparse autoencoder scaling",
      summary: "sparse autoencoder interpretability results",
      keywords: ["interpretability"],
    });
    const related = await t.query(api.research.getRelatedJobs, { ...auth, researchId });
    expect(related).toHaveLength(1);
    expect(related[0].jobId).toBe(jobId);
    expect(related[0].type).toBe("paper");
    expect(related[0].score).toBeGreaterThan(0.02);
  });

  it("drops a job whose summary shares no vocabulary with the project", async () => {
    const t = withConvex();
    const researchId = await t.run(async (ctx) =>
      ctx.db.insert("researchProjects", {
        slug: "sae",
        title: "sparse autoencoder interpretability",
        kind: "own",
        phase: "ideation",
        updatedAt: 1,
      }),
    );
    await seedJobWithSummary(t, {
      url: "https://example.com/bread",
      type: "article",
      title: "sourdough bread baking",
      summary: "overnight fermentation schedules",
      keywords: ["baking"],
    });
    expect(await t.query(api.research.getRelatedJobs, { ...auth, researchId })).toEqual([]);
  });

  it("returns nothing when the project's text yields no tokens longer than two characters", async () => {
    const t = withConvex();
    const researchId = await t.run(async (ctx) =>
      ctx.db.insert("researchProjects", { slug: "ai", title: "ai ml", kind: "own", phase: "ideation", updatedAt: 1 }),
    );
    await seedJobWithSummary(t, {
      url: "https://example.com/sae",
      type: "paper",
      title: "sparse autoencoder scaling",
      summary: "sparse autoencoder interpretability results",
      keywords: ["interpretability"],
    });
    expect(await t.query(api.research.getRelatedJobs, { ...auth, researchId })).toEqual([]);
  });

  it("returns nothing for a project id that no longer resolves", async () => {
    const t = withConvex();
    const researchId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("researchProjects", {
        slug: "gone",
        title: "sparse autoencoder",
        kind: "own",
        phase: "ideation",
        updatedAt: 1,
      });
      await ctx.db.delete(id);
      return id;
    });
    expect(await t.query(api.research.getRelatedJobs, { ...auth, researchId })).toEqual([]);
  });

  it("ranks the better-matching job first and honours the limit", async () => {
    const t = withConvex();
    const researchId = await t.run(async (ctx) =>
      ctx.db.insert("researchProjects", {
        slug: "sae",
        title: "sparse autoencoder interpretability",
        kind: "own",
        phase: "ideation",
        updatedAt: 1,
      }),
    );
    await seedJobWithSummary(t, {
      url: "https://example.com/weak",
      type: "newsletter",
      title: "interpretability roundup",
      summary: "assorted machine learning links from across the week",
      keywords: ["links", "roundup", "weekly", "assorted"],
    });
    const strongId = await seedJobWithSummary(t, {
      url: "https://example.com/strong",
      type: "paper",
      title: "sparse autoencoder interpretability",
      summary: "sparse autoencoder interpretability",
      keywords: [],
    });
    const all = await t.query(api.research.getRelatedJobs, { ...auth, researchId });
    expect(all).toHaveLength(2);
    expect(all[0].jobId).toBe(strongId);
    const capped = await t.query(api.research.getRelatedJobs, { ...auth, researchId, limit: 1 });
    expect(capped).toHaveLength(1);
    expect(capped[0].jobId).toBe(strongId);
  });

  it("scores a job by its best-matching summary, not by whichever comes first", async () => {
    const t = withConvex();
    const researchId = await t.run(async (ctx) =>
      ctx.db.insert("researchProjects", {
        slug: "sae",
        title: "sparse autoencoder interpretability",
        kind: "own",
        phase: "ideation",
        updatedAt: 1,
      }),
    );
    // A newsletter carries one summary per item, and the matching item is
    // rarely the one scored first.
    //
    // The decoy has to clear the 0.02 cutoff, or it never enters the map and
    // the tie-break rule is never exercised at all. It shares "sparse" with the
    // project (1/5 = 0.2) against the exact match's 1.0. It is also inserted
    // LAST, because the scan runs .order("desc"): newest first, so the decoy is
    // what a first-sighting-wins rule would keep.
    const jobId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("jobs", {
        url: "https://example.com/nl",
        type: "newsletter",
        status: "done",
        archived: false,
        createdAt: 1,
      });
      await ctx.db.insert("summaries", {
        jobId: id,
        index: 1,
        title: "sparse autoencoder interpretability",
        category: "research",
        summary: "sparse autoencoder interpretability",
        keywords: [],
        url: "https://example.com/nl#2",
      });
      await ctx.db.insert("summaries", {
        jobId: id,
        index: 0,
        title: "sparse retrieval baselines",
        category: "research",
        summary: "sparse retrieval baselines",
        keywords: [],
        url: "https://example.com/nl#1",
      });
      return id;
    });
    const related = await t.query(api.research.getRelatedJobs, { ...auth, researchId });
    expect(related).toHaveLength(1);
    expect(related[0].jobId).toBe(jobId);
    // The row describes the item that actually matched, not the first one.
    expect(related[0].title).toBe("sparse autoencoder interpretability");
  });

  // The scan is bounded because an unbounded collect() over this table is what
  // made the panel throw in production, and it reads newest-first because that
  // is the half of the corpus worth scoring. Both halves are pinned here: the
  // direction was previously load-bearing for another test and asserted by
  // nothing.
  it("scans the newest summaries only, and stops at the corpus bound", async () => {
    const t = withConvex();
    const researchId = await t.run(async (ctx) =>
      ctx.db.insert("researchProjects", {
        slug: "sae",
        title: "sparse autoencoder interpretability",
        kind: "own",
        phase: "ideation",
        updatedAt: 1,
      }),
    );
    const oldJobId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("jobs", {
        url: "https://example.com/old",
        type: "newsletter",
        status: "done",
        archived: false,
        createdAt: 1,
      });
      // Inserted first, so .order("desc") reaches it last: a dead-on match that
      // only an unbounded or ascending scan would ever see.
      await ctx.db.insert("summaries", {
        jobId: id,
        index: 0,
        title: "sparse autoencoder interpretability",
        category: "research",
        summary: "sparse autoencoder interpretability",
        keywords: [],
        url: "https://example.com/old#1",
      });
      return id;
    });
    // Push it past the bound with newer, unrelated rows.
    await t.run(async (ctx) => {
      const filler = await ctx.db.insert("jobs", {
        url: "https://example.com/filler",
        type: "newsletter",
        status: "done",
        archived: false,
        createdAt: 2,
      });
      for (let i = 0; i < CORPUS_SCAN; i++) {
        await ctx.db.insert("summaries", {
          jobId: filler,
          index: i,
          title: "sourdough bread baking",
          category: "food",
          summary: "overnight fermentation schedules",
          keywords: ["baking"],
          url: `https://example.com/filler#${i}`,
        });
      }
    });
    const related = await t.query(api.research.getRelatedJobs, { ...auth, researchId });
    expect(related.map((r) => r.jobId)).not.toContain(oldJobId);
  });

  it("counts a job once even when several of its summaries clear the threshold", async () => {
    const t = withConvex();
    const researchId = await t.run(async (ctx) =>
      ctx.db.insert("researchProjects", {
        slug: "sae",
        title: "sparse autoencoder interpretability",
        kind: "own",
        phase: "ideation",
        updatedAt: 1,
      }),
    );
    await t.run(async (ctx) => {
      const id = await ctx.db.insert("jobs", {
        url: "https://example.com/nl",
        type: "newsletter",
        status: "done",
        archived: false,
        createdAt: 1,
      });
      await ctx.db.insert("summaries", {
        jobId: id,
        index: 0,
        title: "sparse autoencoder scaling",
        category: "research",
        summary: "sparse autoencoder results",
        keywords: [],
        url: "https://example.com/nl#1",
      });
      await ctx.db.insert("summaries", {
        jobId: id,
        index: 1,
        title: "sparse autoencoder interpretability",
        category: "research",
        summary: "sparse autoencoder interpretability",
        keywords: [],
        url: "https://example.com/nl#2",
      });
    });
    const related = await t.query(api.research.getRelatedJobs, { ...auth, researchId });
    expect(related).toHaveLength(1);
    expect(related[0].title).toBe("sparse autoencoder interpretability");
  });

  // Under the corpus threshold the scorer is deliberately ASCII-only, so Korean
  // alone does not match. Frequency is what makes Korean safe to score, and a
  // corpus this small has no frequency signal: every token looks equally
  // common. The test below seeds a real corpus and shows Korean matching turn on.
  it("does not match a Korean-only summary while the corpus is too small to weigh", async () => {
    const t = withConvex();
    const researchId = await t.run(async (ctx) =>
      ctx.db.insert("researchProjects", {
        slug: "sae-ko",
        title: "\uC624\uD1A0\uC778\uCF54\uB354 \uD574\uC11D\uAC00\uB2A5\uC131 \uC5F0\uAD6C\uBC29\uBC95",
        kind: "own",
        phase: "ideation",
        updatedAt: 1,
      }),
    );
    await seedJobWithSummary(t, {
      url: "https://example.com/ko",
      type: "paper",
      title: "\uC624\uD1A0\uC778\uCF54\uB354 \uD574\uC11D\uAC00\uB2A5\uC131 \uC5F0\uAD6C\uBC29\uBC95",
      summary: "\uC624\uD1A0\uC778\uCF54\uB354 \uD574\uC11D\uAC00\uB2A5\uC131 \uC5F0\uAD6C\uBC29\uBC95 \uC815\uB9AC",
      keywords: [],
    });
    expect(await t.query(api.research.getRelatedJobs, { ...auth, researchId })).toEqual([]);
  });

  // The payoff, at the corpus size the deployment actually has. Two things have
  // to hold at once, and the first attempt at Korean support could only manage
  // one of them: a Korean-only match must surface, and generic Korean must not.
  it("matches Korean on rare words and ignores the generic words every summary shares", async () => {
    const t = withConvex();
    const researchId = await t.run(async (ctx) =>
      ctx.db.insert("researchProjects", {
        slug: "sae-ko",
        title: "\uD76C\uC18C\uC624\uD1A0\uC778\uCF54\uB354 \uD574\uC11D\uAC00\uB2A5\uC131",
        kind: "own",
        // The project's own notes carry the same generic vocabulary the filler
        // does. Without that overlap the filler could never match on generic
        // words, and this test would pass with or without the weighting.
        notes: "\uC774\uBC88 \uC5F0\uAD6C\uC5D0\uC11C\uB294 \uC0C8\uB85C\uC6B4 \uBAA8\uB378\uC744 \uACF5\uAC1C\uD558\uBA70 \uC131\uB2A5\uC744 \uD06C\uAC8C \uAC1C\uC120\uD588\uB2E4\uACE0 \uBC1D\uD614\uB2E4",
        phase: "ideation",
        updatedAt: 1,
      }),
    );
    // A corpus of filler, every row sharing the vocabulary a Korean summary is
    // mostly made of. These are the words that used to create false matches.
    const filler = "\uC774\uBC88 \uBC1C\uD45C\uC5D0\uC11C\uB294 \uC0C8\uB85C\uC6B4 \uBAA8\uB378\uC744 \uACF5\uAC1C\uD558\uBA70 \uC131\uB2A5\uC744 \uD06C\uAC8C \uAC1C\uC120\uD588\uB2E4\uACE0 \uBC1D\uD614\uB2E4";
    for (let i = 0; i < 30; i++) {
      await seedJobWithSummary(t, {
        url: `https://example.com/filler-${i}`,
        type: "newsletter",
        title: "\uC0C8\uB85C\uC6B4 \uBAA8\uB378 \uACF5\uAC1C",
        summary: filler,
        keywords: [],
      });
    }
    // Same generic vocabulary, plus the two rare words the project is about.
    const hit = await seedJobWithSummary(t, {
      url: "https://example.com/hit",
      type: "newsletter",
      title: "\uD76C\uC18C\uC624\uD1A0\uC778\uCF54\uB354 \uC5F0\uAD6C",
      summary: `${filler} \uD76C\uC18C\uC624\uD1A0\uC778\uCF54\uB354 \uD574\uC11D\uAC00\uB2A5\uC131 \uAD00\uB828 \uC5F0\uAD6C\uB3C4 \uD568\uAED8 \uACF5\uAC1C\uD588\uB2E4`,
      keywords: [],
    });

    const related = await t.query(api.research.getRelatedJobs, { ...auth, researchId });
    expect(related.map((r) => r.jobId)).toEqual([hit]);
  });

  // The regression guard. A real summary is 4-6 Korean sentences carrying one
  // English term. Scoring Korean tokens without weighting them inflates the
  // denominator until this match falls under the 0.02 gate and the job silently
  // vanishes, which is exactly how the first attempt at Korean support failed.
  it("still matches one English term inside a full-length Korean summary", async () => {
    const t = withConvex();
    const researchId = await t.run(async (ctx) =>
      ctx.db.insert("researchProjects", {
        slug: "tf-long",
        title: "transformer architecture",
        kind: "own",
        phase: "ideation",
        updatedAt: 1,
      }),
    );
    const jobId = await seedJobWithSummary(t, {
      url: "https://example.com/ko-long",
      type: "newsletter",
      title: "\uC0C8\uB85C\uC6B4 \uC5B8\uC5B4 \uBAA8\uB378 \uACF5\uAC1C",
      summary: [
        "\uAD6C\uAE00 \uB525\uB9C8\uC778\uB4DC\uB294 \uC0C8\uB85C\uC6B4 transformer \uAE30\uBC18 \uBAA8\uB378\uC744 \uACF5\uAC1C\uD558\uBA70 \uD559\uC2B5 \uD6A8\uC728\uC744 \uD06C\uAC8C \uAC1C\uC120\uD588\uB2E4\uACE0 \uBC1C\uD45C\uD588\uB2E4.",
        "\uC774\uBC88 \uBAA8\uB378\uC740 \uAE34 \uBB38\uB9E5\uC744 \uCC98\uB9AC\uD558\uB294 \uB2A5\uB825\uC774 \uD5A5\uC0C1\uB418\uC5C8\uC73C\uBA70 \uCD94\uB860 \uBE44\uC6A9\uB3C4 \uD568\uAED8 \uB0AE\uCDC4\uB2E4.",
        "\uC5F0\uAD6C\uC9C4\uC740 \uAE30\uC874 \uBC29\uC2DD \uB300\uBE44 \uC815\uD655\uB3C4\uAC00 \uC720\uC758\uBBF8\uD558\uAC8C \uC62C\uB790\uB2E4\uACE0 \uC124\uBA85\uD588\uB2E4.",
        "\uD3C9\uAC00 \uACB0\uACFC\uB294 \uC5EC\uB7EC \uBCA4\uCE58\uB9C8\uD06C\uC5D0\uC11C \uC77C\uAD00\uB418\uAC8C \uB098\uD0C0\uB0AC\uB2E4\uACE0 \uBC1D\uD614\uB2E4.",
        "\uAD00\uB828 \uCF54\uB4DC\uC640 \uAC00\uC911\uCE58\uB294 \uC21C\uCC28\uC801\uC73C\uB85C \uACF5\uAC1C\uB420 \uC608\uC815\uC774\uB2E4.",
        "\uC5C5\uACC4\uC5D0\uC11C\uB294 \uC774\uBC88 \uBC1C\uD45C\uAC00 \uACBD\uC7C1 \uAD6C\uB3C4\uC5D0 \uC601\uD5A5\uC744 \uC904 \uAC83\uC73C\uB85C \uBCF4\uACE0 \uC788\uB2E4.",
      ].join(" "),
      keywords: [],
    });
    const related = await t.query(api.research.getRelatedJobs, { ...auth, researchId });
    expect(related.map((r) => r.jobId)).toContain(jobId);
    expect(related.find((r) => r.jobId === jobId)!.score).toBeGreaterThan(0.02);
  });

  it("matches an English term that carries a Korean particle, the corpus's usual shape", async () => {
    const t = withConvex();
    const researchId = await t.run(async (ctx) =>
      ctx.db.insert("researchProjects", {
        slug: "tf",
        title: "transformer architecture",
        kind: "own",
        phase: "ideation",
        updatedAt: 1,
      }),
    );
    const jobId = await seedJobWithSummary(t, {
      url: "https://example.com/tf",
      type: "newsletter",
      // Korean prose keeps the English term and glues a particle onto it, so
      // the term only matches if the particle is split off.
      title: "\uC0C8\uB85C\uC6B4 \uC5B8\uC5B4\uBAA8\uB378 \uC18C\uC2DD",
      summary: "Transformer\uB97C \uAC1C\uC120\uD55C \uC0C8\uB85C\uC6B4 \uBAA8\uB378\uC744 \uBC1C\uD45C\uD588\uC2B5\uB2C8\uB2E4",
      keywords: [],
    });
    const related = await t.query(api.research.getRelatedJobs, { ...auth, researchId });
    expect(related).toHaveLength(1);
    expect(related[0].jobId).toBe(jobId);
  });

  it("still drops two-letter English tokens, which carry nothing on their own", async () => {
    const t = withConvex();
    const researchId = await t.run(async (ctx) =>
      ctx.db.insert("researchProjects", {
        slug: "stop",
        title: "ai ml is on my pc",
        kind: "own",
        phase: "ideation",
        updatedAt: 1,
      }),
    );
    await seedJobWithSummary(t, {
      url: "https://example.com/stop",
      type: "article",
      title: "ai ml is on my pc",
      summary: "ai ml is on my pc",
      keywords: [],
    });
    expect(await t.query(api.research.getRelatedJobs, { ...auth, researchId })).toEqual([]);
  });
});

describe("projects related to a job", () => {
  it("returns the projects that share the job's summary vocabulary", async () => {
    const t = withConvex();
    const jobId = await seedJobWithSummary(t, {
      url: "https://example.com/sae",
      type: "paper",
      title: "sparse autoencoder interpretability",
      summary: "sparse autoencoder interpretability",
      keywords: [],
    });
    const researchId = await t.run(async (ctx) => {
      await ctx.db.insert("researchProjects", {
        slug: "bread",
        title: "sourdough bread baking",
        kind: "own",
        phase: "ideation",
        updatedAt: 1,
      });
      return ctx.db.insert("researchProjects", {
        slug: "sae",
        title: "sparse autoencoder interpretability",
        kind: "own",
        phase: "literature",
        updatedAt: 2,
      });
    });
    const related = await t.query(api.research.getRelatedResearch, { ...auth, jobId });
    expect(related).toHaveLength(1);
    expect(related[0].researchId).toBe(researchId);
    expect(related[0].phase).toBe("literature");
    expect(related[0].kind).toBe("own");
  });

  it("returns nothing for a job that has no summaries yet", async () => {
    const t = withConvex();
    const jobId = await t.run(async (ctx) =>
      ctx.db.insert("jobs", { url: "https://example.com/x", type: "paper", status: "pending", createdAt: 1 }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("researchProjects", {
        slug: "sae",
        title: "sparse autoencoder interpretability",
        kind: "own",
        phase: "ideation",
        updatedAt: 1,
      }),
    );
    expect(await t.query(api.research.getRelatedResearch, { ...auth, jobId })).toEqual([]);
  });
});

describe("plan items related to a project", () => {
  it("returns a plan item that shares the project's vocabulary", async () => {
    const t = withConvex();
    const researchId = await t.run(async (ctx) =>
      ctx.db.insert("researchProjects", {
        slug: "sae",
        title: "sparse autoencoder interpretability",
        kind: "own",
        phase: "ideation",
        updatedAt: 1,
      }),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("planItems", {
        planSlug: "wk",
        date: "2026-08-03",
        kind: "todo",
        order: 0,
        title: "sparse autoencoder interpretability sweep",
        tags: [],
        done: false,
      });
      await ctx.db.insert("planItems", {
        planSlug: "wk",
        date: "2026-08-03",
        kind: "event",
        order: 1,
        title: "dentist appointment downtown",
        tags: ["personal"],
        done: false,
      });
    });
    const related = await t.query(api.research.getRelatedPlanItems, { ...auth, researchId });
    expect(related).toHaveLength(1);
    expect(related[0].title).toBe("sparse autoencoder interpretability sweep");
    expect(related[0].score).toBeGreaterThan(0.05);
  });

  it("returns nothing for a project id that no longer resolves", async () => {
    const t = withConvex();
    const researchId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("researchProjects", {
        slug: "gone",
        title: "sparse autoencoder",
        kind: "own",
        phase: "ideation",
        updatedAt: 1,
      });
      await ctx.db.delete(id);
      return id;
    });
    expect(await t.query(api.research.getRelatedPlanItems, { ...auth, researchId })).toEqual([]);
  });
});
