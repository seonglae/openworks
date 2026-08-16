import { describe, expect, it } from "vitest";
import { EXPERIMENT_STATUS_DEFAULT } from "@openworks/domain";
import { api } from "../_generated/api";
import { auth, withConvex } from "./harness.setup";

type Harness = ReturnType<typeof withConvex>;

// The five entity modules differ only in the name of their key field and of
// their display field, so the shared upsert / get / list / remove contract is
// exercised once through this adapter instead of five near-identical suites.
type EntityCase = {
  label: string;
  save: (
    t: Harness,
    research: string,
    key: string,
    opts?: { display?: string; notes?: string },
  ) => Promise<{ created: boolean }>;
  get: (t: Harness, research: string, key: string) => Promise<{ createdAt: number; updatedAt: number } | null>;
  display: (t: Harness, research: string, key: string) => Promise<string | undefined>;
  notes: (t: Harness, research: string, key: string) => Promise<string | undefined>;
  list: (t: Harness, research: string) => Promise<readonly { updatedAt: number }[]>;
  keys: (t: Harness, research: string) => Promise<string[]>;
  remove: (t: Harness, research: string, key: string) => Promise<{ removed: boolean }>;
  touch: (t: Harness, research: string, key: string, at: number) => Promise<void>;
};

const experiments: EntityCase = {
  label: "experiment",
  save: (t, research, key, opts) =>
    t.mutation(api.researchExperiments.save, {
      ...auth,
      researchSlug: research,
      expSlug: key,
      name: opts?.display,
      notes: opts?.notes,
    }),
  get: (t, research, key) => t.query(api.researchExperiments.get, { ...auth, researchSlug: research, expSlug: key }),
  display: async (t, research, key) =>
    (await t.query(api.researchExperiments.get, { ...auth, researchSlug: research, expSlug: key }))?.name,
  notes: async (t, research, key) =>
    (await t.query(api.researchExperiments.get, { ...auth, researchSlug: research, expSlug: key }))?.notes,
  list: (t, research) => t.query(api.researchExperiments.list, { ...auth, researchSlug: research }),
  keys: async (t, research) =>
    (await t.query(api.researchExperiments.list, { ...auth, researchSlug: research })).map((r) => r.expSlug),
  remove: (t, research, key) =>
    t.mutation(api.researchExperiments.remove, { ...auth, researchSlug: research, expSlug: key }),
  touch: async (t, research, key, at) => {
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("researchExperiments")
        .withIndex("by_research_slug", (q) => q.eq("researchSlug", research).eq("expSlug", key))
        .first();
      if (row) await ctx.db.patch(row._id, { updatedAt: at });
    });
  },
};

const memos: EntityCase = {
  label: "memo",
  save: (t, research, key, opts) =>
    t.mutation(api.researchMemos.save, {
      ...auth,
      researchSlug: research,
      memoSlug: key,
      title: opts?.display,
      notes: opts?.notes,
    }),
  get: (t, research, key) => t.query(api.researchMemos.get, { ...auth, researchSlug: research, memoSlug: key }),
  display: async (t, research, key) =>
    (await t.query(api.researchMemos.get, { ...auth, researchSlug: research, memoSlug: key }))?.title,
  notes: async (t, research, key) =>
    (await t.query(api.researchMemos.get, { ...auth, researchSlug: research, memoSlug: key }))?.notes,
  list: (t, research) => t.query(api.researchMemos.list, { ...auth, researchSlug: research }),
  keys: async (t, research) =>
    (await t.query(api.researchMemos.list, { ...auth, researchSlug: research })).map((r) => r.memoSlug),
  remove: (t, research, key) =>
    t.mutation(api.researchMemos.remove, { ...auth, researchSlug: research, memoSlug: key }),
  touch: async (t, research, key, at) => {
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("researchMemos")
        .withIndex("by_research_slug", (q) => q.eq("researchSlug", research).eq("memoSlug", key))
        .first();
      if (row) await ctx.db.patch(row._id, { updatedAt: at });
    });
  },
};

