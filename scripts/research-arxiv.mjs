#!/usr/bin/env node
// Search arXiv via Semantic Scholar for research project keywords, store top papers
// Usage: node research-arxiv.mjs <slug>
//        node research-arxiv.mjs --all

import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";

const DEPLOYMENT = process.env.CONVEX_DEPLOYMENT;
if (!DEPLOYMENT) throw new Error("CONVEX_DEPLOYMENT is unset; set it or run through a shell that exports it");
const S2_BASE = "https://api.semanticscholar.org/graph/v1/paper/search";
const FIELDS = "title,authors,abstract,externalIds,url,year,citationCount";
const LIMIT_PER_QUERY = 10;

function convexRun(fn, argsObj, captureOutput = false) {
  const tmp = `/tmp/arxiv-args-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  writeFileSync(tmp, JSON.stringify(argsObj));
  try {
    const opts = { encoding: "utf8", timeout: 60_000, maxBuffer: 50 * 1024 * 1024 };
    if (!captureOutput) opts.stdio = "inherit";
    return execSync(`CONVEX_DEPLOYMENT=${DEPLOYMENT} ./node_modules/.bin/convex run ${fn} "$(cat ${tmp})"`, opts);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

async function searchSemantic(query, retries = 3) {
  const url = `${S2_BASE}?query=${encodeURIComponent(query)}&limit=${LIMIT_PER_QUERY}&fields=${FIELDS}`;
  for (let attempt = 0; attempt < retries; attempt++) {
    const r = await fetch(url, { headers: { "User-Agent": "openworks/1.0" } });
    if (r.ok) {
      const data = await r.json();
      return data.data ?? [];
    }
    if (r.status === 429) {
      const wait = 5000 * (attempt + 1);
      console.error(`  rate limit, wait ${wait}ms`);
      await new Promise((rs) => setTimeout(rs, wait));
      continue;
    }
    console.error(`  S2 API error ${r.status} for query: ${query}`);
    return [];
  }
  console.error(`  giving up: ${query}`);
  return [];
}

function paperToRecord(p) {
  const arxivId = p.externalIds?.ArXiv;
  const url = arxivId ? `https://arxiv.org/abs/${arxivId}` : (p.url ?? "");
  return {
    arxivId,
    title: p.title ?? "",
    authors: (p.authors ?? []).map((a) => a.name).filter(Boolean),
    abstract: p.abstract ?? undefined,
    url,
    source: "arxiv",
  };
}

async function importForProject(slug) {
  // Get project info
  const out = execSync(
    `CONVEX_DEPLOYMENT=${DEPLOYMENT} ./node_modules/.bin/convex run research:listByKind '{"kind":"own"}' 2>/dev/null`,
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
  );
  const projects = JSON.parse(out);
  const project = projects.find((p) => p.slug === slug);
  if (!project) {
    console.error(`Project not found: ${slug}`);
    return;
  }

  console.log(`\n=== ${slug}: ${project.title} ===`);
  const keywords = project.keywords ?? [];
  if (keywords.length === 0) {
    console.log("  no keywords — skip (set keywords in UI first)");
    return;
  }

  // Build queries: keyword pairs (project name often too specific)
  const queries = [];
  for (let i = 0; i < Math.min(keywords.length, 4); i++) {
    for (let j = i + 1; j < Math.min(keywords.length, 4); j++) {
      queries.push(`${keywords[i]} ${keywords[j]}`);
    }
  }
  if (queries.length === 0) queries.push(keywords[0]);

  const seen = new Map(); // arxivId -> record (for dedup)
  for (const q of queries) {
    console.log(`  search: ${q}`);
    const results = await searchSemantic(q);
    for (const p of results) {
      const rec = paperToRecord(p);
      if (!rec.arxivId) continue;
      if (!seen.has(rec.arxivId)) seen.set(rec.arxivId, rec);
    }
    await new Promise((r) => setTimeout(r, 2500));
  }

  const papers = Array.from(seen.values()).slice(0, 30);
  console.log(`  ${papers.length} unique arXiv papers`);

  // Replace
  convexRun("researchPapers:replaceForResearch", { researchSlug: slug, papers });
  console.log(`  ✓ ${slug}`);
}

async function main() {
  const [, , slug] = process.argv;
  if (!slug) {
    console.error("Usage: node research-arxiv.mjs <slug>");
    console.error("Or: node research-arxiv.mjs --all");
    process.exit(1);
  }

  if (slug === "--all") {
    const out = execSync(
      `CONVEX_DEPLOYMENT=${DEPLOYMENT} ./node_modules/.bin/convex run research:listByKind '{"kind":"own"}' 2>/dev/null`,
      { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
    );
    const projects = JSON.parse(out);
    for (const p of projects) {
      await importForProject(p.slug);
    }
    return;
  }

  await importForProject(slug);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
