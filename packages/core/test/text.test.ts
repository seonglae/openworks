import { describe, expect, it } from "vitest";
import { truncateSafe } from "../src/text.ts";

const EMOJI = "\u{1F916}"; // U+1F916, one code point, two UTF-16 code units

// A lone surrogate survives a round trip through a JS string but cannot be
// encoded as UTF-8, which is exactly how this reached production: the value
// looked fine in the handler and only blew up in the response serializer.
const hasLoneSurrogate = (s: string) => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
};

describe("truncateSafe", () => {
  it("returns the input untouched when it already fits", () => {
    expect(truncateSafe("abc", 10)).toBe("abc");
    expect(truncateSafe("abc", 3)).toBe("abc");
  });

  it("cuts plain text at exactly the limit", () => {
    expect(truncateSafe("abcdef", 3)).toBe("abc");
  });

  it("drops the dangling half when the cut splits a surrogate pair", () => {
    // "ab" + emoji: cutting at 3 lands between the emoji's two code units.
    const out = truncateSafe(`ab${EMOJI}`, 3);
    expect(out).toBe("ab");
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it("keeps a surrogate pair that fits whole", () => {
    const out = truncateSafe(`ab${EMOJI}cd`, 4);
    expect(out).toBe(`ab${EMOJI}`);
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it("never emits a lone surrogate at any cut position", () => {
    const s = `TLDR ${EMOJI} OpenAI ${EMOJI}${EMOJI} price cuts ${EMOJI}`;
    for (let n = 0; n <= s.length + 2; n++) {
      const out = truncateSafe(s, n);
      expect(hasLoneSurrogate(out), `cut at ${n} produced a lone surrogate`).toBe(false);
      expect(JSON.parse(JSON.stringify(out))).toBe(out);
      expect(new TextDecoder().decode(new TextEncoder().encode(out))).toBe(out);
    }
  });

  it("treats a non-positive limit as empty", () => {
    expect(truncateSafe("abc", 0)).toBe("");
    expect(truncateSafe("abc", -1)).toBe("");
  });
});
