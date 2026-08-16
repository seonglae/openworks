// Machine-local config for openworks
// Reads from ~/.config/openworks/config.json (preferred) or env vars

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { homedir, hostname } from "os";
import { join, resolve } from "path";

const CONFIG_DIR = join(homedir(), ".config", "openworks");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const DEFAULT_PROJECTS_ROOT = resolve(process.cwd(), "..");

export function loadConfig() {
  if (existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch (e) {
      console.error(`[config] failed to parse ${CONFIG_PATH}: ${e.message}`);
    }
  }
  return null;
}

export function getProjectsRoot() {
  const env = process.env.OPENWORKS_PROJECTS_ROOT;
  if (env) return resolve(env);
  const cfg = loadConfig();
  if (cfg?.projectsRoot) return resolve(cfg.projectsRoot);
  return DEFAULT_PROJECTS_ROOT;
}

export function getProjectPath(slug) {
  const p = listKnownProjects()[slug];
  if (!p) return null;
  // absolute path or relative to root
  return p.startsWith("/") ? p : join(getProjectsRoot(), p);
}

export function listKnownProjects() {
  return loadConfig()?.projects ?? discoverProjects();
}

// Until the config file names them, projects are whatever git checkouts sit
// directly under the root. A written-in list is only ever right on the machine
// it was written on, and wrong everywhere it is copied to.
export function discoverProjects() {
  const root = getProjectsRoot();
  const found = {};
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    if (!existsSync(join(root, e.name, ".git"))) continue;
    found[slugify(e.name)] = e.name;
  }
  return found;
}

// Directory name to project slug: CamelCase splits on the case change, so a
// checkout named "MyProject" and one named "my-project" slug the same way.
function slugify(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function getHostname() {
  return process.env.OPENWORKS_MACHINE_ID || hostname();
}

export function saveConfig(cfg) {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  console.log(`[config] saved to ${CONFIG_PATH}`);
}
