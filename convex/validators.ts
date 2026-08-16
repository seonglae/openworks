// Bridges @openworks/domain's plain string vocabularies into Convex validators.
// The vocabularies stay dependency-free so plain node and the browser can
// import them; only this file, inside convex/, knows about `v`.

import { v } from "convex/values";
import type { Validator } from "convex/values";

// v.union needs at least two members and each literal typed individually, so
// the spread is written out rather than mapped through a loose signature.
export function literals<T extends string>(values: readonly T[]) {
  const members = values.map((val) => v.literal(val));
  return v.union(...(members as unknown as [Validator<T>, Validator<T>, ...Validator<T>[]]));
}
