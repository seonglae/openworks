#!/usr/bin/env node
// Register a research project: walk folder, classify files, push to Convex
// Usage: node register-research.mjs <slug> [path]

import { readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from "fs";
import { resolve, join, relative, extname, basename } from "path";
import { execSync } from "child_process";
import { createHash } from "crypto";
import { getProjectPath, listKnownProjects } from "./config.mjs";

const DEPLOYMENT = process.env.CONVEX_DEPLOYMENT;
if (!DEPLOYMENT) throw new Error("CONVEX_DEPLOYMENT is unset; set it or run through a shell that exports it");

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  "target",
  ".pytest_cache",
  ".mypy_cache",
  ".convex",
  ".turbo",
  "out",
  ".pnpm-store",
  "wandb",
  "checkpoints",
  "experiments",
  "results",
  "outputs",
  "cache",
  "tmp",
  "logs",
]);

const MAX_FILES = 300;

const SKIP_FILES = new Set([
  ".DS_Store",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "uv.lock",
  "poetry.lock",
]);

const CODE_EXT = new Set([
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".rb",
  ".sh",
  ".swift",
]);
const DOC_EXT = new Set([".md", ".rst", ".txt", ".org"]);
const PAPER_EXT = new Set([".pdf", ".tex", ".bib"]);
const CONFIG_EXT = new Set([".json", ".yaml", ".yml", ".toml", ".ini", ".env"]);
const DATA_EXT = new Set([".csv", ".tsv", ".jsonl", ".parquet", ".npy", ".npz", ".h5"]);

function classify(filename) {
  const ext = extname(filename).toLowerCase();
  if (CODE_EXT.has(ext)) return { type: "code", lang: ext.slice(1) };
  if (DOC_EXT.has(ext)) return { type: "doc", lang: ext.slice(1) };
  if (PAPER_EXT.has(ext)) return { type: "paper", lang: ext.slice(1) };
  if (CONFIG_EXT.has(ext)) return { type: "config", lang: ext.slice(1) };
  if (DATA_EXT.has(ext)) return { type: "data", lang: ext.slice(1) };
  return { type: "other", lang: undefined };
}

function extractExcerpt(filePath, fileType) {
  try {
    const stat = statSync(filePath);
    if (stat.size > 500_000) return "(file too large)";
    const buf = readFileSync(filePath);
    if (fileType === "paper" && extname(filePath).toLowerCase() === ".pdf") {
      return `(PDF: ${basename(filePath)})`;
    }
    const text = buf.toString("utf8");
    if (fileType === "code") {
      const lines = text.split("\n").slice(0, 50);
      return lines.join("\n").slice(0, 1000);
    }
    if (fileType === "doc") {
      return text.slice(0, 2000);
    }
    return text.slice(0, 800);
  } catch {
    return "";
  }
}

function walk(dir, baseDir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.startsWith(".") && entry !== ".env.example" && entry !== ".gitignore") continue;
    if (SKIP_DIRS.has(entry) || SKIP_FILES.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, baseDir, out);
    } else if (st.isFile()) {
      out.push({ fullPath: full, relPath: relative(baseDir, full), size: st.size });
    }
  }
  return out;
}

function convexRun(fn, argsObj) {
  const tmp = `/tmp/research-args-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  writeFileSync(tmp, JSON.stringify(argsObj));
  try {
    execSync(`CONVEX_DEPLOYMENT=${DEPLOYMENT} ./node_modules/.bin/convex run ${fn} "$(cat ${tmp})"`, {
      stdio: "inherit",
      timeout: 120_000,
      maxBuffer: 100 * 1024 * 1024,
    });
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

async function main() {
  const [, , slug, providedPath] = process.argv;
  if (!slug) {
    console.error("Usage: node register-research.mjs <slug> [path]");
    console.error("Or: node register-research.mjs --all");
    process.exit(1);
  }

  if (slug === "--all") {
    for (const s of Object.keys(listKnownProjects())) {
      const p = getProjectPath(s);
      if (p) await registerOne(s, p);
    }
    return;
  }

  const path = providedPath ?? getProjectPath(slug);
  if (!path) {
    console.error(`No path provided and slug '${slug}' not in config`);
    process.exit(1);
  }
  await registerOne(slug, resolve(path));
}

async function registerOne(slug, rootPath) {
  console.log(`\n=== ${slug} @ ${rootPath} ===`);
  let stat;
  try {
    stat = statSync(rootPath);
  } catch {
    console.error(`  SKIP: path not found`);
    return;
  }
  if (!stat.isDirectory()) {
    console.error(`  SKIP: not a directory`);
    return;
  }

  const all = walk(rootPath, rootPath);
  console.log(`  Found ${all.length} files`);

  // Priority: doc > paper > config > code (root-level prioritized within each)
  const TYPE_RANK = { doc: 0, paper: 1, config: 2, code: 3, other: 4, data: 5 };
  function priority(item) {
    const { type } = classify(item.fullPath);
    const depth = item.relPath.split("/").length;
    return TYPE_RANK[type] * 1000 + depth;
  }

  const sorted = all.slice().sort((a, b) => priority(a) - priority(b));

  const filesData = [];
  let totalSize = 0;
  const typeCounts = { code: 0, doc: 0, paper: 0, config: 0, data: 0, other: 0 };
  for (const { fullPath, relPath, size } of sorted) {
    const { type, lang } = classify(fullPath);
    typeCounts[type]++;
    if (type === "data") continue;
    if (size > 1_000_000 && type !== "doc") continue;
    if (filesData.length >= MAX_FILES) continue;
    const excerpt = extractExcerpt(fullPath, type);
    const hash = createHash("md5").update(excerpt).digest("hex").slice(0, 16);
    filesData.push({ relPath, fileType: type, language: lang, size, excerpt, hash });
    totalSize += size;
  }

  console.log(`  Types: ${JSON.stringify(typeCounts)}`);
  console.log(`  Pushing ${filesData.length}/${all.length} files (${(totalSize / 1024).toFixed(0)} KB excerpt)`);

  // Clear + batch insert (50 at a time to stay under ARG_MAX)
  convexRun("researchFiles:clearResearch", { researchSlug: slug });
  const BATCH = 15;
  for (let i = 0; i < filesData.length; i += BATCH) {
    const batch = filesData.slice(i, i + BATCH);
    convexRun("researchFiles:insertBatch", { researchSlug: slug, files: batch });
  }
  convexRun("researchFiles:finalizeSync", { researchSlug: slug });
  console.log(`  ✓ ${slug}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