const tables: EntityCase = {
  label: "table",
  save: (t, research, key, opts) =>
    t.mutation(api.researchTables.save, {
      ...auth,
      researchSlug: research,
      tableSlug: key,
      caption: opts?.display,
      notes: opts?.notes,
    }),
  get: (t, research, key) => t.query(api.researchTables.get, { ...auth, researchSlug: research, tableSlug: key }),
  display: async (t, research, key) =>
    (await t.query(api.researchTables.get, { ...auth, researchSlug: research, tableSlug: key }))?.caption,
  notes: async (t, research, key) =>
    (await t.query(api.researchTables.get, { ...auth, researchSlug: research, tableSlug: key }))?.notes,
  list: (t, research) => t.query(api.researchTables.list, { ...auth, researchSlug: research }),
  keys: async (t, research) =>
    (await t.query(api.researchTables.list, { ...auth, researchSlug: research })).map((r) => r.tableSlug),
  remove: (t, research, key) =>
    t.mutation(api.researchTables.remove, { ...auth, researchSlug: research, tableSlug: key }),
  touch: async (t, research, key, at) => {
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("researchTables")
        .withIndex("by_research_slug", (q) => q.eq("researchSlug", research).eq("tableSlug", key))
        .first();
      if (row) await ctx.db.patch(row._id, { updatedAt: at });
    });
  },
};

const figures: EntityCase = {
  label: "figure",
  save: (t, research, key, opts) =>
    t.mutation(api.researchFigures.save, {
      ...auth,
      researchSlug: research,
      figureSlug: key,
      caption: opts?.display,
      notes: opts?.notes,
    }),
  get: (t, research, key) => t.query(api.researchFigures.get, { ...auth, researchSlug: research, figureSlug: key }),
  display: async (t, research, key) =>
    (await t.query(api.researchFigures.get, { ...auth, researchSlug: research, figureSlug: key }))?.caption,
  notes: async (t, research, key) =>
    (await t.query(api.researchFigures.get, { ...auth, researchSlug: research, figureSlug: key }))?.notes,
  list: (t, research) => t.query(api.researchFigures.list, { ...auth, researchSlug: research }),
  keys: async (t, research) =>
    (await t.query(api.researchFigures.list, { ...auth, researchSlug: research })).map((r) => r.figureSlug),
  remove: (t, research, key) =>
    t.mutation(api.researchFigures.remove, { ...auth, researchSlug: research, figureSlug: key }),
  touch: async (t, research, key, at) => {
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("researchFigures")
        .withIndex("by_research_slug", (q) => q.eq("researchSlug", research).eq("figureSlug", key))
        .first();
      if (row) await ctx.db.patch(row._id, { updatedAt: at });
    });
  },
};

const venues: EntityCase = {
  label: "venue",
  save: (t, research, key, opts) =>
    t.mutation(api.researchVenues.save, {
      ...auth,
      researchSlug: research,
      venueSlug: key,
      name: opts?.display,
      notes: opts?.notes,
    }),
  get: (t, research, key) => t.query(api.researchVenues.get, { ...auth, researchSlug: research, venueSlug: key }),
  display: async (t, research, key) =>
    (await t.query(api.researchVenues.get, { ...auth, researchSlug: research, venueSlug: key }))?.name,
  notes: async (t, research, key) =>
    (await t.query(api.researchVenues.get, { ...auth, researchSlug: research, venueSlug: key }))?.notes,
  list: (t, research) => t.query(api.researchVenues.list, { ...auth, researchSlug: research }),
  keys: async (t, research) =>
    (await t.query(api.researchVenues.list, { ...auth, researchSlug: research })).map((r) => r.venueSlug),
  remove: (t, research, key) =>
    t.mutation(api.researchVenues.remove, { ...auth, researchSlug: research, venueSlug: key }),
  touch: async (t, research, key, at) => {
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("researchVenues")
        .withIndex("by_research_venue", (q) => q.eq("researchSlug", research).eq("venueSlug", key))
        .first();
      if (row) await ctx.db.patch(row._id, { updatedAt: at });
    });
  },
};

