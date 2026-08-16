import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import { STALE_RUN_MS } from "../agentSubscriptions";
import { auth, withConvex } from "./harness.setup";

type Harness = ReturnType<typeof withConvex>;

const NOW = 1_700_000_000_000;

async function seedRun(
  t: Harness,
  run: { status: "pending" | "running" | "done" | "error"; startedAt?: number; createdAt?: number },
) {
  return await t.run(async (ctx) => {
    const subscriptionId = await ctx.db.insert("agentSubscriptions", {
      agentId: "phase-coach",
      eventType: "state.transitioned",
      scope: "global",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    });
    return await ctx.db.insert("agentRuns", {
      subscriptionId,
      agentId: "phase-coach",
      triggerType: "state.transitioned",
      triggerEntityType: "research",
      triggerEntityKey: "sae",
      status: run.status,
      createdAt: run.createdAt ?? NOW,
      startedAt: run.startedAt,
    });
  });
}

async function statusOf(t: Harness, id: string) {
  return await t.run(async (ctx) => {
    const row = await ctx.db.get(id as never);
    return row as { status: string; error?: string; completedAt?: number } | null;
  });
}

describe("recovering runs a dead worker left claimed", () => {
  it("fails a run still claimed long after the spawn could have finished", async () => {
    const t = withConvex();
    const id = await seedRun(t, { status: "running", startedAt: NOW - STALE_RUN_MS - 1 });

    const r = await t.mutation(api.agentSubscriptions.reapStaleRuns, { now: NOW, ...auth });

    expect(r.reaped).toBe(1);
    const row = await statusOf(t, id);
    expect(row?.status).toBe("error");
    expect(row?.completedAt).toBe(NOW);
  });

  it("leaves a run that is merely slow alone", async () => {
    const t = withConvex();
    const id = await seedRun(t, { status: "running", startedAt: NOW - STALE_RUN_MS + 60_000 });

    const r = await t.mutation(api.agentSubscriptions.reapStaleRuns, { now: NOW, ...auth });

    expect(r.reaped).toBe(0);
    expect((await statusOf(t, id))?.status).toBe("running");
  });

  it("reaps a row claimed before startedAt was recorded, dating it from creation", async () => {
    const t = withConvex();
    // The two real rows that sat for three months predate startedAt; falling
    // back to createdAt is the only thing that can date them.
    const id = await seedRun(t, { status: "running", createdAt: NOW - STALE_RUN_MS - 1, startedAt: undefined });

    const r = await t.mutation(api.agentSubscriptions.reapStaleRuns, { now: NOW, ...auth });

    expect(r.reaped).toBe(1);
    expect((await statusOf(t, id))?.status).toBe("error");
  });

  it("does not touch pending work waiting for a live worker", async () => {
    const t = withConvex();
    const id = await seedRun(t, { status: "pending", createdAt: NOW - STALE_RUN_MS * 10 });

    const r = await t.mutation(api.agentSubscriptions.reapStaleRuns, { now: NOW, ...auth });

    expect(r.reaped).toBe(0);
    expect((await statusOf(t, id))?.status).toBe("pending");
  });

  it("does not re-reap a run it already failed", async () => {
    const t = withConvex();
    await seedRun(t, { status: "running", startedAt: NOW - STALE_RUN_MS - 1 });

    expect((await t.mutation(api.agentSubscriptions.reapStaleRuns, { now: NOW, ...auth })).reaped).toBe(1);
    expect((await t.mutation(api.agentSubscriptions.reapStaleRuns, { now: NOW, ...auth })).reaped).toBe(0);
  });

  it("says how long the row was abandoned, so the cause is datable", async () => {
    const t = withConvex();
    await seedRun(t, { status: "running", startedAt: NOW - 90 * 60_000 });

    await t.mutation(api.agentSubscriptions.reapStaleRuns, { now: NOW, ...auth });

    const row = await t.run(async (ctx) => (await ctx.db.query("agentRuns").collect())[0]);
    expect(row.error).toContain("90min");
  });

  it("keeps a reaped run out of the pending queue a worker would pick up", async () => {
    const t = withConvex();
    await seedRun(t, { status: "running", startedAt: NOW - STALE_RUN_MS - 1 });
    await t.mutation(api.agentSubscriptions.reapStaleRuns, { now: NOW, ...auth });

    const pending = await t.query(api.agentSubscriptions.listRuns, { status: "pending", ...auth });
    expect(pending).toHaveLength(0);
  });
});
