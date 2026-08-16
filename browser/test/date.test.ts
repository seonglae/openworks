import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addDays, dateParts, localDate } from "../src/shared/date";

// date.ts claims DST never shifts a day because the math runs on UTC epochs.
// Node reads the ambient zone from process.env.TZ on every Date call, so the
// claim is checkable: run the same fixtures under zones that actually spring
// forward and fall back, and under one that never does.
const ZONES = [
  { tz: "UTC", localHourAtNoonUtcInJuly: 12 },
  { tz: "America/New_York", localHourAtNoonUtcInJuly: 8 },
  { tz: "Europe/Berlin", localHourAtNoonUtcInJuly: 14 },
  { tz: "Asia/Seoul", localHourAtNoonUtcInJuly: 21 },
] as const;

const originalTz = process.env.TZ;

const restoreTz = () => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
};

describe("addDays", () => {
  for (const zone of ZONES) {
    describe(`with the process in ${zone.tz}`, () => {
      beforeEach(() => {
        process.env.TZ = zone.tz;
        // Without tzdata node silently answers in UTC, which would make every
        // DST case below pass for the wrong reason.
        expect(new Date("2026-07-01T12:00:00Z").getHours()).toBe(zone.localHourAtNoonUtcInJuly);
      });
      afterEach(restoreTz);

      it("counts one day across the US spring-forward night", () => {
        expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
        expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
        expect(addDays("2026-03-07", 3)).toBe("2026-03-10");
      });

      it("counts one day across the US fall-back night", () => {
        expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
        expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
        expect(addDays("2026-10-31", 3)).toBe("2026-11-03");
      });

      it("counts one day across the EU spring-forward night", () => {
        expect(addDays("2026-03-28", 1)).toBe("2026-03-29");
        expect(addDays("2026-03-29", 1)).toBe("2026-03-30");
      });

      it("counts one day across the EU fall-back night", () => {
        expect(addDays("2026-10-24", 1)).toBe("2026-10-25");
        expect(addDays("2026-10-25", 1)).toBe("2026-10-26");
      });

      it("lands on the same date whether a year is walked one day at a time or jumped at once", () => {
        let walked = "2026-01-01";
        for (let i = 0; i < 365; i++) walked = addDays(walked, 1);
        expect(walked).toBe(addDays("2026-01-01", 365));
        expect(walked).toBe("2027-01-01");
      });
    });
  }

  it("rolls into the next month at a month end", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-04-30", 1)).toBe("2026-05-01");
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
  });

  it("keeps the leap day in a leap year", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2024-02-29", 1)).toBe("2024-03-01");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
  });

  it("rolls into the next year at a year end", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-12-31", 366)).toBe("2028-01-01");
  });

  it("walks backwards for a negative count", () => {
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-11-01", -1)).toBe("2026-10-31");
    expect(addDays("2027-01-01", -365)).toBe("2026-01-01");
  });

  it("returns the same date for a zero count", () => {
    expect(addDays("2026-08-03", 0)).toBe("2026-08-03");
    expect(addDays("2026-01-01", 0)).toBe("2026-01-01");
  });

  it("returns to the starting date when a step is undone", () => {
    for (let n = -400; n <= 400; n += 37) {
      expect(addDays(addDays("2026-03-08", n), -n)).toBe("2026-03-08");
    }
  });

  it("pads single-digit months and days so results sort as strings", () => {
    // PlansView compares these with `<` / `>=`, which only works zero-padded.
    expect(addDays("2026-01-05", 1)).toBe("2026-01-06");
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-01-01", 8)).toBe("2026-01-09");
  });
});

describe("dateParts", () => {
  it("splits a date string into a year, a one-based month and a day", () => {
    expect(dateParts("2026-08-03")).toEqual([2026, 8, 3]);
    expect(dateParts("2024-02-29")).toEqual([2024, 2, 29]);
    expect(dateParts("1999-12-31")).toEqual([1999, 12, 31]);
  });
});

describe("localDate", () => {
  afterEach(restoreTz);

  it("names the day the user is living in, not the UTC one", () => {
    process.env.TZ = "America/New_York";
    expect(localDate(new Date("2026-03-09T02:00:00Z"))).toBe("2026-03-08");
    process.env.TZ = "Asia/Seoul";
    expect(localDate(new Date("2026-03-08T20:00:00Z"))).toBe("2026-03-09");
    process.env.TZ = "UTC";
    expect(localDate(new Date("2026-03-09T02:00:00Z"))).toBe("2026-03-09");
  });

  it("emits exactly the zero-padded shape addDays parses back", () => {
    for (const zone of ZONES) {
      process.env.TZ = zone.tz;
      for (const iso of ["2026-01-05T12:00:00Z", "2026-09-30T12:00:00Z", "2026-12-31T12:00:00Z"]) {
        const today = localDate(new Date(iso));
        expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(addDays(today, 0)).toBe(today);
      }
    }
  });

  it("agrees with addDays on which day follows today, in every zone", () => {
    // The pair is only consistent because addDays treats the string as an
    // abstract calendar date: it never re-reads the ambient zone.
    const instant = new Date("2026-03-08T20:00:00Z");
    const expected: Record<string, [string, string]> = {
      UTC: ["2026-03-08", "2026-03-09"],
      "America/New_York": ["2026-03-08", "2026-03-09"],
      "Europe/Berlin": ["2026-03-08", "2026-03-09"],
      "Asia/Seoul": ["2026-03-09", "2026-03-10"],
    };
    for (const zone of ZONES) {
      process.env.TZ = zone.tz;
      const today = localDate(instant);
      expect([today, addDays(today, 1)]).toEqual(expected[zone.tz]);
    }
  });

  it("still names the local day on the two nights the clock jumps", () => {
    process.env.TZ = "America/New_York";
    // 06:30Z on 2026-03-08 is 01:30 EST, the hour before the clock skips to 03:00.
    expect(localDate(new Date("2026-03-08T06:30:00Z"))).toBe("2026-03-08");
    // 05:30Z on 2026-11-01 is 01:30 EDT, the first of the two 01:30s that night.
    expect(localDate(new Date("2026-11-01T05:30:00Z"))).toBe("2026-11-01");
    expect(localDate(new Date("2026-11-01T06:30:00Z"))).toBe("2026-11-01");
  });
});
