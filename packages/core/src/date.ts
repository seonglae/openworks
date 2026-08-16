// Calendar math on YYYY-MM-DD strings, done through UTC epochs so a DST shift
// can never move a day. The string is treated as an abstract calendar date, not
// an instant, so this never reads the ambient timezone and gives the same answer
// everywhere. Deciding WHICH day is "today" is a separate question that belongs
// to the caller: the browser uses its local calendar, the backend falls back to
// UTC, and they disagree for nine hours a day at UTC+9.
export function dateParts(dateStr: string): [number, number, number] {
  const [y, m, d] = dateStr.split("-").map(Number);
  return [y, m, d];
}

export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateParts(dateStr);
  // Date.UTC normalises overflow, so d + n crossing a month or year end is
  // handled without any branching.
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