const CASES: EntityCase[] = [experiments, memos, tables, figures, venues];

describe.each(CASES)("upsert semantics for a $label", (c) => {
  it("reports the first save as a creation and the second as an update", async () => {
    const t = withConvex();
    expect((await c.save(t, "sae", "k1")).created).toBe(true);
    expect((await c.save(t, "sae", "k1")).created).toBe(false);
  });

  it("keeps exactly one row when the same key is saved twice", async () => {
    const t = withConvex();
    await c.save(t, "sae", "k1");
    await c.save(t, "sae", "k1");
    expect(await c.list(t, "sae")).toHaveLength(1);
  });

  it("overwrites the fields the second save carries", async () => {
    const t = withConvex();
    await c.save(t, "sae", "k1", { display: "first" });
    await c.save(t, "sae", "k1", { display: "second" });
    expect(await c.display(t, "sae", "k1")).toBe("second");
  });

  it("preserves fields the second save omits", async () => {
    const t = withConvex();
    await c.save(t, "sae", "k1", { display: "first", notes: "keep me" });
    await c.save(t, "sae", "k1", { display: "second" });
    expect(await c.notes(t, "sae", "k1")).toBe("keep me");
  });

  it("falls back to the key as the display name when none is given", async () => {
    const t = withConvex();
    await c.save(t, "sae", "k1");
    expect(await c.display(t, "sae", "k1")).toBe("k1");
  });

  it("keeps the original creation timestamp across an update", async () => {
    const t = withConvex();
    await c.save(t, "sae", "k1");
    const created = (await c.get(t, "sae", "k1"))?.createdAt;
    await c.touch(t, "sae", "k1", 1);
    await c.save(t, "sae", "k1", { display: "renamed" });
    const after = await c.get(t, "sae", "k1");
    expect(after?.createdAt).toBe(created);
    expect(after?.updatedAt).not.toBe(1);
  });

  it("treats the same key under two projects as two separate rows", async () => {
    const t = withConvex();
    await c.save(t, "sae", "k1", { display: "sae one" });
    await c.save(t, "other", "k1", { display: "other one" });
    expect(await c.list(t, "sae")).toHaveLength(1);
    expect(await c.display(t, "sae", "k1")).toBe("sae one");
    expect(await c.display(t, "other", "k1")).toBe("other one");
  });

  it("returns null for a key that was never saved", async () => {
    const t = withConvex();
    expect(await c.get(t, "sae", "missing")).toBeNull();
  });

  it("lists only the rows of the requested project", async () => {
    const t = withConvex();
    await c.save(t, "sae", "k1");
    await c.save(t, "other", "k2");
    expect(await c.keys(t, "sae")).toEqual(["k1"]);
  });

  it("lists the most recently updated row first", async () => {
    const t = withConvex();
    await c.save(t, "sae", "old");
    await c.save(t, "sae", "new");
    await c.touch(t, "sae", "old", 10);
    await c.touch(t, "sae", "new", 20);
    expect(await c.keys(t, "sae")).toEqual(["new", "old"]);
  });

  it("reports a delete of an existing row as removed", async () => {
    const t = withConvex();
    await c.save(t, "sae", "k1");
    expect(await c.remove(t, "sae", "k1")).toEqual({ removed: true });
    expect(await c.get(t, "sae", "k1")).toBeNull();
  });

  it("reports a delete of a missing row as not removed", async () => {
    const t = withConvex();
    expect(await c.remove(t, "sae", "missing")).toEqual({ removed: false });
  });

  it("does not delete the same key belonging to another project", async () => {
    const t = withConvex();
    await c.save(t, "sae", "k1");
    await c.save(t, "other", "k1");
    await c.remove(t, "sae", "k1");
    expect(await c.get(t, "other", "k1")).not.toBeNull();
  });
});

