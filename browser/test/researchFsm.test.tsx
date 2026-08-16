import { describe, expect, it } from "vitest";
import { OWN_TRANSITIONS, OWN_STATES, REVIEW_STATES, REVIEW_TRANSITIONS, labelFor } from "@openworks/domain";
import { OWN_EDGES, OWN_NODES, REVIEW_EDGES, REVIEW_NODES } from "../src/shared/fsmGraph";

// The diagram's node ids, labels and edges are the FSM. They were hand-synced
// against the backend copy before @openworks/domain existed, and drifted. Ids,
// order and labels are now derived, but the edges still carry view-only
// annotations (forward/backward, hop labels), so they stay written out here and
// this test is what keeps them honest.
const adjacency = (edges: readonly { from: string; to: string }[]) => {
  const out: Record<string, string[]> = {};
  for (const e of edges) (out[e.from] ??= []).push(e.to);
  for (const key of Object.keys(out)) out[key].sort();
  return out;
};

// A state with no outgoing transition is absent from the drawn edge list but
// present in the domain map as an empty array.
const nonTerminal = (transitions: Record<string, string[]>) =>
  Object.fromEntries(
    Object.entries(transitions)
      .filter(([, to]) => to.length > 0)
      .map(([from, to]) => [from, [...to].sort()]),
  );

describe("research FSM diagram", () => {
  it("draws every own state, in the domain's order", () => {
    expect(OWN_NODES.map((n) => n.id)).toEqual([...OWN_STATES]);
  });

  it("draws every review state, in the domain's order", () => {
    expect(REVIEW_NODES.map((n) => n.id)).toEqual([...REVIEW_STATES]);
  });

  // The visible text, spelled out. `setup` is in both vocabularies and reads
  // differently in each, which is exactly what a state-id-keyed label map got
  // wrong, so these lists are pinned literally rather than derived twice.
  it("labels the own nodes with the text the user reads", () => {
    expect(OWN_NODES.map((n) => n.label)).toEqual([
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

  it("labels the review nodes with the text the user reads", () => {
    expect(REVIEW_NODES.map((n) => n.label)).toEqual([
      "pdf setup",
      "literature",
      "drafting",
      "ranking",
      "submitted",
      "rebuttal audit",
      "final score",
    ]);
  });

  it("takes every node label from the domain, per kind", () => {
    expect(OWN_NODES.map((n) => n.label)).toEqual(OWN_STATES.map((s) => labelFor("own", s)));
    expect(REVIEW_NODES.map((n) => n.label)).toEqual(REVIEW_STATES.map((s) => labelFor("review", s)));
  });

  it("keeps the shared `setup` id reading differently in each graph", () => {
    expect(OWN_NODES.find((n) => n.id === "setup")?.label).toBe("exp setup");
    expect(REVIEW_NODES.find((n) => n.id === "setup")?.label).toBe("pdf setup");
  });

  it("draws exactly the own transitions the domain allows", () => {
    expect(adjacency(OWN_EDGES)).toEqual(nonTerminal(OWN_TRANSITIONS));
  });

  it("draws exactly the review transitions the domain allows", () => {
    expect(adjacency(REVIEW_EDGES)).toEqual(nonTerminal(REVIEW_TRANSITIONS));
  });

  it("draws no edge twice", () => {
    for (const edges of [OWN_EDGES, REVIEW_EDGES]) {
      const keys = edges.map((e) => `${e.from}->${e.to}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});
