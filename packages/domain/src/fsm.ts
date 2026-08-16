import type { ResearchKind } from "./enums.ts";

export type { ResearchKind };

// The research lifecycle state machine. Lives here rather than in convex/
// because agent-worker.mts and the browser each kept a hand-synced copy of
// the state list -- agent-worker.mts said so in a comment ("Keep in sync with
// convex/researchFSM.ts"). Self-contained: no imports beyond the vocabulary.

// Research FSM — canonical state definitions, transitions, and labels.
//
// Recent changes:
//   - `iterate` removed (was an edge, not a state)
//   - `ai_review` / `bib_check` / `desk_check` merged into one
//     `pre_submit_check` state; sub-items live in researchChecklists per
//     iteration
//   - `rejected` fans out wider (rework at any layer, not just writing)
//   - `slide` added between takeaway and poster
//   - labels are keyed by (kind, state) so each vocabulary can name its own
//     states; the UI is unambiguous

export const OWN_STATES = [
  "ideation",
  "literature",
  "poc",
  "exp_plan",
  "design",
  "setup",
  "run",
  "analysis",
  "writing",
  "pre_submit_check",
  "submit_workshop",
  "submit_main",
  "reviews",
  "rebuttal",
  "accepted",
  "rejected",
  "takeaway",
  "slide",
  "poster",
] as const;

export const REVIEW_STATES = [
  "setup",
  "lit_review",
  "drafting",
  "ranking",
  "submitted",
  "rebuttal_audit",
  "final",
] as const;

export type OwnState = (typeof OWN_STATES)[number];
export type ReviewState = (typeof REVIEW_STATES)[number];

// Labels are per kind, not per state id: `setup` belongs to both vocabularies
// and names a different thing in each ("exp setup" vs "pdf setup"), so a single
// flat map keyed by state id can only ever be right for one of the two kinds.
// The record types are exhaustive so a new state cannot ship unlabelled.
export const OWN_LABELS: Record<OwnState, string> = {
  ideation: "idea generation",
  literature: "literature review",
  poc: "feasibility poc",
  exp_plan: "exp plan",
  design: "exp design",
  setup: "exp setup",
  run: "exp run",
  analysis: "result analysis",
  writing: "paper writing",
  pre_submit_check: "pre-submit check",
  submit_workshop: "submit workshop",
  submit_main: "submit main",
  reviews: "reviews received",
  rebuttal: "author rebuttal",
  accepted: "paper accepted",
  rejected: "paper rejected",
  takeaway: "takeaway writeup",
  slide: "slide deck",
  poster: "poster session",
};

export const REVIEW_LABELS: Record<ReviewState, string> = {
  setup: "pdf setup",
  lit_review: "literature",
  drafting: "drafting",
  ranking: "ranking",
  submitted: "submitted",
  rebuttal_audit: "rebuttal audit",
  final: "final score",
};

export function labelsFor(kind: ResearchKind): Readonly<Record<string, string>> {
  return kind === "own" ? OWN_LABELS : REVIEW_LABELS;
}

export function labelFor(kind: ResearchKind, state: string): string {
  return labelsFor(kind)[state] ?? state;
}

export const OWN_TRANSITIONS: Record<string, string[]> = {
  ideation: ["literature"],
  literature: ["poc", "ideation"],
  poc: ["exp_plan", "ideation"],
  exp_plan: ["design", "literature"],
  design: ["setup"],
  setup: ["run"],
  run: ["analysis"],
  analysis: ["design", "setup", "writing"],
  writing: ["pre_submit_check", "analysis"],
  pre_submit_check: ["writing", "submit_workshop", "submit_main"],
  submit_workshop: ["reviews"],
  submit_main: ["reviews"],
  reviews: ["rebuttal", "accepted", "rejected"],
  rebuttal: ["writing", "accepted", "rejected"],
  accepted: ["takeaway"],
  rejected: ["ideation", "literature", "exp_plan", "design", "analysis", "writing", "takeaway"],
  takeaway: ["slide"],
  slide: ["poster"],
  poster: [],
};

export const REVIEW_TRANSITIONS: Record<string, string[]> = {
  setup: ["lit_review"],
  lit_review: ["drafting"],
  drafting: ["ranking"],
  ranking: ["drafting", "submitted"],
  submitted: ["rebuttal_audit"],
  rebuttal_audit: ["final"],
  final: [],
};

// pre_submit_check sub-items — rendered as a checklist when the user clicks
// that node in the FSM diagram. Same shape every iteration; rows keyed by
// (researchSlug, iterationN, itemKey).
export const PRE_SUBMIT_CHECK_ITEMS = [
  { key: "ai_writing", label: "AI writing check" },
  { key: "internal_numbering", label: "internal numbering removed" },
  { key: "internal_term", label: "internal term removed" },
  { key: "bib", label: "references.bib check" },
  { key: "desk", label: "desk rejection check" },
  { key: "storytelling", label: "storytelling check" },
  { key: "concl_abstract_lim", label: "conclusion / abstract / limitation check" },
  { key: "over_engineering", label: "over-engineering details check" },
] as const;

export function statesFor(kind: ResearchKind): readonly string[] {
  return kind === "own" ? OWN_STATES : REVIEW_STATES;
}

export function transitionsFor(kind: ResearchKind): Record<string, string[]> {
  return kind === "own" ? OWN_TRANSITIONS : REVIEW_TRANSITIONS;
}

export function isValidState(kind: ResearchKind, state: string): boolean {
  return (statesFor(kind) as readonly string[]).includes(state);
}

export function canTransition(kind: ResearchKind, from: string, to: string): boolean {
  if (!isValidState(kind, to)) return false;
  const allowed = transitionsFor(kind)[from] ?? [];
  return allowed.includes(to);
}

export function nextStates(kind: ResearchKind, from: string): string[] {
  return transitionsFor(kind)[from] ?? [];
}

export function initialState(kind: ResearchKind): string {
  return kind === "own" ? "ideation" : "setup";
}
