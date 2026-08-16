// Every tab a `?tab=` deep link may name. MODES (the nav bar) is a subset:
// `authors` has no slot of its own and opens under the Paper tab's subnav.
export const MODE_KEYS = [
  "newsletter",
  "paper",
  "article",
  "pr",
  "plan",
  "research",
  "diet",
  "vocab",
  "insights",
  "usage",
  "authors",
] as const;

export type Mode = (typeof MODE_KEYS)[number];
