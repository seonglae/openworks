// FSM graph geometry, split out of ResearchView so that file exports only its
// component and stays Fast Refreshable.
import { labelFor, type OwnState, type ReviewState } from "@openworks/domain";

export type FsmNode = { id: string; label: string; x: number; y: number; group?: string };
export type FsmEdge = { from: string; to: string; label?: string; kind: "forward" | "backward" };

// Own research FSM. Ids, their order and their labels come from @openworks/domain:
// this file used to hand-restate all three. Only the layout is view data.
const OWN_LAYOUT: [id: OwnState, x: number, y: number, group: string][] = [
  ["ideation", 60, 40, "idea"],
  ["literature", 240, 40, "idea"],
  ["poc", 420, 40, "idea"],
  ["exp_plan", 600, 40, "exp"],
  ["design", 60, 160, "exp"],
  ["setup", 240, 160, "exp"],
  ["run", 420, 160, "exp"],
  ["analysis", 600, 160, "exp"],
  ["writing", 60, 300, "paper"],
  ["pre_submit_check", 300, 300, "paper"],
  ["submit_workshop", 540, 300, "submit"],
  ["submit_main", 760, 300, "submit"],
  ["reviews", 540, 430, "feedback"],
  ["rebuttal", 780, 430, "feedback"],
  ["accepted", 420, 550, "end"],
  ["rejected", 640, 550, "end"],
  ["takeaway", 420, 670, "present"],
  ["slide", 240, 790, "present"],
  ["poster", 540, 790, "present"],
];

export const OWN_NODES: FsmNode[] = OWN_LAYOUT.map(([id, x, y, group]) => ({
  id,
  label: labelFor("own", id),
  x,
  y,
  group,
}));

export const OWN_EDGES: FsmEdge[] = [
  { from: "ideation", to: "literature", kind: "forward" },
  { from: "literature", to: "poc", kind: "forward" },
  { from: "poc", to: "exp_plan", kind: "forward" },
  { from: "exp_plan", to: "design", kind: "forward" },
  { from: "exp_plan", to: "literature", kind: "backward", label: "more lit" },
  { from: "design", to: "setup", kind: "forward" },
  { from: "setup", to: "run", kind: "forward" },
  { from: "run", to: "analysis", kind: "forward" },
  { from: "analysis", to: "design", kind: "backward", label: "new design" },
  { from: "analysis", to: "setup", kind: "backward", label: "tune setup" },
  { from: "analysis", to: "writing", kind: "forward", label: "results ready" },
  { from: "writing", to: "pre_submit_check", kind: "forward" },
  { from: "pre_submit_check", to: "writing", kind: "backward", label: "revise" },
  { from: "pre_submit_check", to: "submit_workshop", kind: "forward" },
  { from: "pre_submit_check", to: "submit_main", kind: "forward" },
  { from: "submit_workshop", to: "reviews", kind: "forward" },
  { from: "submit_main", to: "reviews", kind: "forward" },
  { from: "reviews", to: "rebuttal", kind: "forward", label: "main only" },
  { from: "reviews", to: "accepted", kind: "forward", label: "workshop" },
  { from: "reviews", to: "rejected", kind: "forward" },
  { from: "rebuttal", to: "writing", kind: "backward", label: "camera-ready" },
  { from: "rebuttal", to: "accepted", kind: "forward" },
  { from: "rebuttal", to: "rejected", kind: "forward" },
  { from: "rejected", to: "writing", kind: "backward", label: "rewrite" },
  { from: "rejected", to: "analysis", kind: "backward", label: "more results" },
  { from: "rejected", to: "design", kind: "backward", label: "redesign" },
  { from: "rejected", to: "exp_plan", kind: "backward", label: "replan" },
  { from: "rejected", to: "literature", kind: "backward", label: "more lit" },
  { from: "rejected", to: "ideation", kind: "backward", label: "pivot" },
  { from: "rejected", to: "takeaway", kind: "forward", label: "lessons" },
  { from: "literature", to: "ideation", kind: "backward", label: "duplicated" },
  { from: "poc", to: "ideation", kind: "backward", label: "infeasible" },
  { from: "writing", to: "analysis", kind: "backward", label: "more exp" },
  { from: "accepted", to: "takeaway", kind: "forward" },
  { from: "takeaway", to: "slide", kind: "forward" },
  { from: "slide", to: "poster", kind: "forward" },
];

// Review pipeline (reviewing others). Same deal as own: only the layout is
// view data, the labels are looked up per kind so `setup` reads "pdf setup"
// here and "exp setup" in the own graph.
const REVIEW_LAYOUT: [id: ReviewState, x: number, y: number][] = [
  ["setup", 60, 40],
  ["lit_review", 260, 40],
  ["drafting", 460, 40],
  ["ranking", 660, 40],
  ["submitted", 60, 180],
  ["rebuttal_audit", 260, 180],
  ["final", 460, 180],
];

export const REVIEW_NODES: FsmNode[] = REVIEW_LAYOUT.map(([id, x, y]) => ({
  id,
  label: labelFor("review", id),
  x,
  y,
}));

export const REVIEW_EDGES: FsmEdge[] = [
  { from: "setup", to: "lit_review", kind: "forward" },
  { from: "lit_review", to: "drafting", kind: "forward" },
  { from: "drafting", to: "ranking", kind: "forward" },
  { from: "ranking", to: "drafting", kind: "backward", label: "revise" },
  { from: "ranking", to: "submitted", kind: "forward" },
  { from: "submitted", to: "rebuttal_audit", kind: "forward" },
  { from: "rebuttal_audit", to: "final", kind: "forward" },
];
