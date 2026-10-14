import { canTransition, isValidState, nextStates } from "@openworks/domain";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { fanOut } from "./agentTriggers";
export function checkStateVersion(project: Doc<"researchProjects">, expected?: number) {
  if (
    expected !== undefined &&
    (!Number.isSafeInteger(expected) || expected < 0 || expected !== (project.stateVersion ?? 0))
  )
    throw new Error("Stale project state; read and reconcile before retrying");
}
export async function writeProjectState(
  ctx: MutationCtx,
  project: Doc<"researchProjects">,
  options: {
    phase: string;
    kind?: Doc<"researchProjects">["kind"];
    mode?: "advance" | "direct";
    force?: boolean;
    note?: string;
    actor?: string;
    artifactRef?: string;
    runId?: Id<"researchPhaseRuns">;
    expectedStateVersion?: number;
  },
) {
  if (project.deletionStartedAt !== undefined) throw new Error("Project deletion is in progress");
  checkStateVersion(project, options.expectedStateVersion);
  const kind = options.kind ?? project.kind;
  if (!isValidState(kind, options.phase)) throw new Error(`invalid state '${options.phase}' for kind ${kind}`);
  if (kind === project.kind && options.phase === project.phase)
    return {
      slug: project.slug,
      phase: project.phase,
      at: project.updatedAt,
      changed: false,
      stateVersion: project.stateVersion ?? 0,
    };
  if (options.mode === "advance" && !options.force && !canTransition(kind, project.phase, options.phase)) {
    throw new Error(
      `transition ${project.phase} → ${options.phase} not allowed. valid: [${nextStates(kind, project.phase).join(", ")}] (pass force:true to override)`,
    );
  }
  const now = Date.now();
  const stateVersion = (project.stateVersion ?? 0) + 1;
  await ctx.db.patch(project._id, { kind, phase: options.phase, stateVersion, updatedAt: now });
  await ctx.db.insert("researchTimeline", {
    researchSlug: project.slug,
    state: options.phase,
    at: now,
    note: options.note,
    actor: options.actor,
    artifactRef: options.artifactRef,
    runId: options.runId,
    inferred: options.actor === "phase-infer" ? true : undefined,
  });
  await fanOut(ctx, {
    eventType: "state.transitioned",
    entityType: "research",
    entityKey: project.slug,
    researchSlug: project.slug,
  });
  return { slug: project.slug, phase: options.phase, at: now, changed: true, stateVersion };
}
