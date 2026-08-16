import { describe, expect, it } from "vitest";
import type { JobStatus } from "@openworks/domain";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { auth, withConvex } from "./harness.setup";

type T = ReturnType<typeof withConvex>;
type SuggestionStatus = "pending" | "approved" | "rejected" | "executed";

async function seedJob(t: T, status: JobStatus = "suggesting") {
  return await t.run(async (ctx) =>
    ctx.db.insert("jobs", {
      url: "https://example.com/newsletter",
      type: "newsletter",
      status,
      archived: false,
      createdAt: 1,
    }),
  );
}

type SuggestionInput = {
  summaryIndex: number;
  topic: string;
  pageName: string;
  pageId: string;
  pageUrl: string;
  action: string;
  content: string;
  contextBefore?: string;
  contextAfter?: string;
};

function suggestion(n: number, overrides: Partial<SuggestionInput> = {}): SuggestionInput {
  return {
    summaryIndex: n,
    topic: `topic ${n}`,
    pageName: `Page ${n}`,
    pageId: `page-${n}`,
    pageUrl: `https://notion.so/page-${n}`,
    action: "append",
    content: `body ${n}`,
    ...overrides,
  };
}

async function readJob(t: T, jobId: Id<"jobs">) {
  return await t.run(async (ctx) => ctx.db.get(jobId));
}

async function suggestionIds(t: T, jobId: Id<"jobs">) {
  const rows = await t.query(api.suggestions.listByJob, { ...auth, jobId });
  return rows.map((r) => r._id);
}

async function statuses(t: T, jobId: Id<"jobs">) {
  const rows = await t.query(api.suggestions.listByJob, { ...auth, jobId });
  return rows.map((r) => r.status);
}

async function setStatus(t: T, id: Id<"suggestions">, status: SuggestionStatus) {
  await t.mutation(api.suggestions.updateStatus, { ...auth, suggestionId: id, status });
}

describe("queuing a batch of Notion suggestions", () => {
  it("stores every row as pending and moves the job into triage", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0), suggestion(1)] });
    expect(await statuses(t, jobId)).toEqual(["pending", "pending"]);
    expect((await readJob(t, jobId))?.status).toBe("suggested");
  });

  // Known dead end, deliberately pinned: the job sits in triage with no rows to
  // triage. It cannot be fixed in addBatch, since the live producer writes that
  // status without calling addBatch at all.
  it("still moves the job into triage when the agent proposed nothing", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [] });
    expect((await readJob(t, jobId))?.status).toBe("suggested");
  });

  it("keeps the job in triage when a trailing empty batch arrives", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0)] });
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [] });
    expect(await statuses(t, jobId)).toEqual(["pending"]);
    expect((await readJob(t, jobId))?.status).toBe("suggested");
  });

  it("clears the error a failed attempt left behind and stamps the completion", async () => {
    const t = withConvex();
    const jobId = await t.run(async (ctx) =>
      ctx.db.insert("jobs", {
        url: "https://example.com/newsletter",
        type: "newsletter",
        status: "summarizing",
        archived: false,
        createdAt: 1,
        error: "provider crashed on attempt 1",
      }),
    );
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0)] });
    const job = await readJob(t, jobId);
    expect(job?.error).toBeUndefined();
    expect(typeof job?.summarizingCompletedAt).toBe("number");
  });

  it("appends a second batch rather than replacing the first", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0)] });
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0)] });
    expect((await suggestionIds(t, jobId)).length).toBe(2);
  });

  it("re-opens a job that was already closed", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, "done");
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0)] });
    expect((await readJob(t, jobId))?.status).toBe("suggested");
  });

  it("rejects a suggestion that is missing a required field", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    const { pageUrl: _pageUrl, ...incomplete } = suggestion(0);
    await expect(
      t.mutation(api.suggestions.addBatch, {
        ...auth,
        jobId,
        suggestions: [incomplete as unknown as SuggestionInput],
      }),
    ).rejects.toThrow();
  });

  it("does not let the caller pre-set a status", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await expect(
      t.mutation(api.suggestions.addBatch, {
        ...auth,
        jobId,
        suggestions: [{ ...suggestion(0), status: "approved" } as unknown as SuggestionInput],
      }),
    ).rejects.toThrow();
  });
});