describe("experiment specifics", () => {
  it("starts at the status the domain package calls the default", async () => {
    const t = withConvex();
    await t.mutation(api.researchExperiments.save, { ...auth, researchSlug: "sae", expSlug: "e1" });
    const row = await t.query(api.researchExperiments.get, { ...auth, researchSlug: "sae", expSlug: "e1" });
    expect(row?.status).toBe(EXPERIMENT_STATUS_DEFAULT);
    expect(row?.status).toBe("planned");
  });

  it("keeps a status set on creation when a later save omits it", async () => {
    const t = withConvex();
    await t.mutation(api.researchExperiments.save, { ...auth, researchSlug: "sae", expSlug: "e1", status: "running" });
    await t.mutation(api.researchExperiments.save, { ...auth, researchSlug: "sae", expSlug: "e1", metrics: "acc=0.9" });
    const row = await t.query(api.researchExperiments.get, { ...auth, researchSlug: "sae", expSlug: "e1" });
    expect(row?.status).toBe("running");
    expect(row?.metrics).toBe("acc=0.9");
  });

  it("returns only the experiments in the requested status", async () => {
    const t = withConvex();
    await t.mutation(api.researchExperiments.save, { ...auth, researchSlug: "sae", expSlug: "e1", status: "running" });
    await t.mutation(api.researchExperiments.save, { ...auth, researchSlug: "sae", expSlug: "e2", status: "done" });
    const running = await t.query(api.researchExperiments.list, { ...auth, researchSlug: "sae", status: "running" });
    expect(running.map((e) => e.expSlug)).toEqual(["e1"]);
  });
});

describe("memo specifics", () => {
  it("starts with empty content when none is given", async () => {
    const t = withConvex();
    await t.mutation(api.researchMemos.save, { ...auth, researchSlug: "sae", memoSlug: "m1" });
    const row = await t.query(api.researchMemos.get, { ...auth, researchSlug: "sae", memoSlug: "m1" });
    expect(row?.content).toBe("");
  });

  it("returns only the memos carrying the requested tag", async () => {
    const t = withConvex();
    await t.mutation(api.researchMemos.save, { ...auth, researchSlug: "sae", memoSlug: "m1", tags: ["idea", "todo"] });
    await t.mutation(api.researchMemos.save, { ...auth, researchSlug: "sae", memoSlug: "m2", tags: ["todo"] });
    await t.mutation(api.researchMemos.save, { ...auth, researchSlug: "sae", memoSlug: "m3" });
    const ideas = await t.query(api.researchMemos.list, { ...auth, researchSlug: "sae", tag: "idea" });
    expect(ideas.map((m) => m.memoSlug)).toEqual(["m1"]);
  });

  it("replaces the whole tag array rather than merging into it", async () => {
    const t = withConvex();
    await t.mutation(api.researchMemos.save, { ...auth, researchSlug: "sae", memoSlug: "m1", tags: ["idea", "todo"] });
    await t.mutation(api.researchMemos.save, { ...auth, researchSlug: "sae", memoSlug: "m1", tags: ["done"] });
    const row = await t.query(api.researchMemos.get, { ...auth, researchSlug: "sae", memoSlug: "m1" });
    expect(row?.tags).toEqual(["done"]);
  });
});

