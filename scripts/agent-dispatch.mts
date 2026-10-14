import { buildAgentPrompt, type AgentPromptRun } from "./agent-prompt.mts";

export interface AgentCompletion {
  id: string;
  status: "done" | "error";
  result?: string;
  error?: string;
  outcome?: "commented" | "no_action";
  sourceRevisionIds?: readonly string[];
}

export interface AgentDispatchDependencies {
  invoke: (prompt: string) => Promise<{ provider: string; stdout: string }>;
  complete: (args: AgentCompletion) => Promise<unknown>;
}

export interface AgentDispatchResult {
  status: "done" | "error";
  recorded: boolean;
  provider?: string;
  error?: string;
  completionError?: string;
}

function message(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 1000);
}

/** Completion may race the reaper; its failure must not terminate the queue. */
export async function recordRunError(
  id: string,
  error: unknown,
  complete: (args: AgentCompletion) => Promise<unknown>,
): Promise<AgentDispatchResult> {
  const detail = message(error);
  try {
    await complete({ id, status: "error", error: detail });
    return { status: "error", recorded: true, error: detail };
  } catch (completionError) {
    return { status: "error", recorded: false, error: detail, completionError: message(completionError) };
  }
}

/** Execute one already-claimed run without performing any queue or config reads. */
export async function dispatchAgentRun(
  run: AgentPromptRun,
  dependencies: AgentDispatchDependencies,
): Promise<AgentDispatchResult> {
  try {
    const prompt = buildAgentPrompt(run);
    const { provider, stdout } = await dependencies.invoke(prompt);
    if (typeof stdout !== "string") throw new Error("Agent output must be text");
    const result = stdout.trim();
    await dependencies.complete({
      id: run._id,
      status: "done",
      outcome: result === "NO_ACTION" ? "no_action" : "commented",
      sourceRevisionIds: [...(run.sourceRevisionIds ?? [])],
      // This is a bounded worker transcript excerpt, not a substitute for the
      // actual comment. The backend verifies a persisted, matching run comment.
      result: result.slice(0, 4000),
    });
    return { status: "done", recorded: true, provider };
  } catch (error) {
    return recordRunError(run._id, error, dependencies.complete);
  }
}

export interface InferredHistoryEntry {
  state: string;
  at?: number;
  note?: string;
}

/** Reject malformed output before a backend mutation can partially apply it. */
export function parsePhaseOutput(stdout: string): { phase: string; history: InferredHistoryEntry[] } {
  if (typeof stdout !== "string" || stdout.length > 1_000_000) throw new Error("Invalid phase inference output");
  const match = stdout.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Phase inference output contains no JSON object");
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    throw new Error("Phase inference output contains invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid phase inference output");
  const row = parsed as Record<string, unknown>;
  if (
    typeof row.phase !== "string" ||
    row.phase.trim() === "" ||
    row.phase.length > 100 ||
    !Array.isArray(row.history) ||
    row.history.length > 200
  )
    throw new Error("Invalid phase inference output");
  const history = row.history.map((item: unknown): InferredHistoryEntry => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid inferred history entry");
    const entry = item as Record<string, unknown>;
    if (typeof entry.state !== "string" || entry.state.trim() === "" || entry.state.length > 100) {
      throw new Error("Invalid inferred history state");
    }
    const result: InferredHistoryEntry = { state: entry.state };
    if (entry.at !== undefined && entry.at !== null) {
      if (typeof entry.at !== "number" || !Number.isSafeInteger(entry.at) || entry.at < 0) {
        throw new Error("Invalid inferred history timestamp");
      }
      result.at = entry.at;
    }
    if (entry.note !== undefined) {
      if (typeof entry.note !== "string" || entry.note.length > 4096) throw new Error("Invalid inferred history note");
      result.note = entry.note;
    }
    return result;
  });
  return { phase: row.phase, history };
}
