// Calendar math lives in @openworks/core so the backend shares one implementation:
// expressions.ts had its own copy built on Date.parse, which agreed on every
// well-formed date and threw on a malformed one.
export { addDays, dateParts } from "@openworks/core";

// Stays here: the LOCAL calendar day is a browser concept. The backend
// deliberately falls back to UTC, and the two disagree for nine hours a day at
// UTC+9, which is why day-keyed queries take `today` from the caller.
export const localDate = (d: Date): string => d.toLocaleDateString("en-CA");
