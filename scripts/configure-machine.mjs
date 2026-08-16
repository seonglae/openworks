#!/usr/bin/env node
// Initialize/update local config file and sync to Convex machineConfig
// Usage: node configure-machine.mjs           — interactive print + save defaults
//        node configure-machine.mjs --sync    — push to Convex

import { execSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync, statSync } from "fs";
import { resolve, join } from "path";
import { loadConfig, getProjectsRoot, listKnownProjects, saveConfig, getHostname } from "./config.mjs";

const DEPLOYMENT = process.env.CONVEX_DEPLOYMENT;
if (!DEPLOYMENT) throw new Error("CONVEX_DEPLOYMENT is unset; set it or run through a shell that exports it");

function convexRun(fn, argsObj) {
  const tmp = `/tmp/cfg-args-${Date.now()}.json`;
  writeFileSync(tmp, JSON.stringify(argsObj));
  try {
    execSync(`CONVEX_DEPLOYMENT=${DEPLOYMENT} ./node_modules/.bin/convex run ${fn} "$(cat ${tmp})"`, {
      stdio: "inherit",
      timeout: 30_000,
    });
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

const args = process.argv.slice(2);
const SYNC = args.includes("--sync");

const existing = loadConfig();
const root = getProjectsRoot();
const projects = listKnownProjects();

console.log(`Machine ID: ${getHostname()}`);
console.log(`Projects root: ${root}`);
console.log(`Known projects:`);
const validated = {};
for (const [slug, rel] of Object.entries(projects)) {
  const abs = rel.startsWith("/") ? rel : join(root, rel);
  const ok = existsSync(abs) && statSync(abs).isDirectory();
  console.log(`  ${ok ? "✓" : "✗"} ${slug} → ${abs}`);
  if (ok) validated[slug] = rel;
}

if (!existing) {
  saveConfig({ projectsRoot: root, projects: validated });
  console.log(`\n[config] created ~/.config/openworks/config.json with ${Object.keys(validated).length} projects`);
} else {
  console.log(`\n[config] existing config has ${Object.keys(existing.projects ?? {}).length} projects`);
}

if (SYNC) {
  console.log(`\n[sync] pushing to Convex machineConfig...`);
  const cfg = loadConfig() ?? { projectsRoot: root, projects: validated };
  convexRun("machine:upsert", {
    machineId: getHostname(),
    projectRoots: Object.entries(cfg.projects).map(([slug, path]) => ({
      slug,
      path: path.startsWith("/") ? path : join(cfg.projectsRoot ?? root, path),
    })),
    prRoot: cfg.prRoot,
    reviewRoot: cfg.reviewRoot,
  });
  console.log(`[sync] done`);
}
