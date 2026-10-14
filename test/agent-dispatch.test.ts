import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  dispatchAgentRun,
  parsePhaseOutput,
  recordRunError,
  type AgentCompletion,
} from "../scripts/agent-dispatch.mts";
import type { AgentPromptRun } from "../scripts/agent-prompt.mts";

const run: AgentPromptRun = {
  _id: "run-1",
  agentId: "reviewer",
  triggerType: "entity.updated",
  triggerEntityType: "memo",
  triggerEntityKey: "memo-1",
  researchSlug: "project-1",
  configSnapshot: '{"instructions":"Check evidence"}',
  sourceRevisionIds: ["revision-1"],
  triggerSnapshot: '{"kind":"memo"}',
};

describe("claimed agent run completion", () => {
  it("passes a snapshot-only prompt and exact source IDs through real dispatch logic", async () => {
    const invoke = vi.fn(async () => ({ provider: "stub", stdout: "Comment posted" }));
    const complete = vi.fn(async () => ({}));
    expect(await dispatchAgentRun(run, { invoke, complete })).toEqual({
      status: "done",
      recorded: true,
      provider: "stub",
    });
    expect(invoke).toHaveBeenCalledWith(expect.stringContaining("Check evidence"));
    expect(complete).toHaveBeenCalledWith({
      id: "run-1",
      status: "done",
      outcome: "commented",
      sourceRevisionIds: ["revision-1"],
      result: "Comment posted",
    });
  });

  it.each(["NO_ACTION", " \nNO_ACTION\t"])("recognizes only an explicit no-action acknowledgement", async (stdout) => {
    const complete = vi.fn(async () => ({}));
    await dispatchAgentRun(run, { invoke: async () => ({ provider: "stub", stdout }), complete });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: "no_action", result: "NO_ACTION" }));
  });

  it.each(["", "no_action", "NO_ACTION because nothing changed", "done"])(
    "does not turn arbitrary stdout into no-action success",
    async (stdout) => {
      const complete = vi.fn(async (args: AgentCompletion) => {
        if (args.status === "done") throw new Error("Attributed comment required");
      });
      const result = await dispatchAgentRun(run, { invoke: async () => ({ provider: "stub", stdout }), complete });
      expect(complete.mock.calls[0][0]).toMatchObject({ status: "done", outcome: "commented" });
      expect(result).toMatchObject({ status: "error", recorded: true, error: "Attributed comment required" });
      expect(complete.mock.calls[1][0]).toMatchObject({ status: "error" });
    },
  );

  it("allows empty stdout only if the backend verifies an actual attributed comment", async () => {
    const complete = vi.fn(async () => ({}));
    const result = await dispatchAgentRun(run, { invoke: async () => ({ provider: "stub", stdout: "" }), complete });
    expect(result.status).toBe("done");
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: "commented", result: "" }));
  });

  it("contains a reaped-run completion failure so later queued work still runs", async () => {
    const complete = vi.fn(async () => {
      throw new Error("Run is no longer running");
    });
    const first = await dispatchAgentRun(run, {
      invoke: async () => ({ provider: "stub", stdout: "NO_ACTION" }),
      complete,
    });
    expect(first).toMatchObject({ status: "error", recorded: false, completionError: "Run is no longer running" });
    const secondComplete = vi.fn(async () => ({}));
    const next = await dispatchAgentRun(
      { ...run, _id: "run-2" },
      { invoke: async () => ({ provider: "stub", stdout: "NO_ACTION" }), complete: secondComplete },
    );
    expect(next.status).toBe("done");
    expect(secondComplete).toHaveBeenCalledWith(expect.objectContaining({ id: "run-2" }));
  });

  it("records prompt-validation failures before invoking any provider", async () => {
    const invoke = vi.fn(async () => ({ provider: "stub", stdout: "NO_ACTION" }));
    const complete = vi.fn(async () => ({}));
    const result = await dispatchAgentRun({ ...run, configSnapshot: "private invalid snapshot" }, { invoke, complete });
    expect(result).toMatchObject({ status: "error", recorded: true });
    expect(invoke).not.toHaveBeenCalled();
    expect(JSON.stringify(complete.mock.calls)).not.toContain("private invalid snapshot");
  });

  it("records provider failures on the claimed run", async () => {
    const complete = vi.fn(async () => ({}));
    const result = await dispatchAgentRun(run, {
      invoke: async () => {
        throw new Error("Provider unavailable");
      },
      complete,
    });
    expect(result).toMatchObject({ status: "error", recorded: true, error: "Provider unavailable" });
    expect(complete).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith({ id: "run-1", status: "error", error: "Provider unavailable" });
  });

  it("does not record a malformed provider response as success", async () => {
    const complete = vi.fn(async () => ({}));
    const result = await dispatchAgentRun(run, {
      invoke: async () => ({ provider: "stub", stdout: null as unknown as string }),
      complete,
    });
    expect(result).toMatchObject({ status: "error", recorded: true, error: "Agent output must be text" });
  });

  it("bounds the transcript excerpt while preserving the complete source ID list", async () => {
    const complete = vi.fn(async () => ({}));
    await dispatchAgentRun(run, { invoke: async () => ({ provider: "stub", stdout: "x".repeat(5000) }), complete });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ result: "x".repeat(4000), sourceRevisionIds: ["revision-1"] }),
    );
    expect(run.sourceRevisionIds).toEqual(["revision-1"]);
  });

  it("contains error acknowledgement failures for either queue", async () => {
    const result = await recordRunError("phase-1", new Error("Invalid phase"), async () => {
      throw new Error("Reaped");
    });
    expect(result).toEqual({ status: "error", recorded: false, error: "Invalid phase", completionError: "Reaped" });
  });
});

