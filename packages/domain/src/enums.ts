// Openworks's closed vocabularies, in the spelling and order convex/schema.ts uses.
// They were previously written out once per consumer — ENTITY_TYPES in ten
// places, AUTHOR_TYPES in seven — across three encodings (Convex v.union, zod
// enum, hand-written TS union). Nothing here knows about Convex or zod: each
// tier derives its own validator from these arrays, which is what keeps the
// package importable from plain node and out of the browser's dependency graph.

export const ENTITY_TYPES = ["research", "memo", "experiment", "table", "figure", "venue", "section", "tex"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const AUTHOR_TYPES = ["user", "agent"] as const;
export type AuthorType = (typeof AUTHOR_TYPES)[number];

export const AGENT_EVENT_TYPES = ["entity.created", "entity.updated", "state.transitioned", "comment.posted"] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export const SUBSCRIPTION_SCOPES = ["global", "project", "workspace"] as const;
export type SubscriptionScope = (typeof SUBSCRIPTION_SCOPES)[number];

export const EXPERIMENT_STATUSES = ["planned", "running", "done", "failed"] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];
export const EXPERIMENT_STATUS_DEFAULT: ExperimentStatus = "planned";

export const RESEARCH_KINDS = ["own", "review"] as const;
export type ResearchKind = (typeof RESEARCH_KINDS)[number];

export const JOB_TYPES = ["newsletter", "paper", "article", "pr-fix"] as const;
export type JobType = (typeof JOB_TYPES)[number];

// Where a researchPapers row came from. This is what the table stores, and
// convex/schema.ts derives its column from it.
//
// convex/researchPapers.ts deliberately accepts a NARROWER set: it omits
// `bibtex`, which only the citation-promotion path writes. Widening it there
// looks like the obvious fix and is not, because replaceForResearch deletes
// every row for a slug and reinserts only the six fields its validator names,
// so letting a promoted citation back through that path would silently drop
// its pdfRelPath and fullText. The narrowing is a guard, not drift, until that
// mutation stops being lossy.
export const PAPER_SOURCES = ["arxiv", "openreview", "manual", "bibtex"] as const;
export type PaperSource = (typeof PAPER_SOURCES)[number];

export const JOB_STATUSES = [
  "pending",
  "summarizing",
  "suggesting",
  "suggested",
  "executing",
  "done",
  "error",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// Statuses the pipeline is finished with: no worker will touch the job again
// without a user action. `suggested` counts because the agent's work is done
// and it is waiting on a human, not on a worker. Not the same as the set
// mailbox requests use, which have no `suggested`.
export const TERMINAL_JOB_STATUSES = ["suggested", "done", "error"] as const;

export function isTerminalJobStatus(status: string): boolean {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(status);
}