describe("table specifics", () => {
  it("returns only the tables attached to the requested experiment", async () => {
    const t = withConvex();
    await t.mutation(api.researchTables.save, { ...auth, researchSlug: "sae", tableSlug: "t1", expSlug: "e1" });
    await t.mutation(api.researchTables.save, { ...auth, researchSlug: "sae", tableSlug: "t2", expSlug: "e2" });
    const forE1 = await t.query(api.researchTables.list, { ...auth, researchSlug: "sae", expSlug: "e1" });
    expect(forE1.map((r) => r.tableSlug)).toEqual(["t1"]);
  });

  it("returns every table of the project when no experiment is given", async () => {
    const t = withConvex();
    await t.mutation(api.researchTables.save, { ...auth, researchSlug: "sae", tableSlug: "t1", expSlug: "e1" });
    await t.mutation(api.researchTables.save, { ...auth, researchSlug: "sae", tableSlug: "t2" });
    const all = await t.query(api.researchTables.list, { ...auth, researchSlug: "sae" });
    expect(all.map((r) => r.tableSlug).sort()).toEqual(["t1", "t2"]);
  });

  it("stores every rendering of the same table side by side", async () => {
    const t = withConvex();
    await t.mutation(api.researchTables.save, { ...auth, researchSlug: "sae", tableSlug: "t1", csv: "a,b" });
    await t.mutation(api.researchTables.save, { ...auth, researchSlug: "sae", tableSlug: "t1", latex: "\\hline" });
    const row = await t.query(api.researchTables.get, { ...auth, researchSlug: "sae", tableSlug: "t1" });
    expect(row?.csv).toBe("a,b");
    expect(row?.latex).toBe("\\hline");
  });
});

describe("figure specifics", () => {
  it("returns only the figures attached to the requested experiment", async () => {
    const t = withConvex();
    await t.mutation(api.researchFigures.save, { ...auth, researchSlug: "sae", figureSlug: "f1", expSlug: "e1" });
    await t.mutation(api.researchFigures.save, { ...auth, researchSlug: "sae", figureSlug: "f2", expSlug: "e2" });
    const forE1 = await t.query(api.researchFigures.list, { ...auth, researchSlug: "sae", expSlug: "e1" });
    expect(forE1.map((r) => r.figureSlug)).toEqual(["f1"]);
  });

  it("keeps the stored path when a later save only supplies a url", async () => {
    const t = withConvex();
    await t.mutation(api.researchFigures.save, { ...auth, researchSlug: "sae", figureSlug: "f1", path: "fig/f1.pdf" });
    await t.mutation(api.researchFigures.save, {
      ...auth,
      researchSlug: "sae",
      figureSlug: "f1",
      url: "https://example.com/f1.pdf",
    });
    const row = await t.query(api.researchFigures.get, { ...auth, researchSlug: "sae", figureSlug: "f1" });
    expect(row?.path).toBe("fig/f1.pdf");
    expect(row?.url).toBe("https://example.com/f1.pdf");
  });
});

describe("venue specifics", () => {
  it("starts a venue in the drafting status", async () => {
    const t = withConvex();
    await t.mutation(api.researchVenues.save, { ...auth, researchSlug: "sae", venueSlug: "neurips" });
    const row = await t.query(api.researchVenues.get, { ...auth, researchSlug: "sae", venueSlug: "neurips" });
    expect(row?.status).toBe("drafting");
  });

  it("moves the venue status without touching the project phase", async () => {
    const t = withConvex();
    await t.mutation(api.research.register, { ...auth, slug: "sae", title: "SAE", kind: "own" });
    await t.mutation(api.researchVenues.save, { ...auth, researchSlug: "sae", venueSlug: "neurips" });
    await t.mutation(api.researchVenues.save, {
      ...auth,
      researchSlug: "sae",
      venueSlug: "neurips",
      status: "submitted",
    });
    const venue = await t.query(api.researchVenues.get, { ...auth, researchSlug: "sae", venueSlug: "neurips" });
    expect(venue?.status).toBe("submitted");
    const info = await t.query(api.research.getStateInfo, { ...auth, slug: "sae" });
    expect(info?.phase).toBe("ideation");
  });
});