describe("listing suggestions", () => {
  it("returns only the requested job's suggestions", async () => {
    const t = withConvex();
    const mine = await seedJob(t);
    const theirs = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId: mine, suggestions: [suggestion(0)] });
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId: theirs, suggestions: [suggestion(1), suggestion(2)] });
    expect((await suggestionIds(t, mine)).length).toBe(1);
    expect((await suggestionIds(t, theirs)).length).toBe(2);
  });

  it("returns an empty list for a job that never produced suggestions", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    expect(await t.query(api.suggestions.listByJob, { ...auth, jobId })).toEqual([]);
  });
});

describe("triaging a single suggestion", () => {
  it("keeps the job open while an approved suggestion is still waiting to execute", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0)] });
    const [id] = await suggestionIds(t, jobId);
    await setStatus(t, id, "approved");
    expect((await readJob(t, jobId))?.status).toBe("suggested");
  });

  it("closes the job once the last suggestion is rejected", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0)] });
    const [id] = await suggestionIds(t, jobId);
    await setStatus(t, id, "rejected");
    expect((await readJob(t, jobId))?.status).toBe("done");
  });

  it("keeps the job open while a sibling suggestion is untouched", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0), suggestion(1)] });
    const [first] = await suggestionIds(t, jobId);
    await setStatus(t, first, "rejected");
    expect((await readJob(t, jobId))?.status).toBe("suggested");
  });

  it("closes the job when a mix of executed and rejected leaves nothing outstanding", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0), suggestion(1)] });
    const [first, second] = await suggestionIds(t, jobId);
    await setStatus(t, first, "executed");
    await setStatus(t, second, "rejected");
    expect((await readJob(t, jobId))?.status).toBe("done");
  });

  it("re-opens nothing when a resolved suggestion is put back to pending", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0)] });
    const [id] = await suggestionIds(t, jobId);
    await setStatus(t, id, "rejected");
    await setStatus(t, id, "pending");
    expect(await statuses(t, jobId)).toEqual(["pending"]);
    expect((await readJob(t, jobId))?.status).toBe("done");
  });

  it("silently ignores a suggestion that has already been deleted", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0)] });
    const [id] = await suggestionIds(t, jobId);
    await t.run(async (ctx) => ctx.db.delete(id));
    await setStatus(t, id, "rejected");
    expect((await readJob(t, jobId))?.status).toBe("suggested");
  });

  it("refuses a status outside the four triage states", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0)] });
    const [id] = await suggestionIds(t, jobId);
    await expect(
      t.mutation(api.suggestions.updateStatus, {
        ...auth,
        suggestionId: id,
        status: "skipped" as unknown as SuggestionStatus,
      }),
    ).rejects.toThrow();
  });
});

describe("triaging every suggestion at once", () => {
  it("promotes only the pending rows and leaves already-triaged ones as they are", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, {
      ...auth,
      jobId,
      suggestions: [suggestion(0), suggestion(1), suggestion(2)],
    });
    const [first, second] = await suggestionIds(t, jobId);
    await setStatus(t, first, "rejected");
    await setStatus(t, second, "executed");
    await t.mutation(api.suggestions.approveAll, { ...auth, jobId });
    expect(await statuses(t, jobId)).toEqual(["rejected", "executed", "approved"]);
  });

  it("does not close the job on approve-all, because approved work is still outstanding", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0)] });
    await t.mutation(api.suggestions.approveAll, { ...auth, jobId });
    expect((await readJob(t, jobId))?.status).toBe("suggested");
  });

  it("closes the job when reject-all leaves nothing unresolved", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0), suggestion(1)] });
    await t.mutation(api.suggestions.rejectAll, { ...auth, jobId });
    expect(await statuses(t, jobId)).toEqual(["rejected", "rejected"]);
    expect((await readJob(t, jobId))?.status).toBe("done");
  });

  it("leaves the job open when reject-all skips an approved row", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0), suggestion(1)] });
    const [first] = await suggestionIds(t, jobId);
    await setStatus(t, first, "approved");
    await t.mutation(api.suggestions.rejectAll, { ...auth, jobId });
    expect(await statuses(t, jobId)).toEqual(["approved", "rejected"]);
    expect((await readJob(t, jobId))?.status).toBe("suggested");
  });

  it("leaves a job with no suggestions where it is instead of closing it", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, "suggested");
    await t.mutation(api.suggestions.rejectAll, { ...auth, jobId });
    expect((await readJob(t, jobId))?.status).toBe("suggested");
  });

  it("touches only the given job's suggestions", async () => {
    const t = withConvex();
    const mine = await seedJob(t);
    const theirs = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId: mine, suggestions: [suggestion(0)] });
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId: theirs, suggestions: [suggestion(0)] });
    await t.mutation(api.suggestions.approveAll, { ...auth, jobId: mine });
    expect(await statuses(t, theirs)).toEqual(["pending"]);
  });
});

