import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(resolve(__dirname, "../src/index.css"), "utf8");
const site = readFileSync(resolve(__dirname, "../../site/src/styles/site.css"), "utf8");

function tokens(css: string, marker: string): Record<string, string> {
  const start = css.indexOf(marker);
  const block = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    [...block.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((match) => [match[1], match[2]]),
  );
}
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const light = tokens(app, "@theme {");
const dark = { ...light, ...tokens(app, "html.dark {") };
for (const [name, theme, marketing] of [
  ["light", light, tokens(site, ":root {")],
  ["dark", dark, tokens(site, ':root[data-theme="dark"] {')],
] as const) {
  describe(`${name} theme`, () => {
    for (const fg of ["ink", "ink-2", "ink-3", "ink-4", "rust"]) {
      for (const bg of ["paper", "paper-warm"]) {
        it(`${fg} reads at 4.5:1 on ${bg}`, () => {
          const values = [luminance(theme[fg]), luminance(theme[bg])].sort((a, b) => b - a);
          expect((values[0] + 0.05) / (values[1] + 0.05)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
    it("shares all public palette tokens with the marketing site", () => {
      for (const [key, value] of Object.entries(theme)) {
        if (key === "rust-deep") continue;
        expect(marketing[key], key).toBe(value);
      }
    });
  });
}