describe("phase output validation before apply", () => {
  it("supports a wrapped JSON response and omits unknown timestamps", () => {
    expect(
      parsePhaseOutput('```json\n{"phase":"writing","history":[{"state":"writing","at":null,"note":"Evidence"}]}\n```'),
    ).toEqual({ phase: "writing", history: [{ state: "writing", note: "Evidence" }] });
  });

  it("preserves valid zero timestamps and empty history", () => {
    expect(parsePhaseOutput('{"phase":"writing","history":[]}')).toEqual({ phase: "writing", history: [] });
    expect(parsePhaseOutput('{"phase":"writing","history":[{"state":"writing","at":0}]}').history[0].at).toBe(0);
  });

  it.each([
    "private model output without JSON",
    "{broken}",
    '{"phase":"writing"}',
    '{"phase":5,"history":[]}',
    '{"phase":"","history":[]}',
    '{"phase":"writing","history":[null]}',
    '{"phase":"writing","history":[{"state":false}]}',
    '{"phase":"writing","history":[{"state":"writing","at":-1}]}',
    '{"phase":"writing","history":[{"state":"writing","at":1.5}]}',
    '{"phase":"writing","history":[{"state":"writing","at":1e999}]}',
    '{"phase":"writing","history":[{"state":"writing","note":7}]}',
  ])("rejects invalid output without partially dropping entries or echoing raw content", (stdout) => {
    expect(() => parsePhaseOutput(stdout)).toThrowError(/(Invalid|Phase inference)/);
    try {
      parsePhaseOutput(stdout);
    } catch (error) {
      expect(String(error)).not.toContain("private model output");
    }
  });

  it("bounds history and output sizes", () => {
    expect(() =>
      parsePhaseOutput(JSON.stringify({ phase: "writing", history: new Array(201).fill({ state: "writing" }) })),
    ).toThrow();
    expect(() => parsePhaseOutput("x".repeat(1_000_001))).toThrow();
  });
});

describe("worker integration", () => {
  const source = readFileSync(resolve(__dirname, "../scripts/agent-worker.mts"), "utf8");
  it("uses the tested dispatcher in the actual agent queue", () => {
    expect(source).toContain("dispatchAgentRun(claimed");
    expect(source).not.toContain("function buildPrompt");
    expect(source).not.toContain('|| "(no output)"');
  });
  it("pins inference to the claimed run and its captured kind", () => {
    expect(source).toContain("statesFor(claimed.kindSnapshot)");
    expect(source).toContain("runId: claimed._id");
    expect(source).toContain("parsePhaseOutput(result.stdout)");
    expect(source).toContain("recordRunError(claimed._id");
  });
});