describe("handing approved suggestions to the executor", () => {
  it("returns approved rows only, ignoring pending, rejected and executed", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, {
      ...auth,
      jobId,
      suggestions: [suggestion(0), suggestion(1), suggestion(2), suggestion(3)],
    });
    const [a, b, c] = await suggestionIds(t, jobId);
    await setStatus(t, a, "approved");
    await setStatus(t, b, "rejected");
    await setStatus(t, c, "executed");
    const approved = await t.query(api.suggestions.getApproved, { ...auth, jobId });
    expect(approved.map((s) => s._id)).toEqual([a]);
  });

  it("closes the job when it marks the last outstanding suggestion executed", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0)] });
    const [id] = await suggestionIds(t, jobId);
    await t.mutation(api.suggestions.markExecuted, { ...auth, suggestionId: id });
    expect(await statuses(t, jobId)).toEqual(["executed"]);
    expect((await readJob(t, jobId))?.status).toBe("done");
  });

  it("closes the job only once the sibling suggestion is executed too", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0), suggestion(1)] });
    const [first, second] = await suggestionIds(t, jobId);
    await t.mutation(api.suggestions.markExecuted, { ...auth, suggestionId: first });
    expect((await readJob(t, jobId))?.status).toBe("suggested");
    await t.mutation(api.suggestions.markExecuted, { ...auth, suggestionId: second });
    expect((await readJob(t, jobId))?.status).toBe("done");
  });

  it("silently ignores a suggestion that has already been deleted", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0)] });
    const [id] = await suggestionIds(t, jobId);
    await t.run(async (ctx) => ctx.db.delete(id));
    await t.mutation(api.suggestions.markExecuted, { ...auth, suggestionId: id });
    expect((await readJob(t, jobId))?.status).toBe("suggested");
  });
});

describe("closing the parent job", () => {
  it("leaves a job with no suggestions alone so it never closes prematurely", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, "suggested");
    await t.mutation(internal.suggestions.markJobDoneIfAllResolved, { jobId });
    expect((await readJob(t, jobId))?.status).toBe("suggested");
  });

  it("closes a job that is mid-execution once every suggestion has landed", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, "executing");
    await t.run(async (ctx) => ctx.db.insert("suggestions", { jobId, status: "executed", ...suggestion(0) }));
    await t.mutation(internal.suggestions.markJobDoneIfAllResolved, { jobId });
    expect((await readJob(t, jobId))?.status).toBe("done");
  });

  it("clears a stale error and stamps the completion when it closes the job", async () => {
    const t = withConvex();
    const jobId = await t.run(async (ctx) =>
      ctx.db.insert("jobs", {
        url: "https://example.com/newsletter",
        type: "newsletter",
        status: "executing",
        archived: false,
        createdAt: 1,
        error: "provider crashed on attempt 1",
      }),
    );
    await t.run(async (ctx) => ctx.db.insert("suggestions", { jobId, status: "executed", ...suggestion(0) }));
    await t.mutation(internal.suggestions.markJobDoneIfAllResolved, { jobId });
    const job = await readJob(t, jobId);
    expect(job?.error).toBeUndefined();
    expect(typeof job?.summarizingCompletedAt).toBe("number");
  });

  it("leaves an already-closed job at done", async () => {
    const t = withConvex();
    const jobId = await seedJob(t, "done");
    await t.run(async (ctx) => ctx.db.insert("suggestions", { jobId, status: "rejected", ...suggestion(0) }));
    await t.mutation(internal.suggestions.markJobDoneIfAllResolved, { jobId });
    expect((await readJob(t, jobId))?.status).toBe("done");
  });
});

