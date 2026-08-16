// Trigger fan-out: when a significant entity event happens, find matching
// agent subscriptions and queue an agentRuns row for each. The worker polls
// agentRuns and dispatches the actual CLI call.

import type { AgentEventType, EntityType } from "@openworks/domain";
import type { MutationCtx } from "./_generated/server";

export type FanOutOpts = {
  eventType: AgentEventType;
  entityType: EntityType;
  entityKey: string;
  entityVenueSlug?: string;
  researchSlug?: string;
};

export async function fanOut(ctx: MutationCtx, opts: FanOutOpts): Promise<number> {
  const subs = await ctx.db
    .query("agentSubscriptions")
    .withIndex("by_event", (q) => q.eq("eventType", opts.eventType).eq("enabled", true))
    .collect();
  const matching = subs.filter((s) => {
    if (s.targetType && s.targetType !== opts.entityType) return false;
    if (s.scope === "global") return true;
    if (s.scope === "project") return s.scopeId === opts.researchSlug;
    return false; // workspace scope: needs project→workspace lookup, deferred
  });
  const now = Date.now();
  for (const s of matching) {
    await ctx.db.insert("agentRuns", {
      subscriptionId: s._id,
      agentId: s.agentId,
      triggerType: opts.eventType,
      triggerEntityType: opts.entityType,
      triggerEntityKey: opts.entityKey,
      triggerEntityVenueSlug: opts.entityVenueSlug,
      researchSlug: opts.researchSlug,
      status: "pending",
      createdAt: now,
    });
  }
  return matching.length;
}
