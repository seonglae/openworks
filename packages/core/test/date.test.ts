import { describe, expect, it } from "vitest";
import { addDays, dateParts } from "../src/date.ts";

// Pinned under four zones. Without the guard a missing tzdata would silently
// run every case in UTC and they would all pass for the wrong reason.
const zones = ["UTC", "America/New_York", "Europe/Berlin", "Asia/Seoul"];

describe("addDays", () => {
  it("is unaffected by the ambient timezone, including across DST boundaries", () => {
    const original = process.env.TZ;
    try {
      for (const tz of zones) {
        process.env.TZ = tz;
        expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(tz);
        // US spring-forward and fall-back, EU spring-forward and fall-back.
        expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
        expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
        expect(addDays("2026-03-29", 1)).toBe("2026-03-30");
        expect(addDays("2026-10-25", 1)).toBe("2026-10-26");
      }
    } finally {
      // Assigning undefined would store the literal string "undefined" and
      // break zone resolution for everything after this test.
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("crosses month, year and leap-day boundaries", () => {
    expect(addDays("2025-08-31", 1)).toBe("2025-09-01");
    expect(addDays("2025-12-31", 1)).toBe("2026-01-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2023-02-28", 1)).toBe("2023-03-01");
  });

  it("goes backwards and round-trips", () => {
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays(addDays("2025-06-15", 40), -40)).toBe("2025-06-15");
  });

  it("zero-pads, because callers compare these strings with < and >=", () => {
    expect(addDays("2025-01-09", 0)).toBe("2025-01-09");
    expect(addDays("2025-09-30", 1)).toBe("2025-10-01");
  });

  it("agrees with 365 single steps", () => {
    let walked = "2025-01-01";
    for (let i = 0; i < 365; i++) walked = addDays(walked, 1);
    expect(walked).toBe(addDays("2025-01-01", 365));
  });

  it("splits a date into numeric parts", () => {
    expect(dateParts("2025-01-09")).toEqual([2025, 1, 9]);
  });
});