describe("internal accessors used by the Notion executor", () => {
  it("reads a single suggestion back by id", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0)] });
    const [id] = await suggestionIds(t, jobId);
    const found = await t.query(internal.suggestions.internalGetById, { suggestionId: id });
    expect(found).toMatchObject({ pageId: "page-0", status: "pending" });
  });

  it("returns null for a suggestion that has been deleted", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0)] });
    const [id] = await suggestionIds(t, jobId);
    await t.run(async (ctx) => ctx.db.delete(id));
    expect(await t.query(internal.suggestions.internalGetById, { suggestionId: id })).toBeNull();
  });

  it("hands back only the pending rows of a job", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0), suggestion(1)] });
    const [first] = await suggestionIds(t, jobId);
    await setStatus(t, first, "approved");
    const pending = await t.query(internal.suggestions.internalGetPendingByJob, { jobId });
    expect(pending.map((s) => s.pageId)).toEqual(["page-1"]);
  });

  it("sets a status without touching the parent job", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0)] });
    const [id] = await suggestionIds(t, jobId);
    await t.mutation(internal.suggestions.internalSetStatus, { suggestionId: id, status: "rejected" });
    expect(await statuses(t, jobId)).toEqual(["rejected"]);
    expect((await readJob(t, jobId))?.status).toBe("suggested");
  });
});

describe("backfilling the Notion page context", () => {
  it("lists the suggestions that carry neither side of the context", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, {
      ...auth,
      jobId,
      suggestions: [
        suggestion(0),
        suggestion(1, { contextBefore: "before" }),
        suggestion(2, { contextAfter: "after" }),
      ],
    });
    const missing = await t.query(api.suggestions.getMissingContext, { ...auth });
    expect(missing.map((m) => m.pageId)).toEqual(["page-0"]);
  });

  // An agent that writes "" instead of notion-fetching leaves the row without an
  // anchor, exactly like an absent field, so it must stay repairable.
  it("keeps an empty-string context in the backfill queue, because the check is truthiness", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, {
      ...auth,
      jobId,
      suggestions: [suggestion(0, { contextBefore: "", contextAfter: "" })],
    });
    expect((await t.query(api.suggestions.getMissingContext, { ...auth })).map((m) => m.pageId)).toEqual(["page-0"]);
  });

  it("drops a row from the queue as soon as one side carries real text", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, {
      ...auth,
      jobId,
      suggestions: [suggestion(0, { contextBefore: "", contextAfter: "" })],
    });
    const [id] = await suggestionIds(t, jobId);
    await t.mutation(api.suggestions.updateContent, { ...auth, suggestionId: id, contextAfter: "## Papers" });
    expect(await t.query(api.suggestions.getMissingContext, { ...auth })).toEqual([]);
  });

  it("scans at most 500 rows, so a larger backlog needs repeated passes", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 520; i++) {
        await ctx.db.insert("suggestions", { jobId, status: "pending", ...suggestion(i) });
      }
    });
    expect((await t.query(api.suggestions.getMissingContext, { ...auth })).length).toBe(500);
  });

  it("writes back only the fields the backfill supplies", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0)] });
    const [id] = await suggestionIds(t, jobId);
    await t.mutation(api.suggestions.updateContent, { ...auth, suggestionId: id, contextBefore: "before" });
    const row = await t.query(internal.suggestions.internalGetById, { suggestionId: id });
    expect(row).toMatchObject({ contextBefore: "before", content: "body 0" });
    expect(row?.contextAfter).toBeUndefined();
  });

  it("accepts a call with nothing to write and leaves the row untouched", async () => {
    const t = withConvex();
    const jobId = await seedJob(t);
    await t.mutation(api.suggestions.addBatch, { ...auth, jobId, suggestions: [suggestion(0)] });
    const [id] = await suggestionIds(t, jobId);
    await t.mutation(api.suggestions.updateContent, { ...auth, suggestionId: id });
    const row = await t.query(internal.suggestions.internalGetById, { suggestionId: id });
    expect(row).toMatchObject({ content: "body 0", status: "pending" });
  });
});
