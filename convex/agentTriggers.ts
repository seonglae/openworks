import { readStoredAgentConfig, type AgentEventType, type EntityType } from "@openworks/domain";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { headFor, pinEventSnapshot, pinSource, type ContentIdentity } from "./contentStore";
export type FanOutOpts = {
  eventType: AgentEventType;
  entityType: EntityType;
  entityKey: string;
  entityVenueSlug?: string;
  researchSlug?: string;
  sourceRevisionIds?: Id<"contentRevisions">[];
  eventSnapshot?: Record<string, unknown>;
};
async function currentContent(ctx: MutationCtx, opts: FanOutOpts) {
  const r = opts.researchSlug!;
  const k = opts.entityKey;
  const venue = opts.entityVenueSlug;
  switch (opts.entityType) {
    case "memo":
      return ctx.db
        .query("researchMemos")
        .withIndex("by_research_slug", (q) => q.eq("researchSlug", r).eq("memoSlug", k))
        .unique();
    case "experiment":
      return ctx.db
        .query("researchExperiments")
        .withIndex("by_research_slug", (q) => q.eq("researchSlug", r).eq("expSlug", k))
        .unique();
    case "section":
      return ctx.db
        .query("researchSections")
        .withIndex("by_research_venue_section", (q) =>
          q.eq("researchSlug", r).eq("venueSlug", venue).eq("sectionSlug", k),
        )
        .unique();
    case "tex":
      return ctx.db
        .query("researchTex")
        .withIndex("by_research_venue_path", (q) => q.eq("researchSlug", r).eq("venueSlug", venue).eq("texPath", k))
        .unique();
    default:
      return null;
  }
}
export async function fanOut(ctx: MutationCtx, opts: FanOutOpts): Promise<number> {
  const project = opts.researchSlug
    ? await ctx.db
        .query("researchProjects")
        .withIndex("by_slug", (q) => q.eq("slug", opts.researchSlug!))
        .unique()
    : null;
  if (project?.deletionStartedAt !== undefined) throw new Error("Project deletion is in progress");
  const workspace = project?.workspaceId ? await ctx.db.get(project.workspaceId) : null;
  const subs = await ctx.db
    .query("agentSubscriptions")
    .withIndex("by_event", (q) => q.eq("eventType", opts.eventType).eq("enabled", true))
    .collect();
  const matching = subs.filter((s) => {
    if (s.targetType && s.targetType !== opts.entityType) return false;
    if (s.scope === "global") return true;
    if (s.scope === "project") return Boolean(opts.researchSlug && s.scopeId === opts.researchSlug);
    return Boolean(workspace && (s.scopeId === workspace._id || s.scopeId === workspace.slug));
  });
  if (!matching.length) return 0;
  const sources = [...(opts.sourceRevisionIds ?? [])];
  if (opts.researchSlug && !opts.sourceRevisionIds) {
    const row = await currentContent(ctx, opts);
    if (row) {
      const identity = {
        kind: opts.entityType,
        researchSlug: opts.researchSlug,
        key: opts.entityKey,
        venueSlug: opts.entityVenueSlug,
      } as ContentIdentity;
      const head = await headFor(ctx, identity);
      sources.push(head?.revisionId ?? (await pinSource(ctx, identity, row, 0)));
    }
  }
  if (opts.researchSlug && (opts.eventSnapshot || (opts.entityType === "research" && project))) {
    const snapshot = opts.eventSnapshot ?? project!;
    const token = await pinEventSnapshot(
      ctx,
      {
        kind: opts.eventType === "comment.posted" ? "comment" : "research",
        researchSlug: opts.researchSlug,
        key: (opts.eventSnapshot?._id as string) ?? opts.entityKey,
      },
      snapshot,
    );
    sources.push(token.revisionId);
  }
  const triggerSnapshot = JSON.stringify({
    eventType: opts.eventType,
    entityType: opts.entityType,
    entityKey: opts.entityKey,
    entityVenueSlug: opts.entityVenueSlug,
    researchSlug: opts.researchSlug,
    projectId: project?._id,
    stateVersion: project?.stateVersion ?? 0,
    phase: project?.phase,
    sourceRevisionIds: sources,
  });
  for (const subscription of matching) {
    const config = readStoredAgentConfig(subscription.config);
    await ctx.db.insert("agentRuns", {
      subscriptionId: subscription._id,
      agentId: subscription.agentId,
      triggerType: opts.eventType,
      triggerEntityType: opts.entityType,
      triggerEntityKey: opts.entityKey,
      triggerEntityVenueSlug: opts.entityVenueSlug,
      researchSlug: opts.researchSlug,
      configSnapshot: config.configSnapshot,
      configDiagnostic: config.issue,
      sourceRevisionIds: sources,
      triggerSnapshot,
      status: "pending",
      createdAt: Date.now(),
    });
  }
  return matching.length;
}
