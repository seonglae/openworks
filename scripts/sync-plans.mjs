#!/usr/bin/env node
// Sync plan markdown files from ../PR/**/plan.md to Convex

import { readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from "fs";
import { resolve, join, basename, dirname } from "path";
import { execSync } from "child_process";
import { loadConfig } from "./config.mjs";

const DEPLOYMENT = process.env.CONVEX_DEPLOYMENT;
if (!DEPLOYMENT) throw new Error("CONVEX_DEPLOYMENT is unset; set it or run through a shell that exports it");
const PR_ROOT = resolve(loadConfig()?.prRoot ?? process.env.OPENWORKS_PR_ROOT ?? join(process.cwd(), "..", "PR"));

function findPlanFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      findPlanFiles(p, out);
    } else if (entry === "plan.md") {
      out.push(p);
    }
  }
  return out;
}

function parseFrontmatter(block) {
  const obj = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([a-zA-Z_]+):\s*(.+)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    // Array [a, b, c]
    const arrMatch = val.match(/^\[(.*)\]$/);
    if (arrMatch) {
      obj[key] = arrMatch[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      obj[key] = val;
    }
  }
  return obj;
}

function parseTime(time) {
  if (!time) return { start: undefined, end: undefined };
  const m = time.match(/^(\d{1,2}):(\d{2})(?:-(\d{1,2}):(\d{2}))?$/);
  if (!m) return { start: undefined, end: undefined };
  const start = `${m[1].padStart(2, "0")}:${m[2]}`;
  const end = m[3] ? `${m[3].padStart(2, "0")}:${m[4]}` : undefined;
  return { start, end };
}

function parsePlan(raw) {
  const lines = raw.split("\n");
  let i = 0;

  // Document frontmatter (first --- ... ---)
  let docMeta = {};
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      docMeta = parseFrontmatter(lines.slice(1, end).join("\n"));
      i = end + 1;
    }
  }

  const days = [];
  const items = [];
  let currentDay = null;
  let dayOrder = 0;
  let currentKind = "event"; // default section

  while (i < lines.length) {
    const line = lines[i];

    // Day header: ## YYYY-MM-DD Label
    const dayMatch = line.match(/^##\s+(\d{4}-\d{2}-\d{2})(?:\s+(.+))?$/);
    if (dayMatch) {
      currentDay = {
        date: dayMatch[1],
        dayLabel: dayMatch[2],
        summary: undefined,
        order: dayOrder++,
      };
      days.push(currentDay);
      currentKind = "event";
      i++;
      // Look for blockquote summary on next non-empty lines
      while (i < lines.length && lines[i].trim() === "") i++;
      if (i < lines.length && lines[i].startsWith("> ")) {
        const summaryLines = [];
        while (i < lines.length && lines[i].startsWith("> ")) {
          summaryLines.push(lines[i].slice(2));
          i++;
        }
        currentDay.summary = summaryLines.join(" ");
      }
      continue;
    }

    // Section header: ### events or ### todos
    const sectionMatch = line.match(/^###\s+(events|todos)\s*$/i);
    if (sectionMatch) {
      currentKind = sectionMatch[1].toLowerCase() === "todos" ? "todo" : "event";
      i++;
      continue;
    }

    // Skip other ## sections (tier summary, networking memo etc) — not day-scoped
    if (line.startsWith("## ") && !dayMatch) {
      currentDay = null;
      i++;
      continue;
    }

    // Inside a day
    if (currentDay) {
      // Event item: --- frontmatter --- then title + notes
      if (line === "---" && currentKind === "event") {
        const end = lines.indexOf("---", i + 1);
        if (end > 0) {
          const meta = parseFrontmatter(lines.slice(i + 1, end).join("\n"));
          let j = end + 1;
          // Skip blank
          while (j < lines.length && lines[j].trim() === "") j++;
          const titleLine = j < lines.length ? lines[j] : "";
          j++;
          // Collect notes until next --- or ## or ### or blank followed by ---
          const noteLines = [];
          while (j < lines.length) {
            const l = lines[j];
            if (l === "---" || l.startsWith("## ") || l.startsWith("### ")) break;
            if (l.trim() === "") {
              // lookahead: is next non-empty a ---?
              let k = j + 1;
              while (k < lines.length && lines[k].trim() === "") k++;
              if (k < lines.length && (lines[k] === "---" || lines[k].startsWith("## ") || lines[k].startsWith("### ")))
                break;
            }
            noteLines.push(l);
            j++;
          }
          const notes = noteLines.join("\n").trim() || undefined;
          const { start, end: timeEnd } = parseTime(meta.time);
          items.push({
            date: currentDay.date,
            kind: "event",
            order: items.length,
            title: titleLine,
            notes,
            time: meta.time,
            timeStart: start,
            timeEnd,
            tier: meta.tier !== undefined ? Number(meta.tier) : undefined,
            location: meta.location,
            tags: Array.isArray(meta.tags) ? meta.tags : meta.tags ? [meta.tags] : [],
            done: false,
          });
          i = j;
          continue;
        }
      }

      // Todo item: - [ ] ... or - [x] ...
      const todoMatch = line.match(/^-\s+\[([ xX])\]\s+(.+)$/);
      if (todoMatch && currentKind === "todo") {
        items.push({
          date: currentDay.date,
          kind: "todo",
          order: items.length,
          title: todoMatch[2],
          notes: undefined,
          time: undefined,
          timeStart: undefined,
          timeEnd: undefined,
          tier: undefined,
          location: undefined,
          tags: [],
          done: todoMatch[1].toLowerCase() === "x",
        });
      }
    }

    i++;
  }

  return { docMeta, days, items };
}

function convexRun(fn, argsObj) {
  const tmp = `/tmp/plan-args-${Date.now()}.json`;
  writeFileSync(tmp, JSON.stringify(argsObj));
  try {
    execSync(`CONVEX_DEPLOYMENT=${DEPLOYMENT} npx convex run ${fn} "$(cat ${tmp})"`, {
      stdio: "inherit",
      timeout: 30_000,
    });
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

function main() {
  const files = findPlanFiles(PR_ROOT);
  console.log(`[sync-plans] Found ${files.length} plan files`);

  for (const file of files) {
    const slug = basename(dirname(file));
    const raw = readFileSync(file, "utf8");
    const { docMeta, days, items } = parsePlan(raw);

    console.log(`[sync-plans] ${slug}: ${days.length} days, ${items.length} items`);

    convexRun("plans:upsertPlan", {
      slug,
      title: docMeta.title || slug,
      timezone: docMeta.timezone,
      location: docMeta.location,
      theme: docMeta.theme,
      strategy: docMeta.strategy,
      rawMarkdown: raw,
      days,
      items,
    });
  }

  console.log("[sync-plans] done");
}

main();
