// Rows come off a Convex index in insertion order, not in the order of any
// field they carry. Summaries are written in batches and can arrive out of
// order, so "the first row" and "the row the user sees first" are different
// things, and reading `rows[0]` silently reports the wrong one.
export function lowestBy<T>(rows: readonly T[], rank: (row: T) => number): T | undefined {
  let best: T | undefined;
  for (const row of rows) if (!best || rank(row) < rank(best)) best = row;
  return best;
}
