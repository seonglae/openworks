import { describe, expect, it } from "vitest";
import { lowestBy } from "../src/order.ts";

describe("lowestBy", () => {
  it("finds the lowest rank regardless of array position", () => {
    expect(lowestBy([{ i: 2 }, { i: 0 }, { i: 1 }], (r) => r.i)).toEqual({ i: 0 });
  });

  it("returns undefined for an empty list rather than throwing", () => {
    expect(lowestBy([], (r: { i: number }) => r.i)).toBeUndefined();
  });

  it("keeps the first row of a tie, so the result is stable", () => {
    const first = { i: 0, tag: "a" };
    expect(lowestBy([first, { i: 0, tag: "b" }], (r) => r.i)).toBe(first);
  });

  it("differs from rows[0] exactly when the array is out of order", () => {
    const rows = [{ i: 1 }, { i: 0 }];
    expect(lowestBy(rows, (r) => r.i)).not.toBe(rows[0]);
  });
});
