import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { discoverProjects } from "../scripts/config.mjs";

const SCRIPTS = resolve(process.cwd(), "scripts");

// Node resolves a relative import against the importing file, so moving a
// script into a directory breaks every `./` specifier in it. Nothing else here
// notices: the scripts are entry points, so no test imports them, tsc does not
// read .mjs, and the failure only appears when someone runs one by hand and
// gets ERR_MODULE_NOT_FOUND before a line of it executes.
describe("the operator scripts", () => {
  const scripts = readdirSync(SCRIPTS).filter((f) => f.endsWith(".mjs") || f.endsWith(".mts"));

  it("are all there", () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  it.each(scripts)("%s imports only files that exist", (name) => {
    const file = join(SCRIPTS, name);
    const source = readFileSync(file, "utf8");
    const specifiers = [...source.matchAll(/^\s*import\s[^"']*["'](\.[^"']+)["']/gm)].map((m) => m[1]);
    for (const spec of specifiers) {
      expect(existsSync(resolve(dirname(file), spec)), `${name} imports ${spec}`).toBe(true);
    }
  });
});

// The list used to be written into the source, which named one person's
// checkouts and was wrong on every other machine.
describe("project discovery", () => {
  const root = mkdtempSync(join(tmpdir(), "openworks-projects-"));
  mkdirSync(join(root, "MyProject", ".git"), { recursive: true });
  mkdirSync(join(root, "other-thing", ".git"), { recursive: true });
  mkdirSync(join(root, "not-a-checkout"), { recursive: true });
  mkdirSync(join(root, ".hidden", ".git"), { recursive: true });

  it("finds the git checkouts beside the repo and slugs their names", () => {
    process.env.OPENWORKS_PROJECTS_ROOT = root;
    expect(discoverProjects()).toEqual({ "my-project": "MyProject", "other-thing": "other-thing" });
    delete process.env.OPENWORKS_PROJECTS_ROOT;
  });

  it("returns nothing rather than throwing when the root does not exist", () => {
    process.env.OPENWORKS_PROJECTS_ROOT = join(root, "absent");
    expect(discoverProjects()).toEqual({});
    delete process.env.OPENWORKS_PROJECTS_ROOT;
  });
});
