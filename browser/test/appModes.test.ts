import { describe, expect, it, vi } from "vitest";
import { MODE_KEYS, type Mode } from "../src/shared/types";

// Excalidraw's dist reaches for an extension-less "roughjs/bin/rough", which
// node's resolver rejects. Only the drawings tab needs it, so it is stubbed to
// keep the App module importable here.
vi.mock("../src/DrawingsView", () => ({ DrawingsView: () => null, DrawingGallery: () => null }));

const { fallbackMode, MODES } = await import("../src/shared/modes");

const visible = (...keys: Mode[]) => keys.map((key) => ({ key }));

// The invariant under test: a `?tab=` key with no MODES slot is subnav-only.
// Derived, so a subnav-only mode added to MODE_KEYS tomorrow joins the cases
// below instead of quietly falling outside them.
const subnavOnly = MODE_KEYS.filter((key) => !MODES.some((m) => m.key === key));

describe("tab fallback", () => {
  it("keeps a tab that is in the enabled set", () => {
    expect(fallbackMode("paper", visible("newsletter", "paper"))).toBeNull();
  });

  it("falls back to the first enabled tab when the current one was disabled", () => {
    expect(fallbackMode("diet", visible("newsletter", "paper"))).toBe("newsletter");
  });

  it("stays put when nothing is enabled, so the user is never stranded", () => {
    expect(fallbackMode("diet", visible())).toBeNull();
  });

  it("keeps a ?tab= deep link that has no nav slot of its own", () => {
    // `authors` opens under the Paper subnav, so it can never appear in the
    // enabled set and must not be treated as a disabled tab.
    expect(fallbackMode("authors", visible("newsletter", "paper"))).toBeNull();
  });

  it("keeps any future subnav-only mode, not just the one that ships today", () => {
    // Stands in for the next MODE_KEYS entry added without a nav slot: the
    // guard has to ask MODES, not compare against a hardcoded key.
    expect(fallbackMode("ghost" as Mode, visible("newsletter"))).toBeNull();
  });

  it("exempts every mode that has no nav slot, whatever MODE_KEYS grows to hold", () => {
    expect(subnavOnly.length).toBeGreaterThan(0);
    for (const key of subnavOnly) expect(fallbackMode(key, visible("newsletter"))).toBeNull();
  });

  // Spelled out rather than derived from MODES. Deriving both sides would make
  // this pass when a nav tab is accidentally dropped from MODES while it stays
  // in MODE_KEYS, which is the failure it exists to catch.
  it("routes every nav tab, so the deep-link vocabulary stays covered", () => {
    const stranded = MODE_KEYS.filter((key) => fallbackMode(key, visible("newsletter")) === null);
    expect(stranded).toEqual(["newsletter", "authors"]);
  });
});
