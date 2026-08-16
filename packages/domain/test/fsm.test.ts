import { describe, expect, it } from "vitest";
import {
  OWN_LABELS,
  OWN_STATES,
  OWN_TRANSITIONS,
  REVIEW_LABELS,
  REVIEW_STATES,
  REVIEW_TRANSITIONS,
  canTransition,
  initialState,
  isValidState,
  labelFor,
  labelsFor,
  nextStates,
  statesFor,
} from "../src/fsm.ts";
import { RESEARCH_KINDS } from "../src/enums.ts";

describe("FSM shape", () => {
  it.each(RESEARCH_KINDS)("every %s transition points at a declared state", (kind) => {
    const states = new Set(statesFor(kind));
    const graph = kind === "own" ? OWN_TRANSITIONS : REVIEW_TRANSITIONS;
    for (const [from, tos] of Object.entries(graph)) {
      expect(states.has(from), `${from} is a source but not a state`).toBe(true);
      for (const to of tos) expect(states.has(to), `${from} -> ${to} targets an unknown state`).toBe(true);
    }
  });

  it.each(RESEARCH_KINDS)("every %s state is reachable from the initial state", (kind) => {
    const graph = kind === "own" ? OWN_TRANSITIONS : REVIEW_TRANSITIONS;
    const seen = new Set([initialState(kind)]);
    const queue = [initialState(kind)];
    while (queue.length) {
      for (const to of graph[queue.shift()!] ?? []) {
        if (!seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
    }
    // An unreachable state can never be advanced into, so `advance` would
    // reject it forever while the UI still offers it.
    expect([...statesFor(kind)].filter((s) => !seen.has(s))).toEqual([]);
  });

  it("has no duplicate states", () => {
    expect(new Set(OWN_STATES).size).toBe(OWN_STATES.length);
    expect(new Set(REVIEW_STATES).size).toBe(REVIEW_STATES.length);
  });

  it("starts each kind at its first declared state", () => {
    expect(initialState("own")).toBe(OWN_STATES[0]);
    expect(initialState("review")).toBe(REVIEW_STATES[0]);
  });
});

describe("labels", () => {
  it.each(RESEARCH_KINDS)("labels every %s state", (kind) => {
    const labels = labelsFor(kind);
    expect(Object.keys(labels).sort()).toEqual([...statesFor(kind)].sort());
    for (const state of statesFor(kind)) expect(labelFor(kind, state)).toBe(labels[state]);
  });

  it("names the shared `setup` state per kind", () => {
    // The whole reason labels are keyed by (kind, state): one flat map keyed by
    // state id can only hold one of these two.
    expect(labelFor("own", "setup")).toBe("exp setup");
    expect(labelFor("review", "setup")).toBe("pdf setup");
  });

  it("pins the review labels to the text the UI renders", () => {
    expect(REVIEW_STATES.map((s) => labelFor("review", s))).toEqual([
      "pdf setup",
      "literature",
      "drafting",
      "ranking",
      "submitted",
      "rebuttal audit",
      "final score",
    ]);
  });

  it("pins the own labels to the text the UI renders", () => {
    expect(OWN_STATES.map((s) => labelFor("own", s))).toEqual([
      "idea generation",
      "literature review",
      "feasibility poc",
      "exp plan",
      "exp design",
      "exp setup",
      "exp run",
      "result analysis",
      "paper writing",
      "pre-submit check",
      "submit workshop",
      "submit main",
      "reviews received",
      "author rebuttal",
      "paper accepted",
      "paper rejected",
      "takeaway writeup",
      "slide deck",
      "poster session",
    ]);
  });

  it("does not leak one kind's vocabulary into the other", () => {
    expect(OWN_LABELS).not.toHaveProperty("lit_review");
    expect(REVIEW_LABELS).not.toHaveProperty("ideation");
  });

  it("falls back to the raw id for a state it does not know", () => {
    // Timelines can hold states retired from the vocabulary; they still render.
    expect(labelFor("own", "not_a_state")).toBe("not_a_state");
  });
});

describe("transition rules", () => {
  it("permits only declared edges", () => {
    expect(canTransition("own", "ideation", "literature")).toBe(true);
    expect(canTransition("own", "ideation", "poster")).toBe(false);
  });

  it("rejects a target that is not a state of that kind", () => {
    // `setup` is valid for both kinds but `lit_review` belongs to review only.
    expect(canTransition("own", "setup", "lit_review")).toBe(false);
    expect(canTransition("review", "setup", "lit_review")).toBe(true);
  });

  it("keeps the two kinds' vocabularies apart", () => {
    expect(isValidState("own", "lit_review")).toBe(false);
    expect(isValidState("review", "ideation")).toBe(false);
  });

  it("reports terminal states as having no next move", () => {
    expect(nextStates("own", "poster")).toEqual([]);
    expect(nextStates("review", "final")).toEqual([]);
  });

  it("returns no moves for an unknown source rather than throwing", () => {
    expect(nextStates("own", "not_a_state")).toEqual([]);
  });
});