describe("trigger fan-out from entity writes", () => {
  async function seedGlobalSub(t: Harness, eventType: "entity.created" | "entity.updated") {
    await t.run(async (ctx) =>
      ctx.db.insert("agentSubscriptions", {
        agentId: "gemini",
        eventType,
        scope: "global",
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
  }

  async function runs(t: Harness) {
    return await t.run(async (ctx) => ctx.db.query("agentRuns").collect());
  }

  it("queues a run when an experiment is created for the first time", async () => {
    const t = withConvex();
    await seedGlobalSub(t, "entity.created");
    await t.mutation(api.researchExperiments.save, { ...auth, researchSlug: "sae", expSlug: "e1" });
    const queued = await runs(t);
    expect(queued).toHaveLength(1);
    expect(queued[0].status).toBe("pending");
    expect(queued[0].triggerType).toBe("entity.created");
    expect(queued[0].triggerEntityType).toBe("experiment");
    expect(queued[0].triggerEntityKey).toBe("e1");
    expect(queued[0].researchSlug).toBe("sae");
  });

  it("queues an update run, not a second creation run, when an experiment is saved again", async () => {
    const t = withConvex();
    await seedGlobalSub(t, "entity.created");
    await seedGlobalSub(t, "entity.updated");
    await t.mutation(api.researchExperiments.save, { ...auth, researchSlug: "sae", expSlug: "e1" });
    await t.mutation(api.researchExperiments.save, { ...auth, researchSlug: "sae", expSlug: "e1", status: "running" });
    const queued = await runs(t);
    expect(queued.map((r) => r.triggerType)).toEqual(["entity.created", "entity.updated"]);
  });

  it("skips a subscriber pinned to a different entity type", async () => {
    const t = withConvex();
    await t.run(async (ctx) =>
      ctx.db.insert("agentSubscriptions", {
        agentId: "gemini",
        eventType: "entity.created",
        targetType: "memo",
        scope: "global",
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await t.mutation(api.researchExperiments.save, { ...auth, researchSlug: "sae", expSlug: "e1" });
    expect(await runs(t)).toHaveLength(0);
  });

  it("skips a project-scoped subscriber watching another project", async () => {
    const t = withConvex();
    await t.run(async (ctx) =>
      ctx.db.insert("agentSubscriptions", {
        agentId: "gemini",
        eventType: "entity.created",
        scope: "project",
        scopeId: "other",
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await t.mutation(api.researchExperiments.save, { ...auth, researchSlug: "sae", expSlug: "e1" });
    expect(await runs(t)).toHaveLength(0);
  });

  it("queues nothing when an experiment is deleted", async () => {
    const t = withConvex();
    await seedGlobalSub(t, "entity.updated");
    await t.mutation(api.researchExperiments.save, { ...auth, researchSlug: "sae", expSlug: "e1" });
    await t.mutation(api.researchExperiments.remove, { ...auth, researchSlug: "sae", expSlug: "e1" });
    expect(await runs(t)).toHaveLength(0);
  });

  it("queues nothing for memo, table, figure and venue writes, which do not fan out today", async () => {
    const t = withConvex();
    await seedGlobalSub(t, "entity.created");
    await seedGlobalSub(t, "entity.updated");
    await t.mutation(api.researchMemos.save, { ...auth, researchSlug: "sae", memoSlug: "m1" });
    await t.mutation(api.researchTables.save, { ...auth, researchSlug: "sae", tableSlug: "t1" });
    await t.mutation(api.researchFigures.save, { ...auth, researchSlug: "sae", figureSlug: "f1" });
    await t.mutation(api.researchVenues.save, { ...auth, researchSlug: "sae", venueSlug: "neurips" });
    expect(await runs(t)).toHaveLength(0);
  });
});

describe("entities against an unregistered project", () => {
  it("saves an entity even when no project row exists, because the slug is not a foreign key", async () => {
    const t = withConvex();
    // Current behaviour: entity slugs are free-form strings, so a typo in
    // researchSlug silently creates an orphan rather than failing.
    const res = await t.mutation(api.researchMemos.save, { ...auth, researchSlug: "typo", memoSlug: "m1" });
    expect(res.created).toBe(true);
    const projects = await t.run(async (ctx) => ctx.db.query("researchProjects").collect());
    expect(projects).toHaveLength(0);
  });
});
