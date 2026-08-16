import { describe, expect, it } from "vitest";
import * as domain from "../src/enums.ts";

const VOCABULARIES = [
  "ENTITY_TYPES",
  "AUTHOR_TYPES",
  "AGENT_EVENT_TYPES",
  "SUBSCRIPTION_SCOPES",
  "EXPERIMENT_STATUSES",
  "RESEARCH_KINDS",
  "JOB_TYPES",
  "JOB_STATUSES",
  "PAPER_SOURCES",
] as const;

describe("vocabularies", () => {
  it.each(VOCABULARIES)("%s has unique members", (name) => {
    const values = domain[name] as readonly string[];
    expect(new Set(values).size).toBe(values.length);
  });

  it.each(VOCABULARIES)("%s has at least two members, as Convex v.union requires", (name) => {
    expect((domain[name] as readonly string[]).length).toBeGreaterThan(1);
  });

  it("pins the member order, because it is the order every derived validator emits", () => {
    expect(domain.ENTITY_TYPES).toEqual([
      "research",
      "memo",
      "experiment",
      "table",
      "figure",
      "venue",
      "section",
      "tex",
    ]);
    expect(domain.AUTHOR_TYPES).toEqual(["user", "agent"]);
    expect(domain.AGENT_EVENT_TYPES).toEqual([
      "entity.created",
      "entity.updated",
      "state.transitioned",
      "comment.posted",
    ]);
    expect(domain.JOB_TYPES).toEqual(["newsletter", "paper", "article", "pr-fix"]);
    expect(domain.PAPER_SOURCES).toEqual(["arxiv", "openreview", "manual", "bibtex"]);
  });

  it("keeps the experiment default inside its own vocabulary", () => {
    expect(domain.EXPERIMENT_STATUSES).toContain(domain.EXPERIMENT_STATUS_DEFAULT);
  });
});
