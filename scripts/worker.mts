#!/usr/bin/env node
/**
 * Headless newsletter worker wrapping Claude Code CLI.
 * No API key needed — uses existing Claude Code auth.
 * Polls Convex for pending jobs, spawns `claude -p` subprocesses.
 */

import { execSync, execFile, execFileSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { ORDERS, orderFor, nextProvider as actorNextProvider, runActor, spawnProvider } from "./actor.mts";
import { embed, EMBED_MODEL } from "./embed.mts";
import { buildMime, digestsDue, gwsSendArgs, renderDigest, type DigestPR } from "./digest.mts";
import { connectConvexWatcher, createConvexClient, loadEnvLocal, resolveConvexUrl } from "@openworks/node";
import { isTerminalJobStatus } from "@openworks/domain";

// Load .env.local. A value already in the real environment wins.
for (const [key, val] of Object.entries(loadEnvLocal(process.cwd()))) {
  if (!process.env[key]) process.env[key] = val;
}

const POLL_INTERVAL = 3_000;
const MAX_WORKERS = 5;
const WORKER_TIMEOUT = 30 * 60_000;
const PROVIDER = process.env.AI_PROVIDER || ORDERS.default[0];
const CLAUDE_MCP_CONFIG = resolve(process.cwd(), ".claude/playwright-headless.json");

const active = new Map(); // jobId -> child process

// All CLI dispatch goes through actor.mjs. Per-task-type chains live in
// actor.ORDERS: pr-fix prefers codex then claude then antigravity, everything
// else defaults to codex then antigravity then claude.
function spawnFor(
  name: import("./actor.mts").ProviderName,
  {
    prompt,
    cwd,
    env,
    mode,
    skipMcp,
  }: { prompt: string; cwd: string; env: NodeJS.ProcessEnv; mode: "job" | "chat"; skipMcp?: boolean },
) {
  return spawnProvider(name, {
    prompt,
    cwd,
    env,
    mode,
    skipMcp,
    mcpConfig: skipMcp ? undefined : CLAUDE_MCP_CONFIG,
  });
}

console.log(`[worker] CONVEX_DEPLOYMENT=${process.env.CONVEX_DEPLOYMENT || "NOT SET"}`);

const CONVEX_HTTP_URL = resolveConvexUrl(process.cwd());
console.log(`[worker] convex transport: ${CONVEX_HTTP_URL ? `http (${CONVEX_HTTP_URL})` : "cli"}`);

// Each function's kind (query/mutation/action) is discovered on first call
// and cached, so the steady-state cost is exactly one HTTP request per call.
const convexFnKind = new Map<string, string>();

// Single-owner service key: injected into every backend call so the worker
// (which hits the anonymous HTTP API / admin CLI, never a Clerk session) clears
// the requireOwner gate once OPENWORKS_OWNER_USER_ID is set on the deployment.
// No-op until OPENWORKS_SERVICE_KEY is set, so local / pre-lockdown is unaffected.
const OPENWORKS_SERVICE_KEY = process.env.OPENWORKS_SERVICE_KEY;
// JSON fragment appended (before the closing `}`) to every `npx convex run`
// payload embedded in an agent prompt, so the spawned CLI clears requireOwner
// after the lockdown flip. Uses shell expansion of $OPENWORKS_SERVICE_KEY (set in
// the agent's inherited env) so the secret never appears literally in the
// prompt or worker log. Empty until the key is configured -> no change today.
const SK = OPENWORKS_SERVICE_KEY ? `,"serviceKey":"'"$OPENWORKS_SERVICE_KEY"'"` : "";
function withKeyStr(args = "{}"): string {
  if (!OPENWORKS_SERVICE_KEY) return args;
  try {
    const o = JSON.parse(args || "{}");
    if (o.serviceKey == null) o.serviceKey = OPENWORKS_SERVICE_KEY;
    return JSON.stringify(o);
  } catch {
    return args;
  }
}
// Legacy transport: spawn the convex CLI. Each spawn is a full node process
// (~60-110MB RSS, 300-800ms startup). Kept only as fallback for when no
// deployment URL can be resolved.
function convexRunCli(fn, args = "{}") {
  try {
    return execFileSync("convex", ["run", fn, args], {
      timeout: 15_000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
      env: process.env,
    }).trim();
  } catch (e) {
    if (e.stderr) console.error(`[convex] ${fn}: ${e.stderr.toString().slice(0, 200)}`);
    return null;
  }
}

// Primary transport: Convex HTTP API via curl (sync like the CLI path, so
// every call site stays unchanged, but ~5MB per invocation instead of a
// full node CLI boot). Same functions, same args, same deployment — the
// poll loop fires 6+ of these every 3s, which made the CLI spawns the
// worker's dominant memory/CPU cost.
function convexHttpOnce(endpoint: string, fn: string, args: string): { ok: boolean; value?: any; error?: string } {
  try {
    const out = execFileSync(
      "curl",
      [
        "-s",
        "--max-time",
        "15",
        "-X",
        "POST",
        `${CONVEX_HTTP_URL}/api/${endpoint}`,
        "-H",
        "Content-Type: application/json",
        "-d",
        "@-",
      ],
      {
        input: JSON.stringify({ path: fn, args: JSON.parse(args), format: "json" }),
        timeout: 20_000,
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
      },
    );
    const res = JSON.parse(out);
    if (res.status === "success") return { ok: true, value: res.value };
    return { ok: false, error: res.errorMessage ?? "unknown convex error" };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

function convexRun(fn, args = "{}") {
  args = withKeyStr(args);
  if (!CONVEX_HTTP_URL) return convexRunCli(fn, args);
  const kinds = ["query", "mutation", "action"];
  const first = convexFnKind.get(fn) ?? "query";
  const order = [first, ...kinds.filter((k) => k !== first)];
  for (const kind of order) {
    const res = convexHttpOnce(kind, fn, args);
    if (res.ok) {
      convexFnKind.set(fn, kind);
      // Match the CLI contract: callers JSON.parse the returned string and
      // some compare against the literal "null".
      return JSON.stringify(res.value);
    }
    // "Trying to execute X as Query, but it is defined as Mutation." →
    // wrong endpoint; try the next kind. Any other error is a real
    // function error: log + return null exactly like the CLI path did.
    if (!/defined as (Query|Mutation|Action)/i.test(res.error ?? "")) {
      console.error(`[convex] ${fn}: ${res.error}`);
      return null;
    }
  }
  console.error(`[convex] ${fn}: could not resolve function kind`);
  return null;
}

// Async sibling of convexRun for code that already runs in callbacks (the
// post-completion link validator) — plain fetch, no subprocess. Shares
// convexFnKind with the sync path so whichever runs first primes the other.
const convexFetch = createConvexClient({
  url: CONVEX_HTTP_URL,
  serviceKey: OPENWORKS_SERVICE_KEY,
  timeoutMs: 20_000,
  kindCache: convexFnKind,
  cliFallback: async (fn, args) => {
    const raw = convexRunCli(fn, JSON.stringify(args));
    return raw ? JSON.parse(raw) : null;
  },
}) as (fn: string, args?: any) => Promise<any>;

// ── Post-completion link validation ────────────────────────────────────
// Agents are instructed to verify every URL before writing it, but agents
// drift — so after a job reaches a successful terminal we mechanically
// HEAD-check every URL in its summaries (inline markdown links + the url
// field) and strip the definitively dead ones. Dead = HTTP 404/410 after
// redirects, or NXDOMAIN. Bot blocks (403/429), timeouts, and 5xx are NOT
// treated as dead — can't-verify is different from broken.

const LINK_CHECK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const LINK_CHECK_TIMEOUT_MS = 10_000;
const LINK_CHECK_CONCURRENCY = 8;
const MD_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
// url → alive. Per-process cache so repeated links across jobs cost one check.
const linkAliveCache = new Map<string, boolean>();

async function checkLinkAlive(url: string): Promise<boolean> {
  const cached = linkAliveCache.get(url);
  if (cached !== undefined) return cached;
  let alive = true;
  try {
    let res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers: { "User-Agent": LINK_CHECK_UA },
      signal: AbortSignal.timeout(LINK_CHECK_TIMEOUT_MS),
    });
    // Some servers reject HEAD outright — retry with a 1-byte GET.
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: { "User-Agent": LINK_CHECK_UA, Range: "bytes=0-0" },
        signal: AbortSignal.timeout(LINK_CHECK_TIMEOUT_MS),
      });
    }
    alive = res.status !== 404 && res.status !== 410;
  } catch (e: any) {
    // Only a definitive DNS miss counts as dead; timeouts / resets /
    // transient DNS (EAI_AGAIN) stay alive.
    const code = String(e?.cause?.code ?? e?.code ?? "");
    alive = code !== "ENOTFOUND";
  }
  linkAliveCache.set(url, alive);
  return alive;
}

async function validateJobLinks(jobId: string) {
  try {
    const rows = await convexFetch("summaries:listByJob", { jobId });
    if (!Array.isArray(rows) || rows.length === 0) return;
    const urls = new Set<string>();
    for (const r of rows) {
      for (const m of String(r.summary ?? "").matchAll(MD_LINK_RE)) urls.add(m[2]);
      if (r.url && /^https?:\/\//i.test(r.url)) urls.add(r.url);
    }
    const list = [...urls].slice(0, 80);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(LINK_CHECK_CONCURRENCY, list.length) }, async () => {
        while (next < list.length) {
          const u = list[next++];
          await checkLinkAlive(u);
        }
      }),
    );
    let stripped = 0;
    for (const r of rows) {
      const origBody = String(r.summary ?? "");
      const body = origBody.replace(MD_LINK_RE, (whole, text, url) => {
        if (linkAliveCache.get(url) === false) {
          stripped++;
          return text;
        }
        return whole;
      });
      let url = r.url as string;
      if (url && linkAliveCache.get(url) === false) {
        url = "";
        stripped++;
      }
      if (body !== origBody || url !== r.url) {
        await convexFetch("summaries:patchLinks", {
          summaryId: r._id,
          ...(body !== origBody ? { summary: body } : {}),
          ...(url !== r.url ? { url } : {}),
        });
      }
    }
    if (stripped > 0) console.log(`[worker] link-check ${jobId}: stripped ${stripped} dead link(s)`);
  } catch (e) {
    console.warn(`[worker] link-check failed for ${jobId}: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
  }
}

// Resolve the user-configured output language from appSettings (no auth —
// singleton row). Cached for 30s so we don't hit Convex once per job spawn.
const LANGUAGE_NAMES: Record<string, string> = {
  ko: "Korean",
  en: "English",
  ja: "Japanese",
  zh: "Chinese",
};
let langCache: { value: string; expiresAt: number } | null = null;
function getLanguageName(): string {
  const now = Date.now();
  if (langCache && langCache.expiresAt > now) return langCache.value;
  let resolved = "Korean";
  try {
    const raw = convexRun("settings:get");
    if (raw) {
      const row = JSON.parse(raw);
      const code = (row?.language as string | undefined) ?? "ko";
      resolved = LANGUAGE_NAMES[code] ?? "Korean";
    }
  } catch {}
  langCache = { value: resolved, expiresAt: now + 30_000 };
  return resolved;
}

function buildPrompt(job) {
  const type = job.type || "newsletter";
  const lang = getLanguageName();

  if (type === "newsletter" && job.tldrOnly === true) {
    // TLDR-only backfill: existing summaries stay, only the job-level 3-line
    // tldr is generated and written. No new summaries, no Notion suggestions.
    return [
      `Backfill job-level tldr for newsletter job ${job._id}. Existing summaries are correct. DO NOT rewrite them, DO NOT create new summaries:addBatch rows, DO NOT touch suggestions.`,
      `1. Read the existing summary rows: CONVEX_DEPLOYMENT=${process.env.CONVEX_DEPLOYMENT} npx convex run summaries:listByJob '{"jobId":"${job._id}"${SK}}'`,
      `2. From those summary titles + bodies + categories, compose a 3-element ${lang} tldr array (one short sentence per bucket):`,
      `   Line 0 = research (AI/ML papers, technical findings, new methods, datasets, benchmarks, model releases with concrete capability claims).`,
      `   Line 1 = industry (company moves: IPO, acquisition, layoffs, funding, partnerships, leadership changes, product launches without deep research substance).`,
      `   Line 2 = science (biotech, hardware, physics, materials, biology, medicine, regulation, legal, social — anything notable that doesn't fit research or industry).`,
      `   Bundle the most interesting items in each bucket with specific names and numbers. Skip pure sponsor / ad slots. If a bucket has nothing in this issue, the sentence should plainly say so in ${lang}.`,
      `3. Write the array via: CONVEX_DEPLOYMENT=${process.env.CONVEX_DEPLOYMENT} npx convex run jobs:setTldr '{"jobId":"${job._id}","tldr":["<line0>","<line1>","<line2>"]${SK}}'`,
      `4. Clear the flag: CONVEX_DEPLOYMENT=${process.env.CONVEX_DEPLOYMENT} npx convex run jobs:clearTldrOnly '{"jobId":"${job._id}"${SK}}'`,
      `5. Restore status to suggested: CONVEX_DEPLOYMENT=${process.env.CONVEX_DEPLOYMENT} npx convex run jobs:updateStatus '{"jobId":"${job._id}","status":"suggested"${SK}}'`,
      `Exit after step 5. Do NOT mark the job done; terminal status for newsletter jobs is 'suggested' (set by the user later via UI approval).`,
    ].join("\n");
  }

  if (type === "newsletter") {
    // If the worker pre-fetched the email body, write it to a temp file so
    // the prompt can stay small while the agent still reads the full content.
    // Otherwise (no emailId / gws unavailable), fall back to the agent
    // fetching gmail itself.
    let newsletterPath = "";
    if (typeof job.content === "string" && job.content.length > 200) {
      newsletterPath = `./tmp/newsletter-${job._id}.md`;
      try {
        mkdirSync("./tmp", { recursive: true });
        writeFileSync(newsletterPath, job.content, "utf8");
      } catch (e) {
        console.error(`[worker] failed to write ${newsletterPath}: ${(e as Error).message}`);
        newsletterPath = "";
      }
    }
    const newsletterSource = newsletterPath
      ? `The newsletter body (already sanitized by the worker: tracking tokens stripped, HTML flattened) is on disk at ${newsletterPath} (${job.content.length} chars). Read THAT file in its entirety. Do NOT re-fetch the email via gmail.`
      : !job.content && !job.url && job.imagePath
        ? `${pastedImageLine(job)} Treat the screenshot(s) as the newsletter itself — extract every item you can read (each item's title, its link if visible, and a short description). For any item whose link is visible, you may WebFetch it to enrich the summary. Do NOT consult gmail.`
        : "Fetch the newsletter content yourself (gws gmail users messages get with format=full).";
    return [
      `Process newsletter job with ID ${job._id}.`,
      newsletterSource,
      "Follow the Convex Workflow in CLAUDE.md.",
      "After reading the newsletter, set the title with jobs:updateTitle using the newsletter's own date (e.g. 'TLDR 2026-02-03', 'AlphaSignal 2026-02-03'). The email date is in the content header [Email Date: YYYY-MM-DD] — use that exact date.",
      `Write per-item summaries in ${lang} (keep English technical terms).`,
      `After writing summaries, also call jobs:setTldr with a 3-element array of ${lang} strings, one short sentence per bucket — keep English technical terms. Line 0 = research (AI/ML papers, technical findings, new methods, datasets, benchmarks, model releases with concrete capability claims). Line 1 = industry (company moves: IPO, acquisition, layoffs, funding, partnerships, leadership changes, product launches without deep research substance). Line 2 = science (biotech, hardware, physics, materials, biology, medicine, regulation, legal, social — anything notable that does not fit research or industry). Inside each bucket pick the most interesting items by novelty / surprise / significance and bundle them in one sentence with specific names and numbers. Skip pure sponsor / ad slots. If a bucket has nothing in this issue, the sentence should plainly say so in ${lang}.`,
      "When writing suggestions, notion-fetch each target page and extract real markdown content for contextBefore/contextAfter — copy actual page markdown lines around the insertion point, NOT descriptions like 'Separator' or '(end of page)'.",
      "Insertion placement rules — STRICT: (1) Find the existing block group that already lists related links/papers on the target page (typically a bulleted list of arxiv / github / project URLs). The new entry MUST land inside that group, NOT at the bottom of the page. (2) NEVER append below the page's breadcrumb / final horizontal divider / trailing horizontal rule — anything below the last `---` divider is reserved appendix and must not receive auto-content. (3) If no link-block exists, insert right after the closing paragraph of the most relevant section, still ABOVE any trailing divider.",
      "Topic-fit rules: pick the Notion page whose core subject matches the paper / item's primary concept. Do NOT slot a paper under a page just because the page name shares one keyword with the company / lab attached to the paper — e.g. a paper about 'World Action Model' should not be parked under a page about 'Spark World Labs' unless that page itself is the canonical home for World Action Model research. Prefer 'no suggestion' over a forced topical fit.",
      "URL normalization: rewrite any alphaxiv.org/abs/<id> or alphaxiv.org/pdf/<id> link to the corresponding arxiv.org/abs/<id> URL before saving it as the suggestion's URL or inlining it in suggestion content. Always link arXiv abstracts via arxiv.org, never alphaxiv.org.",
      "LINK VERIFICATION (MANDATORY): every URL you write (inline markdown links inside summaries, each summary's url field, every suggestion URL) must be verified reachable BEFORE you write it: run `curl -s -o /dev/null -w '%{http_code}' -L --max-time 8 '<url>'` and require a 2xx code. NEVER write a URL from memory or by guessing a path (e.g. vendor.com/product-name); guessed paths 404 constantly. If the check prints 404 or fails, WebSearch the correct canonical URL and verify THAT; if nothing verifies, drop the link and write plain text instead. The worker re-validates all links after you finish and strips dead ones, so unverified links are wasted output.",
      "When suggestions are written, do NOT call jobs:updateStatus done. The terminal status for your run is 'suggested' (set automatically by suggestions:addBatch). 'done' is reserved for AFTER the user approves suggestions through the UI — agent never sets it. If you wrote zero suggestions (e.g. issue had no research items worth dropping into Notion), still leave status at 'suggested' — do NOT mark done. Exit immediately after suggestions:addBatch.",
    ].join(" ");
  }

  if (type === "paper" && job.scoresOnly === true) {
    // Rescore-only path: existing summary stays, only structured score
    // fields get filled. Triggered by jobs.retryPaperJobsWithoutScores.
    const paperPath = `./tmp/paper-${job._id}.md`;
    try {
      mkdirSync("./tmp", { recursive: true });
      if (job.content) writeFileSync(paperPath, job.content, "utf8");
    } catch (e) {
      console.error(`[worker] failed to write ${paperPath}: ${(e as Error).message}`);
    }
    const parts = [
      `Rescore paper job ${job._id}. The existing summary text is correct — do NOT rewrite it. Read it and the full paper, then fill ONLY the structured peer-review fields (researchLevel, scores, priorWork, reasoning) plus tldr.`,
      `The full paper text is on disk at ${paperPath} (${job.content ? job.content.length : 0} chars). Read it in its entirety.`,
      `Fetch the existing summary by running: CONVEX_DEPLOYMENT=${process.env.CONVEX_DEPLOYMENT} npx convex run summaries:listByJob '{"jobId":"${job._id}"${SK}}'  — that returns an array; take the first row's _id and use its summary text as the source of truth for what the paper says (alongside the on-disk full text, which gives you everything beyond the summary's compression).`,
      `Literature check: use WebSearch to look up the paper's core technique name, central claim, and the 2-3 nearest prior works. Verify novelty against what already exists.`,
      `Apply the canonical peer-review rubric (criteria.md / paper-review.md style). The caps below are MECHANICAL — when a condition is met you MUST cap the score; you cannot override based on how interesting the work feels.`,
      `  1. WebSearch the core technique + central claim + 2-3 nearest prior works BEFORE scoring. If WebSearch unavailable: Originality is capped at 5.`,
      `  2. ORIGINALITY MECHANICAL CAPS (apply whichever cap is lowest):`,
      `     - PriorWork entry matches same core method (even in different domain / different name) → cap Originality at 4.`,
      `     - PriorWork entry covers the same core finding → cap Originality at 4.`,
      `     - Contribution is an extension / reframing / new combination of an established research line → cap Originality at 6.`,
      `     - 7-8 reserved for novel mechanism/result with no overlapping prior work in PriorWork.`,
      `     - 9-10 reserved for paradigm-defining work (new sub-field).`,
      `  3. EXPERIMENTS MECHANICAL CAPS:`,
      `     - Single model family or single benchmark → cap Experiments at 6.`,
      `     - Sub-1B scale only when claims target general LLMs → cap Experiments at 5.`,
      `     - Missing standard SOTA baseline or non-standard protocol favoring the proposed method → cap Experiments at 5.`,
      `  4. SOUNDNESS MECHANICAL CAPS:`,
      `     - Moderate effect sizes (correlations < 0.7 as primary evidence) → cap Soundness at 6.`,
      `     - Paper flags a confounder it does not fully resolve → cap Soundness at 6.`,
      `     - Claim scope exceeds evidence scope → cap Soundness at 5.`,
      `  5. IMPACT / SIGNIFICANCE: incremental insight on established problem caps at 5. 7-8 needs evidence of practice-changing potential. 9-10 reshapes the field.`,
      `  6. Counter LLM-bias frames: do NOT over-weight reproducibility / scalability / generalization / computational efficiency / theoretical foundations / technical soundness as default. Human reviewers weight clarity, motivation, impact, relevance, comparative analysis, overclaiming, writing quality.`,
      `  7. Compute Overall as the mean of the 6 criteria, then subtract 0.3. Do not round up. Map per the table below.`,
      `Tier mapping from the final (deflated) Overall:`,
      `  Overall ≥ 9.0 → 'Top conference best paper' · 8.3-8.9 → 'Top conference highlight (NeurIPS spotlight, ICLR oral)' · 7.5-8.2 → 'Top 3 conference main (ICLR, ICML, NeurIPS)' · 6.8-7.4 → 'Top conference main (EMNLP, ACL, NAACL)' · 6.0-6.7 → 'Top conference finding (ACL Findings, EMNLP Findings)' · 5.0-5.9 → 'Mid conference main (COLING, TMLR, EACL)' · 4.0-4.9 → 'Top workshop level (ICLR/NeurIPS/ICML workshop)' · 3.0-3.9 → 'Workshop level' · below 3 → 'Blog post level'.`,
      `Steps:`,
      `1. Read ${paperPath} in full.`,
      `2. Fetch the existing summary row(s) for this job via summaries:listByJob and pick the first.`,
      `3. WebSearch the core technique + central claim + 2-3 nearest prior works.`,
      `4. Compute scores per the rubric above. Pick the tier from the table.`,
      `5. Patch the summary row(s) via summaries:patchScores '{"summaryId":"<id>","researchLevel":"<tier>","scores":{...},"priorWork":[{"citation":"...","relation":"..."}],"reasoning":"<2-3 sentences in ${lang}>"${SK}}'. If the row already has any of these fields filled, OVERWRITE — your fresh scoring is canonical.`,
      `6. ALSO write a 3-element tldr to the summary row(s) via summaries:patchScores tldr: [motivation, method+result, takeaway] (one short ${lang} sentence each, English technical terms preserved). And mirror it to the job-level tldr via jobs:setTldr (same array).`,
      `7. After patching, mark the job done: jobs:updateStatus '{"jobId":"${job._id}","status":"done"${SK}}'. Also clear the rescore flag by running: jobs:clearScoresOnly '{"jobId":"${job._id}"${SK}}'.`,
    ];
    return parts.join("\n");
  }

  if (type === "paper") {
    const parts = [
      `Process paper job with ID ${job._id}.`,
      `The input is: ${job.url || (job.imagePath ? "(pasted screenshot)" : "(pasted content)")}`,
    ];
    if (!job.content && !job.url && job.imagePath) {
      parts.push(
        pastedImageLine(job),
        `If your tooling cannot actually render the image (you see bytes/garbage instead of the page), EXIT with a non-zero status immediately so the fallback provider takes over. Do NOT attempt local OCR workarounds and do NOT proceed from memory.`,
        `From the image(s), identify the paper: title, authors, venue if visible. The identification MUST come from text you can read in the image. NEVER substitute a famous paper you remember. Then WebSearch the exact title (plus a distinctive phrase if the title is generic) to find the canonical source: arxiv abs page strongly preferred, otherwise OpenReview / official conference page.`,
        `VERIFY before proceeding: the title on the found page must match the title visible in the image VERBATIM (ignoring case/punctuation). If it doesn't match, search again; if nothing matches, mark the job error.`,
        `Once you have the arxiv id, download and extract the FULL text yourself:`,
        `  curl -fL https://arxiv.org/pdf/<id>.pdf -o ./tmp/paper-${job._id}.pdf && pdftotext -layout -nopgbrk ./tmp/paper-${job._id}.pdf ./tmp/paper-${job._id}.txt`,
        `Then Read ./tmp/paper-${job._id}.txt in its entirety. Do NOT summarize from the screenshot alone or from the abstract.`,
        `If the source is not on arxiv, find the official PDF link on the landing page and use the same curl + pdftotext flow; if no PDF exists, WebFetch the page's HTML full text.`,
        `Store the discovered canonical URL on the job: CONVEX_DEPLOYMENT=${process.env.CONVEX_DEPLOYMENT} npx convex run jobs:setUrl '{"jobId":"${job._id}","url":"<canonical url>"${SK}}' and also pass it as the url field in summaries:addBatch.`,
        `If you cannot identify the paper from the image with confidence, mark the job error with a short reason via jobs:updateStatus instead of guessing.`,
      );
    }
    if (job.content) {
      // Write full paper content to a /tmp file so the agent can Read it
      // wholesale instead of being capped by prompt-size truncation. Earlier
      // we inlined 30K chars which meant the agent never saw the experiments
      // / results sections — fatal for a Research Level judgment.
      const paperPath = `./tmp/paper-${job._id}.md`;
      try {
        mkdirSync("./tmp", { recursive: true });
        writeFileSync(paperPath, job.content, "utf8");
      } catch (e) {
        console.error(`[worker] failed to write ${paperPath}: ${(e as Error).message}`);
      }
      parts.push(
        `The user pasted the full paper. The full text is on disk at ${paperPath} (${job.content.length} chars). Read THAT file in its entirety — do NOT skim, do NOT skip sections, do NOT consult other paper jobs. Summarize EXACTLY this paper.`,
      );
      parts.push(
        `Literature check IS required for Research Level judgment. Use WebSearch (or the equivalent search tool) to look up the paper's core technique name, central claim, and the 2-3 nearest prior works. Verify novelty against what already exists. Do NOT WebFetch the paper itself (you have the full text on disk) and do NOT open a browser app — search-only is fine.`,
      );
      parts.push(
        `ALSO use WebSearch to find the paper's canonical source URL (arxiv abs link preferred, otherwise OpenReview / project page / official conference link). Pass that URL as the \`url\` field in summaries:addBatch. Do NOT include the URL inside the summary body — UI renders it separately from the \`url\` field. If no canonical URL can be found, leave url empty.`,
      );
    } else if (job.url) {
      parts.push(
        "Read the FULL paper, not just the abstract.",
        "If the URL is an arXiv link, convert arxiv.org/abs/XXXX to arxiv.org/html/XXXX and WebFetch the HTML version for full text.",
        "If WebFetch fails or returns only the abstract, use Playwright (browser_navigate + browser_snapshot) to load the page.",
        "If that also fails, fall back to the abstract but note it in the summary.",
      );
    }
    parts.push(
      "Steps:",
      "1. Read the full paper content.",
      "2. Set the title with jobs:updateTitle to the paper's title (keep original language).",
      "3. Write a single summary to Convex using summaries:addBatch with this structure:",
      `   - title: paper title in ${lang} (keep English technical terms)`,
      "   - category: 'Paper'",
      `   - summary: detailed ${lang} summary (12-18 sentences, keep English technical terms). Separate each section with a blank line — do NOT write as one big paragraph. Structure:`,
      "     1) Problem & motivation (2-3 sentences)",
      "     2) Core method with key equations. Use LaTeX only when needed — display math `\\[...\\]` on its own line for loss functions or formulas, inline `\\(...\\)` for short symbols (`\\(\\lambda\\)`, `\\(\\mathcal{L}\\)`). DO NOT use `$...$` or `$$...$$` — those get mangled by shell expansion when the JSON payload is passed through `convex run`. The browser renderer maps `\\(\\)` and `\\[\\]` to KaTeX automatically. Every variable introduced in an equation MUST be defined in the surrounding Korean text (what it stands for, its type/shape if relevant) — no bare symbols without definitions. Plain variable names and function names stay as text. (3-5 sentences)",
      "     3) Architecture or algorithm specifics — what modules, what flows where, what's novel vs standard (2-3 sentences)",
      "     4) Key experimental results WITH numbers — accuracy, F1, BLEU, perplexity, % improvement over baselines (2-3 sentences)",
      "     5) Limitations or ablation highlights (1-2 sentences)",
      "     6) Takeaways — render exactly this block at the bottom of the summary body, after section 5, separated by a blank line:",
      "        ### Takeaways",
      "        - <one short Korean sentence, the most important thing a researcher should remember>",
      "        - <second takeaway>",
      "        - <third takeaway>",
      "        Three bullets, no more, no less. One sentence each. Concrete (cite numbers, named methods, or specific findings — not generic platitudes).",
      "     If the paper references important external URLs (project page, code repo, dataset page, blog post, related arxiv papers, demo, etc.), inline them as markdown links within the relevant sentence — e.g. '...released the code at [github.com/foo/bar](https://github.com/foo/bar).' Skip institutional / author homepages and DOI hyperlinks; only include links the reader would actually want to click.",
      "     LINK VERIFICATION (MANDATORY): verify every URL before writing it (inline links AND the url field): `curl -s -o /dev/null -w '%{http_code}' -L --max-time 8 '<url>'` must print 2xx. NEVER write a URL from memory or guess a path. On 404/failure, WebSearch the canonical URL and verify that; if nothing verifies, omit the link (plain text). The worker re-validates afterwards and strips dead links.",
      "     The summary body field is JUST the prose (sections 1-6 above) and ends with the Takeaways block — nothing after. Do NOT inline Research Level / Scores / PriorWork / Reasoning into the body text — those go into separate STRUCTURED FIELDS on the summaries:addBatch payload. Do NOT inline the paper URL into the body — the URL goes only in the `url` field and is rendered separately by the UI.",
      "     summaries:addBatch payload (each summary object) MUST include these structured fields in addition to title/category/summary/keywords/url:",
      "       researchLevel: <tier string from the list below, verbatim with parens>",
      "       scores: { soundness: <1-10>, originality: <1-10>, experiments: <1-10>, clarity: <1-10>, impact: <1-10>, significance: <1-10>, overall: <1-10>, confidence: <1-5> }",
      "       priorWork: [{ citation: '<short citation>', relation: '<how it relates>' }, ...]  (2-3 entries, the ones you found via WebSearch)",
      "       reasoning: '<2-3 sentences in Korean citing the specific evidence + prior-work finding that drives the tier>'",
      "     Tiers (parens are calibration anchors):",
      "       'Blog post level' / 'Workshop level' / 'Top workshop level (ICLR/NeurIPS/ICML workshop)' / 'Mid conference main (COLING, TMLR, EACL)' / 'Top conference finding (ACL Findings, EMNLP Findings)' / 'Top conference main (EMNLP, ACL, NAACL)' / 'Top 3 conference main (ICLR, ICML, NeurIPS)' / 'Top conference highlight (NeurIPS spotlight, ICLR oral)' / 'Top conference best paper'.",
      "     Apply the canonical peer-review rubric (criteria.md / paper-review.md style). The caps below are MECHANICAL — when a condition is met you MUST cap the score; you cannot override based on how interesting the work feels.",
      "       1. WebSearch the core technique + central claim + 2-3 nearest prior works BEFORE scoring. Emit a 'PriorWork:' block in the output (between Scores and Reasoning) listing the works you actually found. If WebSearch unavailable: 'PriorWork: (search unavailable)' and Originality is capped at 5.",
      "       2. ORIGINALITY MECHANICAL CAPS (apply whichever cap is lowest):",
      "          - PriorWork entry matches same core method (even in different domain / different name) → cap Originality at 4.",
      "          - PriorWork entry covers the same core finding → cap Originality at 4.",
      "          - Contribution is an extension / reframing / new combination of an established research line (data attribution, probing, fine-tuning analysis, scaling laws, mech-interp, prompting, RL alignment, evaluation, agents, etc.) → cap Originality at 6.",
      "          - 7-8 reserved for novel mechanism/result with no overlapping prior work in PriorWork.",
      "          - 9-10 reserved for paradigm-defining work (new sub-field).",
      "       3. EXPERIMENTS MECHANICAL CAPS (apply whichever cap is lowest):",
      "          - Single model family or single benchmark → cap Experiments at 6.",
      "          - Sub-1B scale only when claims target general LLMs → cap Experiments at 5.",
      "          - Missing standard SOTA baseline or non-standard protocol favoring the proposed method → cap Experiments at 5.",
      "       4. SOUNDNESS MECHANICAL CAPS:",
      "          - Moderate effect sizes (e.g. correlations < 0.7 used as primary evidence) → cap Soundness at 6.",
      "          - Paper itself flags a confounder it does not fully resolve → cap Soundness at 6.",
      "          - Claim scope exceeds evidence scope (broad claims with narrow validation) → cap Soundness at 5.",
      "       5. IMPACT / SIGNIFICANCE: incremental insight on established problem caps at 5. 7-8 needs evidence of practice-changing potential (adoption, new sub-area opened). 9-10 reshapes the field.",
      "       6. Counter LLM-bias frames: do NOT over-weight reproducibility / scalability / generalization / computational efficiency / theoretical foundations / technical soundness as default. Human reviewers weight clarity, motivation, impact, relevance, comparative analysis, overclaiming, writing quality.",
      "       7. Compute Overall as the mean of the 6 criteria, then subtract 0.3. Do not 'round up' if the result feels low — the mean is the score. Map per the table below.",
      "     Tier mapping from the final (deflated) Overall — Overall is the source of truth, the per-criterion scores justify it:",
      "       Overall ≥ 9.0 → 'Top conference best paper' · 8.3-8.9 → 'Top conference highlight (NeurIPS spotlight, ICLR oral)' · 7.5-8.2 → 'Top 3 conference main (ICLR, ICML, NeurIPS)' · 6.8-7.4 → 'Top conference main (EMNLP, ACL, NAACL)' · 6.0-6.7 → 'Top conference finding (ACL Findings, EMNLP Findings)' · 5.0-5.9 → 'Mid conference main (COLING, TMLR, EACL)' · 4.0-4.9 → 'Top workshop level (ICLR/NeurIPS/ICML workshop)' · 3.0-3.9 → 'Workshop level' · below 3 → 'Blog post level'.",
      "     Use the full tier range. If consecutive papers land on the same tier, re-check whether you are applying consistent severity per criteria.md.",
      "   - keywords: relevant tags",
      "   - url: the paper URL (or empty string if pasted)",
      `4. Call jobs:setTldr with a 3-element array. Line 1 motivation (what problem this paper attacks and why it matters). Line 2 method + headline result (what they did + the concrete number / outcome). Line 3 takeaway (why a researcher should remember this paper). One short ${lang} sentence each, keep English technical terms.`,
      "5. Update job status to 'suggested' (skip Notion suggestions).",
    );
    return parts.join("\n");
  }

  if (type === "pr-fix") {
    let prInfo;
    try {
      prInfo = JSON.parse(job.content || "{}");
    } catch {
      prInfo = {};
    }
    const repo = prInfo.repo || "";
    const prNum = prInfo.number || "";
    const action = prInfo.action || "fix";
    const prompt = prInfo.prompt || "";
    const repoName = repo.split("/").pop() || repo;
    const parentDir = resolve(process.cwd(), "..");

    if (action === "eval") {
      return `Run these commands in order. Do NOT run git status. Do NOT ask questions. Just execute:

gh pr diff ${prNum} --repo ${repo}
gh pr view ${prNum} --repo ${repo} --json title,body,labels,files,additions,deletions,changedFiles

Then based on the output, write an evaluation with:
- Line 1: What this PR does, why, key changes
- Line 2: Is this needed? Overlap with existing code?
- Line 3: "Merge: N%" or "Close: N%" with reasoning

Save it by running:
CONVEX_DEPLOYMENT=${process.env.CONVEX_DEPLOYMENT} npx convex run chats:reply '{"jobId":"${job._id}","content":"<your evaluation text>"${SK}}'
CONVEX_DEPLOYMENT=${process.env.CONVEX_DEPLOYMENT} npx convex run jobs:updateStatus '{"jobId":"${job._id}","status":"done"${SK}}'`;
    }

    if (action === "ask") {
      return `Run these commands in order. Do NOT run git status. Do NOT ask questions. Just execute:

gh pr diff ${prNum} --repo ${repo}
gh pr view ${prNum} --repo ${repo} --json title,body,labels,files

Question: ${prompt}

Answer concisely in English based on the PR diff above. Then save:
CONVEX_DEPLOYMENT=${process.env.CONVEX_DEPLOYMENT} npx convex run chats:reply '{"jobId":"${job._id}","content":"<your answer>"${SK}}'
CONVEX_DEPLOYMENT=${process.env.CONVEX_DEPLOYMENT} npx convex run jobs:updateStatus '{"jobId":"${job._id}","status":"done"${SK}}'`;
    }

    if (action === "repo-task") {
      const branchName = `task/${Date.now().toString(36)}`;
      return [
        `Execute a task in repo ${repo}.`,
        `Task: ${prompt || "No specific task given"}`,
        `Decide whether to push directly to main or create a new branch based on the task nature:`,
        `- Dependency updates, small fixes, config changes → push to main`,
        `- New features, refactors, risky changes → create branch and PR`,
        `Steps:`,
        `1. Find the project at ${parentDir}/${repoName}. If not found, run: gh repo clone ${repo} ${parentDir}/${repoName}`,
        `2. cd ${parentDir}/${repoName} && git fetch origin`,
        `3. Create worktree: git worktree add -b ${branchName} /tmp/repo-task-${repoName} origin/main`,
        `4. cd /tmp/repo-task-${repoName}`,
        `5. If package.json exists, run: pnpm install || npm install`,
        `6. Copy env files if they exist: cp ${parentDir}/${repoName}/.env* . 2>/dev/null || true`,
        `7. Do the requested task`,
        `8. Commit and push. If pushing to main: git push origin ${branchName}:main. Otherwise: git push -u origin ${branchName}`,
        `9. Write result summary to Convex: CONVEX_DEPLOYMENT=${process.env.CONVEX_DEPLOYMENT} npx convex run chats:reply '{"jobId":"${job._id}","content":"<your summary>"${SK}}'`,
        `10. Clean up: cd ${parentDir}/${repoName} && git worktree remove /tmp/repo-task-${repoName}`,
        `11. Update job status to 'done': CONVEX_DEPLOYMENT=${process.env.CONVEX_DEPLOYMENT} npx convex run jobs:updateStatus '{"jobId":"${job._id}","status":"done"${SK}}'`,
      ].join(" ");
    }

    // action === "fix" (default)
    return [
      `Fix failing CI for PR #${prNum} in ${repo}.`,
      `PR URL: ${job.url}`,
      prompt ? `Additional context: ${prompt}` : "",
      `Steps:`,
      `1. Run: gh pr view ${prNum} --repo ${repo} --json headRefName -q '.headRefName' to get the branch name.`,
      `2. Find the project directory at ${parentDir}/${repoName}. If it doesn't exist, run: gh repo clone ${repo} ${parentDir}/${repoName}`,
      `3. Create a git worktree: cd ${parentDir}/${repoName} && git fetch origin && git worktree add /tmp/pr-fix-${prNum} <branch-name>`,
      `4. cd /tmp/pr-fix-${prNum}`,
      `5. If package.json exists, run: pnpm install (or npm install)`,
      `6. If .env.example or .env.local exists in the main repo, copy it: cp ${parentDir}/${repoName}/.env* . 2>/dev/null`,
      `7. Run the failing CI checks locally to see what's broken`,
      `8. Fix the issues`,
      `9. Commit and push: git add -A && git commit -m "fix: resolve CI failures" && git push`,
      `10. Clean up worktree: cd ${parentDir}/${repoName} && git worktree remove /tmp/pr-fix-${prNum}`,
      `11. Write a result summary to the chat: CONVEX_DEPLOYMENT=${process.env.CONVEX_DEPLOYMENT} npx convex run chats:reply '{"jobId":"${job._id}","content":"<brief summary of what was fixed or why it failed>"${SK}}'`,
      `12. If the fix succeeded, leave a concise public comment on the PR: gh pr comment ${prNum} --repo ${repo} --body "<what was fixed>". Keep it factual — no internal details, no API keys, no file paths.`,
      `13. If the fix FAILED, still write a chat reply explaining why, and leave a PR comment: gh pr comment ${prNum} --repo ${repo} --body "Automated fix attempted but failed: <reason>".`,
      `14. Update job status: CONVEX_DEPLOYMENT=${process.env.CONVEX_DEPLOYMENT} npx convex run jobs:updateStatus '{"jobId":"${job._id}","status":"done"${SK}}'`,
    ].join(" ");
  }

  if (type === "article" && job.scoresOnly === true) {
    // Rescore-only path for articles: existing summary text stays, only the
    // structured articleScores get filled. Mirrors the paper scoresOnly
    // branch; triggered by jobs.retryArticleJobsWithoutScores.
    return [
      `Rescore article job ${job._id}. The existing summary text is correct. Do NOT rewrite it, do NOT create new summary rows.`,
      `1. Fetch the existing summary: CONVEX_DEPLOYMENT=${process.env.CONVEX_DEPLOYMENT} npx convex run summaries:listByJob '{"jobId":"${job._id}"${SK}}'  — take the first row; its summary text is your primary source (it already contains the evidence/logic/persuasiveness analysis).`,
      job.url
        ? `2. The original article is at ${job.url}. WebFetch it if the summary alone leaves a criterion ambiguous. If the fetch fails, score from the summary.`
        : `2. No source URL: score from the summary text alone.`,
      `3. Score each criterion 1-10. SCORING PROTOCOL: every criterion STARTS AT 5 (a typical competent tech blog post IS a 5; competent is the median, not 8). Raise above 6 ONLY by identifying a specific element of THIS article that a typical competent post lacks; absent that, 5-6 is the score. Well-written professional prose is clarity 5-6; clarity 8+ means structure that actively teaches. Sound reasoning is logic 5-6; logic 8+ means the author anticipates and dismantles counterarguments. Most articles land 4-7 overall; 8+ is the top ~10% you would still cite a year from now. If all six criteria land 7+, you are inflating: restart scoring. The caps are MECHANICAL: when a condition is met you MUST cap:`,
      `   evidence: CAPS: no primary sources / no concrete numbers → cap 4. Only the vendor's own claims or a single anecdote → cap 5. 8+ requires original data or multiple independent primary sources.`,
      `   logic: CAPS: an obvious counterargument never addressed → cap 6. Correlation-as-causation or an unstated assumption doing the real work → cap 5.`,
      `   objectivity: CAPS: author sells their own product/company (vendor blog, founder post) → cap 5. One-sided advocacy, no opposing view engaged → cap 5. 8+ requires genuine steelmanning.`,
      `   novelty: CAPS: rehash of other coverage / widely-held position restated → cap 4. Standard take already common in the discourse → cap 6. 7+ requires original reporting, new data, or a genuinely new argument.`,
      `   clarity: structure and readability.`,
      `   impact: CAPS: niche audience or irrelevant-in-a-month news → cap 5.`,
      `   overall: mean of the six, then subtract 0.3. Do not round up; the mean is the score.`,
      `   verdict: map overall → ≥8 'Very convincing' · 6.5-7.9 'Mostly convincing' · 5-6.4 'Mixed' · 3-4.9 'Weak' · below 3 'Misleading'.`,
      `4. Patch the summary row. OVERWRITE any existing articleScores, your fresh scoring is canonical: CONVEX_DEPLOYMENT=${process.env.CONVEX_DEPLOYMENT} npx convex run summaries:patchScores '{"summaryId":"<id>","articleScores":{"evidence":N,"logic":N,"objectivity":N,"novelty":N,"clarity":N,"impact":N,"overall":N,"verdict":"<string>"}${SK}}'`,
      `5. Clear the flag and restore status:`,
      `   CONVEX_DEPLOYMENT=${process.env.CONVEX_DEPLOYMENT} npx convex run jobs:clearScoresOnly '{"jobId":"${job._id}"${SK}}'`,
      `   CONVEX_DEPLOYMENT=${process.env.CONVEX_DEPLOYMENT} npx convex run jobs:updateStatus '{"jobId":"${job._id}","status":"suggested"${SK}}'`,
      `Exit after step 5.`,
    ].join("\n");
  }

  // article
  const parts = [
    `Process article job with ID ${job._id}.`,
    `The input is: ${job.url || (job.imagePath ? "(pasted screenshot)" : "(pasted content)")}`,
  ];
  if (!job.content && !job.url && job.imagePath) {
    parts.push(
      pastedImageLine(job),
      `From the image(s), identify the article: title, author/publication, any distinctive sentence. Then WebSearch those to find the canonical article URL.`,
      `WebFetch that URL to read the FULL article — do NOT analyze from the screenshot alone (it's usually a partial capture). If WebFetch fails (403/paywall), use Playwright (browser_navigate + browser_snapshot) as fallback; if that also fails, work from the screenshot text and note the limitation in the summary.`,
      `Store the discovered URL on the job: CONVEX_DEPLOYMENT=${process.env.CONVEX_DEPLOYMENT} npx convex run jobs:setUrl '{"jobId":"${job._id}","url":"<canonical url>"${SK}}' and pass it as the url field in summaries:addBatch.`,
    );
  }
  if (job.content) {
    parts.push(
      `The user pasted the article content. Use it directly — do NOT WebFetch the article itself (you already have the text), do NOT open a browser app, do NOT consult other jobs, summarize EXACTLY this content and nothing else.`,
    );
    parts.push(`=== BEGIN ARTICLE CONTENT (jobId=${job._id}) ===`);
    parts.push(job.content.slice(0, 30000));
    parts.push(`=== END ARTICLE CONTENT ===`);
    parts.push(
      `If the original article URL is missing (pasted plain text), use WebSearch on the article title + a distinctive sentence to find the canonical source URL. Pass that URL as the \`url\` field in summaries:addBatch so the saved article links back to the original. If WebSearch fails or returns nothing credible, leave url as empty string.`,
    );
  } else if (job.url) {
    parts.push(
      "WebFetch the URL to read the article.",
      "If WebFetch fails (403, paywall, etc.), use Playwright (browser_navigate + browser_snapshot) as fallback.",
    );
  }
  parts.push(
    "Steps:",
    "1. Read the article content.",
    "2. Set the title with jobs:updateTitle to a short descriptive title.",
    "3. Write a single summary to Convex using summaries:addBatch with this structure:",
    `   - title: article title in ${lang} (keep English technical terms)`,
    "   - category: 'News' or 'Article'",
    `   - summary: detailed ${lang} analysis (10-15 sentences, keep English technical terms). Separate each section with a blank line — do NOT write as one big paragraph. Structure:`,
    "     1) Core claim: what is the article arguing or reporting? (2-3 sentences)",
    "     2) Evidence & data: what facts, numbers, sources, or examples support the claim? How strong is the evidence? (2-3 sentences)",
    "     3) Critical analysis: are there logical gaps, missing perspectives, unstated assumptions, or counterarguments the author ignores? Is the framing balanced or biased? (2-3 sentences)",
    "     4) Persuasiveness: how convincing is the overall argument? Rate as one of: 'Very convincing', 'Mostly convincing', 'Mixed', 'Weak', 'Misleading'. Explain why. (1-2 sentences)",
    "     5) So what: why does this matter? Who should care and what are the implications? (1 sentence)",
    "     If the article references important external URLs (referenced report, source paper, github repo, dataset, related article, primary source it links out to, etc.), inline them as markdown links within the relevant sentence — e.g. '...the original [Anthropic post](https://...) reported...'. Skip the article's own URL (that's already the `url` field) and skip pure boilerplate links (homepage, social profile, ads).",
    "     LINK VERIFICATION (MANDATORY): verify every URL before writing it (inline links AND the url field): `curl -s -o /dev/null -w '%{http_code}' -L --max-time 8 '<url>'` must print 2xx. NEVER write a URL from memory or guess a path (e.g. vendor.com/feature-name); only link URLs that appear in the article itself or that you verified via WebSearch. On 404/failure, find the canonical URL and verify that; if nothing verifies, omit the link (plain text). The worker re-validates afterwards and strips dead links.",
    "   - articleScores: STRUCTURED FIELD on the summaries:addBatch payload (NOT inlined in the body text). SCORING PROTOCOL: every criterion STARTS AT 5 (a typical competent tech blog post IS a 5; competent is the median, not 8). You may raise a criterion above 6 ONLY by identifying a specific element of THIS article that a typical competent post lacks; absent that, 5-6 is the score. Well-written professional prose is clarity 5-6; clarity 8+ means structure that actively teaches (layered explanations, diagrams, progressive examples). Sound reasoning is logic 5-6; logic 8+ means the author anticipates and dismantles counterarguments. Expect most articles to land 4-7 overall; 8+ is the top ~10% you would still cite a year from now. If all six criteria land 7+, you are inflating: restart scoring. The caps below are MECHANICAL: when a condition is met you MUST cap the score:",
    "       evidence: quality + verifiability of the supporting facts/data/sources. CAPS: no primary sources / no concrete numbers → cap 4. Only the vendor's own claims or a single anecdote → cap 5. 8+ requires original data or multiple independent primary sources.",
    "       logic: internal consistency. CAPS: an obvious counterargument the author never addresses → cap 6. Correlation treated as causation, or an unstated assumption doing the real work → cap 5.",
    "       objectivity: balance of framing. CAPS: author sells their own product/company (vendor blog, founder post) → cap 5. One-sided advocacy with no opposing view engaged → cap 5. 8+ requires genuinely steelmanning the other side.",
    "       novelty: what the reader learns beyond common knowledge. CAPS: rehash of other coverage or restating a widely-held position → cap 4. A standard take already common in the discourse → cap 6. 7+ requires original reporting, new data, or a genuinely new argument.",
    "       clarity: structure and readability of the writing itself.",
    "       impact: importance + implications. CAPS: niche audience or news that will be irrelevant in a month → cap 5.",
    "       overall: mean of the six criteria, then subtract 0.3. Do not round up; the mean is the score.",
    "       verdict: copy the EXACT persuasiveness rating string from section 4 ('Very convincing' / 'Mostly convincing' / 'Mixed' / 'Weak' / 'Misleading'). Keep it consistent with overall: ≥8 Very convincing · 6.5-7.9 Mostly convincing · 5-6.4 Mixed · 3-4.9 Weak · below 3 Misleading.",
    "   - keywords: relevant tags",
    "   - url: the article URL (or empty string if pasted)",
    `4. Call jobs:setTldr with a 3-element array. Line 1 core claim (what the article argues or reports). Line 2 evidence + persuasiveness (key data plus how convincing). Line 3 so-what (why it matters, who should care). One short ${lang} sentence each, keep English technical terms.`,
    "5. Update job status to 'suggested' (skip Notion suggestions).",
  );
  return parts.join("\n");
}

const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /out.?of.?limit/i,
  /quota.?exceeded/i,
  /too.?many.?requests/i,
  /429/i,
  /capacity/i,
  /overloaded/i,
];

function isRateLimitError(stderr) {
  return RATE_LIMIT_PATTERNS.some((p) => p.test(stderr));
}

// Extract the arxiv id from an arxiv.org / alphaxiv.org link in any of
// abs/, pdf/, or html/ form (with or without version suffix). Returns the
// bare id (e.g. "2405.07987" or "2405.07987v2") or null when the URL
// doesn't match.
function extractArxivId(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/(?:arxiv|alphaxiv)\.org\/(?:abs|pdf|html)\/([\w.\-]+?)(?:\.pdf)?(?:[/?#].*)?$/i);
  return m ? m[1] : null;
}

// Run pdftotext over a downloaded PDF, mutating job.content with the
// extracted text. Returns true when extraction yielded usable text.
function pdfToContent(job: any, pdfUrl: string, label: string): boolean {
  const pdfPath = `./tmp/paper-${job._id}.pdf`;
  const txtPath = `./tmp/paper-${job._id}.txt`;
  try {
    mkdirSync("./tmp", { recursive: true });
    execFileSync("curl", ["-fL", "--retry", "2", "--max-time", "60", "-o", pdfPath, pdfUrl], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 90_000,
    });
    execFileSync("pdftotext", ["-layout", "-nopgbrk", pdfPath, txtPath], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 60_000,
    });
    const text = readFileSync(txtPath, "utf8");
    if (text.length < 500) {
      console.warn(`[worker] pdftotext for ${job._id} (${label}) returned only ${text.length} chars`);
      return false;
    }
    job.content = text;
    console.log(`[worker] paper ${job._id}: extracted ${text.length} chars from ${label} (${pdfUrl})`);
    return true;
  } catch (e: any) {
    console.warn(`[worker] pdf extract failed for ${job._id} (${label}): ${String(e?.message ?? e).slice(0, 200)}`);
    return false;
  }
}

// Find a likely paper PDF on an arbitrary HTML page. Looks for an <a> with
// "paper" / "pdf" / "preprint" text or a href ending in .pdf, preferring
// the first match. Returns an absolute URL or null.
function findPaperPdfLink(pageUrl: string, html: string): string | null {
  const candidates: string[] = [];
  // <a href="...pdf"> with paper-y anchor text
  const linkRe = /<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, "").trim();
    if (/^javascript:|^mailto:|^#/.test(href)) continue;
    const isPdf = /\.pdf(?:$|[?#])/i.test(href);
    const isPaperText = /\b(paper|pdf|preprint|manuscript|full[\s-]?text)\b/i.test(text);
    if (isPdf || isPaperText) candidates.push(href);
  }
  // also bare arxiv.org/abs/<id> links (we'll resolve via existing path)
  const arxivMatch = html.match(/https?:\/\/(?:www\.)?arxiv\.org\/abs\/[\w.\-]+/i);
  if (arxivMatch) candidates.unshift(arxivMatch[0]);
  if (!candidates.length) return null;
  const pick = candidates[0];
  try {
    return new URL(pick, pageUrl).toString();
  } catch {
    return null;
  }
}

// If the job is a paper with an arxiv/alphaxiv URL but no pasted content,
// download the PDF and run pdftotext so the agent reads the same full text
// it would have if the user pasted it. For non-arxiv research / project /
// openreview URLs, fetch the HTML and try to locate a PDF link before
// falling back to the agent reading the raw page.
function maybeExtractPaperPdf(job: any) {
  if (job.type !== "paper") return;
  if (typeof job.content === "string" && job.content.length > 200) return;
  const arxivId = extractArxivId(job.url);
  if (arxivId) {
    pdfToContent(job, `https://arxiv.org/pdf/${arxivId}.pdf`, `arxiv ${arxivId}`);
    return;
  }
  if (!job.url || !/^https?:\/\//i.test(job.url)) return;
  // Non-arxiv path: fetch the landing page and scrape a PDF link.
  try {
    const html = execFileSync(
      "curl",
      ["-fL", "--retry", "2", "--max-time", "30", "-A", "Mozilla/5.0 (openworks)", job.url],
      { encoding: "utf8", timeout: 45_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const pdfLink = findPaperPdfLink(job.url, html);
    if (!pdfLink) {
      console.warn(`[worker] paper ${job._id}: no PDF link found at ${job.url} — agent will read the page directly`);
      return;
    }
    // If the discovered link is an arxiv abs URL, redirect to the PDF.
    const nestedArxiv = extractArxivId(pdfLink);
    const resolved = nestedArxiv ? `https://arxiv.org/pdf/${nestedArxiv}.pdf` : pdfLink;
    pdfToContent(job, resolved, `scraped from ${job.url}`);
  } catch (e: any) {
    console.warn(`[worker] paper ${job._id}: landing-page fetch failed (${String(e?.message ?? e).slice(0, 160)})`);
  }
}

// Download a clipboard-pasted screenshot from Convex storage to ./tmp so
// the agent can Read it. Sets job.imagePath for buildPrompt.
// The "read the pasted screenshot(s)" instruction, singular or plural.
function pastedImageLine(job: any): string {
  const paths: string[] = job.imagePaths ?? (job.imagePath ? [job.imagePath] : []);
  if (paths.length > 1) {
    return `The user pasted ${paths.length} SCREENSHOTS instead of a URL or text. They are on disk at: ${paths.join(", ")}. Read/view ALL of these image files FIRST — they are pages/parts of the same source, so combine what you read across them.`;
  }
  return `The user pasted a SCREENSHOT instead of a URL or text. The image is on disk at ${paths[0]}. Read/view that image file FIRST.`;
}

function maybeFetchJobImage(job: any) {
  if (!job.imageId) return;
  if (job.type !== "paper" && job.type !== "article" && job.type !== "newsletter") return;
  try {
    const raw = convexRun("jobs:imageUrls", JSON.stringify({ jobId: job._id }));
    if (!raw || raw === "null") return;
    const urls = JSON.parse(raw);
    if (!Array.isArray(urls) || urls.length === 0) return;
    mkdirSync("./tmp", { recursive: true });
    const paths: string[] = [];
    urls.forEach((url: unknown, i: number) => {
      if (typeof url !== "string") return;
      const imgPath = `./tmp/job-image-${job._id}-${i}.png`;
      execFileSync("curl", ["-fsL", "--max-time", "30", "-o", imgPath, url], {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 45_000,
      });
      paths.push(imgPath);
    });
    if (paths.length === 0) return;
    job.imagePaths = paths;
    job.imagePath = paths[0];
    console.log(`[worker] ${job.type} ${job._id}: downloaded ${paths.length} pasted image(s) to ./tmp`);
  } catch (e: any) {
    console.warn(`[worker] image fetch failed for ${job._id}: ${String(e?.message ?? e).slice(0, 160)}`);
  }
}

// Pull the full gmail body in worker-context (plain Node, no hai-guardian
// hooks) and sanitize anything that LOOKs like a credential before stamping
// onto job.content. Agents then read the cleaned content via the standard
// content prompt path — they don't trigger `read_file` on raw email files,
// which is what hai-guardian was blocking.
function maybeFetchNewsletterEmail(job: any) {
  if (job.type !== "newsletter") return;
  if (typeof job.content === "string" && job.content.length > 200) return;
  if (!job.emailId) return;
  try {
    const params = JSON.stringify({ userId: "me", id: job.emailId, format: "full" });
    const out = execFileSync("gws", ["gmail", "users", "messages", "get", "--params", params, "--format", "json"], {
      timeout: 30_000,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const msg = JSON.parse(out) as {
      payload?: { headers?: { name: string; value: string }[]; body?: { data?: string }; parts?: any[] };
      snippet?: string;
    };
    const bodyParts: string[] = [];
    const walk = (p: any) => {
      if (!p) return;
      const data = p.body?.data;
      if (data) {
        const buf = Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
        const text = buf.toString("utf8");
        if (p.mimeType === "text/plain" || p.mimeType === "text/html") bodyParts.push(text);
        else bodyParts.push(text);
      }
      if (Array.isArray(p.parts)) for (const sub of p.parts) walk(sub);
    };
    walk(msg.payload);
    let body = bodyParts.join("\n\n");
    // strip HTML tags + entity decode (cheap pass — agents tolerate
    // residual entities, and TLDR/AlphaSignal emails are mostly text).
    body = body
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
    // Drop tracking query params from every URL — utm_*, mc_eid,
    // ck_subscriber_id, etc. These look like API keys to hai-guardian
    // (long random tokens) and produce 90% of the false positives.
    body = body.replace(/(https?:\/\/[^\s)"']+)/g, (url) => {
      const i = url.indexOf("?");
      if (i < 0) return url;
      const base = url.slice(0, i);
      const params = new URLSearchParams(url.slice(i + 1));
      const keep = new URLSearchParams();
      for (const [k, v] of params) {
        const kl = k.toLowerCase();
        if (/^(utm_|ref|source|mc_|ck_|s|r|token|key|tracking|trk|email|recipient)/.test(kl)) continue;
        keep.append(k, v);
      }
      const q = keep.toString();
      return q ? `${base}?${q}` : base;
    });
    // Generic token-like blob masker — anything looking like a 32+ char
    // base64/hex blob. No hyphens in the class: real secrets are almost
    // never hyphenated, while article-slug URL segments usually are —
    // including `-` masked legit news slugs (9to5google etc.) and the
    // agent then copied the corrupted URL into summaries.
    body = body.replace(/\b[A-Za-z0-9_]{32,}\b/g, "<token>");
    // Email date header for the prompt's title-renaming step.
    const hdrs = Object.fromEntries((msg.payload?.headers ?? []).map((h) => [h.name, h.value]));
    const date = hdrs.Date ? new Date(hdrs.Date).toISOString().slice(0, 10) : "";
    const header = `[Email Date: ${date}]\n[Subject: ${hdrs.Subject ?? ""}]\n[From: ${hdrs.From ?? ""}]\n\n`;
    const full = (header + body).slice(0, 200_000);
    job.content = full;
    try {
      convexRun("jobs:setContent", JSON.stringify({ jobId: job._id, content: full }));
    } catch {}
    console.log(`[worker] newsletter ${job._id}: fetched ${full.length} chars from gmail ${job.emailId}`);
  } catch (e: any) {
    console.warn(
      `[worker] newsletter fetch failed for ${job._id} (${job.emailId}): ${String(e?.message ?? e).slice(0, 200)}`,
    );
  }
}

function processJob(job: any, providerName?: import("./actor.mts").ProviderName) {
  const jobId = job._id;
  const type = job.type || "newsletter";
  // Image submissions need a vision-capable CLI: codex exec cannot view
  // images (observed: it falls back to local OCR attempts, fails, then
  // hallucinates a famous paper). claude/antigravity read PNGs natively.
  const order: import("./actor.mts").ProviderName[] = job.imageId ? ["claude", "antigravity", "codex"] : orderFor(type);
  const name = providerName || order[0];
  console.log(`[worker] start ${jobId} (${type}) [${name}]`);

  // Clipboard-screenshot submissions: download the pasted image so the
  // agent can identify the paper/article from it (title/authors via its
  // vision), then find + fetch the canonical source itself.
  maybeFetchJobImage(job);
  // Equalize URL-based papers with paste-based papers: download + pdftotext
  // arxiv/alphaxiv links before the prompt is built so the agent always
  // sees the full body on disk instead of relying on an HTML fetch.
  maybeExtractPaperPdf(job);
  // Same idea for newsletters — fetch + sanitize the gmail body here so the
  // agent can summarize from prompt-embedded text instead of triggering a
  // tool call that hai-guardian blocks on detected secrets.
  maybeFetchNewsletterEmail(job);

  const prompt = buildPrompt(job);

  const env = { ...process.env, CLAUDECODE: undefined, OPENWORKS_WORKER: "1" };
  // pr-fix jobs run from /tmp to avoid picking up CLAUDE.md from openworks
  const cwd = type === "pr-fix" ? "/tmp" : process.cwd();
  const skipMcp = type === "pr-fix";
  convexRun("jobs:setProvider", JSON.stringify({ jobId, provider: name }));
  const child = spawnFor(name, { prompt, cwd, env, mode: "job", skipMcp });

  active.set(jobId, child);

  let output = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    output += d.toString();
  });
  child.stderr.on("data", (d) => {
    const chunk = d.toString();
    stderr += chunk;
    process.stderr.write(`[${jobId.slice(-6)}] ${chunk}`);
  });

  // Hard timeout
  const timeout = setTimeout(() => {
    console.log(`[worker] timeout ${jobId}`);
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5000);
  }, WORKER_TIMEOUT);

  // Poll job status — kill child if job already done
  const statusCheck = setInterval(() => {
    const raw = convexRun("jobs:getById", JSON.stringify({ jobId }));
    if (!raw) return;
    try {
      const j = JSON.parse(raw);
      if (isTerminalJobStatus(j.status)) {
        console.log(`[worker] job ${jobId} already ${j.status}, killing child`);
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 3000);
      }
    } catch {}
  }, 15_000);

  child.on("close", (code) => {
    clearTimeout(timeout);
    clearInterval(statusCheck);
    active.delete(jobId);
    wakeQueues();
    console.log(`[worker] done ${jobId} (exit ${code}) [${name}]`);

    // Parse token usage from agent output. Each provider has a slightly
    // different shape: claude --output-format json puts it at
    // result.usage.{input,output}_tokens; codex prints "tokens used: N" lines
    // to stderr; antigravity's output may carry usage_metadata. Best-effort;
    // missing tokens are simply not recorded.
    const usage = extractTokenUsage(name, output, stderr);
    const live = (() => {
      const raw = convexRun("jobs:getById", JSON.stringify({ jobId }));
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })();
    const advanced = live && (live.status === "suggested" || live.status === "done");
    if (usage || advanced) {
      try {
        convexRun(
          "jobs:recordAttemptResult",
          JSON.stringify({
            jobId,
            ...(usage?.input !== undefined ? { inputTokens: usage.input } : {}),
            ...(usage?.output !== undefined ? { outputTokens: usage.output } : {}),
            completed: !!advanced,
          }),
        );
      } catch {}
    }

    // Stamp provider on every summary row this run produced, so the UI can
    // show per-row provider icons (newsletters can have multiple rows, each
    // produced under fallback chain, but the same agent finished all in a
    // single attempt — so the same name is correct for that batch).
    if (advanced) {
      try {
        convexRun("summaries:setProviderForJob", JSON.stringify({ jobId, provider: name }));
      } catch {}
      // Mechanical link pass — agents are told to verify URLs but drift;
      // this guarantees no definitively-dead link survives in the stored
      // summaries regardless of agent behavior.
      if (type !== "pr-fix") void validateJobLinks(jobId);
      return;
    }

    // Treat as failure whenever the job did NOT advance to a terminal
    // status, regardless of exit code. Earlier we trusted exit 0 as success,
    // but agents can clean-exit after being interrupted by hooks/policies
    // (e.g. hai-guardian blocked the read) — the only authoritative signal
    // is the DB status. Skip when we killed the child ourselves (143/null).
    if (code === 143 || code === null) return;
    const next = actorNextProvider(name, order);
    if (next && live && (live.status === "pending" || live.status === "summarizing" || live.status === "suggesting")) {
      console.log(`[worker] fallback ${name} → ${next} for ${jobId} (exit ${code})`);
      processJob(job, next);
      return;
    }
    // Fallback chain exhausted — mark error so the unstick loop stops
    // re-claiming this job every 30 min. Surface a short reason from the
    // child's stderr tail so the UI can show what blocked it.
    const reason =
      (stderr || output)
        .split("\n")
        .reverse()
        .find((l) => l.trim().length > 0)
        ?.slice(0, 200) ?? `exit ${code}`;
    console.log(`[worker] giving up on ${jobId}: ${reason}`);
    try {
      convexRun("jobs:updateStatus", JSON.stringify({ jobId, status: "error", error: `[${name}] ${reason}` }));
    } catch {}
  });
}

// Best-effort token-usage extraction across the three providers we spawn.
function extractTokenUsage(
  provider: string,
  stdout: string,
  stderr: string,
): { input?: number; output?: number } | null {
  if (provider === "claude") {
    // claude --output-format json emits a single JSON object on stdout
    // with usage.input_tokens / usage.output_tokens at the top level or
    // under .result.usage. Tolerant of either shape.
    try {
      const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "");
      const u = parsed?.usage ?? parsed?.result?.usage;
      if (u && (u.input_tokens !== undefined || u.output_tokens !== undefined)) {
        return { input: u.input_tokens, output: u.output_tokens };
      }
    } catch {}
    return null;
  }
  if (provider === "codex") {
    // codex prints "tokens used: N" to stderr at the end of each session.
    // Newer builds emit "input tokens: N" / "output tokens: N".
    const text = stderr + "\n" + stdout;
    const inM = text.match(/input[_\s-]?tokens\s*[:=]\s*(\d+)/i);
    const outM = text.match(/output[_\s-]?tokens\s*[:=]\s*(\d+)/i);
    const totM = text.match(/tokens\s*used\s*[:=]\s*(\d+)/i);
    if (inM || outM) return { input: inM ? Number(inM[1]) : undefined, output: outM ? Number(outM[1]) : undefined };
    if (totM) return { output: Number(totM[1]) };
    return null;
  }
  if (provider === "antigravity") {
    // antigravity (Gemini-powered) may surface a usage_metadata block; fall
    // through if not present (no token signal available).
    const text = stderr + "\n" + stdout;
    const inM = text.match(/prompt[_\s-]?token[_\s-]?count\s*[:=]\s*(\d+)/i);
    const outM = text.match(/candidates[_\s-]?token[_\s-]?count\s*[:=]\s*(\d+)/i);
    if (inM || outM) return { input: inM ? Number(inM[1]) : undefined, output: outM ? Number(outM[1]) : undefined };
    return null;
  }
  return null;
}

function answerChat(chatEntry: any, providerName?: import("./actor.mts").ProviderName) {
  const { jobId, messages } = chatEntry;
  const chatKey = `chat:${jobId}`;
  if (active.has(chatKey)) return;
  const order = orderFor("chat");
  const name = providerName || order[0];
  console.log(`[worker] chat ${jobId} [${name}]`);

  // Get job info for context
  const jobRaw = convexRun("jobs:getById", JSON.stringify({ jobId }));
  let jobInfo = null;
  try {
    jobInfo = JSON.parse(jobRaw);
  } catch {}

  // Get summaries for context. A single job can hold several items (e.g. two
  // papers pasted together), so include every summary AND its source URL, and
  // track the count so the prompt can tell the agent the on-disk file may only
  // cover one of them.
  const sumRaw = convexRun("summaries:listByJob", JSON.stringify({ jobId }));
  let context = "";
  let summaryCount = 0;
  if (sumRaw) {
    try {
      const sums = JSON.parse(sumRaw);
      summaryCount = sums.length;
      context = sums.map((s) => `[${s.title}]${s.url ? ` <${s.url}>` : ""}\n${s.summary}`).join("\n\n");
    } catch {}
  }

  // Build PR context if this is a PR job
  let prContext = "";
  if (jobInfo?.type === "pr-fix" || jobInfo?.url?.includes("github.com")) {
    try {
      const prData = JSON.parse(jobInfo.content || "{}");
      prContext = `\nThis is about a GitHub PR:\n- Repo: ${prData.repo || jobInfo.url}\n- PR #${prData.number}\n- Title: ${prData.title}\n- Action: ${prData.action || "chat"}\n`;
    } catch {
      prContext = `\nThis is about: ${jobInfo.url}\n`;
    }
  }

  // Paper / article followup: ensure the full paste content lives at the
  // same /tmp path the original summarization job used, so the agent can
  // Read it for deeper questions instead of relying only on the Korean
  // summary blob.
  let paperPath = "";
  if (
    !prContext &&
    jobInfo &&
    (jobInfo.type === "paper" || jobInfo.type === "article") &&
    typeof jobInfo.content === "string" &&
    jobInfo.content.length > 50
  ) {
    paperPath = `./tmp/paper-${jobId}.md`;
    try {
      mkdirSync("./tmp", { recursive: true });
      writeFileSync(paperPath, jobInfo.content, "utf8");
    } catch (e) {
      console.error(`[chat] failed to write ${paperPath}: ${(e as Error).message}`);
      paperPath = "";
    }
  }

  // Replay the exact prompt that the summarization agent received, so the
  // chat agent shares the same instruction context as the original turn.
  // Cross-provider session resume isn't available, but reading the same
  // instructions + same paper file gets us close.
  let originalSummarizationPrompt = "";
  if (!prContext && jobInfo) {
    try {
      originalSummarizationPrompt = buildPrompt(jobInfo);
    } catch {}
  }

  const history = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  const prompt = [
    prContext
      ? `You are answering questions about a GitHub PR.${prContext}`
      : `You are answering a followup question about a summarized paper/article.`,
    paperPath && summaryCount > 1
      ? `This job covers ${summaryCount} items (see the summaries below, each tagged with its source URL in <angle brackets>). The on-disk file at ${paperPath} holds the FULL TEXT of only ONE of them; the summaries are authoritative for every item. If the question is about an item whose full text is NOT in that file, ground your answer in that item's summary and, when you need specifics (equations, numbers), WebFetch its source URL. Do NOT refuse or disclaim with "the file is a different paper" — use the relevant summary + its URL. For the item whose full text IS in the file, ground paper specifics (names, numbers, equations, citations) in the file. Define every variable in an equation where it first appears.`
      : paperPath
        ? `Full paper at ${paperPath} (${jobInfo.content.length} chars). Ground every claim ABOUT THE PAPER (names, numbers, equations, citations) in text that appears in the paper file; do not infer paper specifics from training data. For anything outside the paper (canonical source URL, related work, current events) USE WebSearch/WebFetch and attribute it as web-sourced. If neither the paper nor a search supports what the user asked, say so directly. Every variable in an answer's equation must be defined where it first appears.`
        : "",
    originalSummarizationPrompt
      ? `\n--- Original summarization instructions (for shared context) ---\n${originalSummarizationPrompt}\n--- end ---`
      : "",
    context
      ? `\n${summaryCount > 1 ? `Summaries (${summaryCount} items, one block each)` : "Summary that was written"}:\n${context}`
      : "",
    `\nChat history:\n${history}`,
    `\nRespond in the same language as the user's last message. Be concise and specific. Include LaTeX equations ($...$) when relevant. Do NOT use bold (**).`,
    `WebSearch and WebFetch are allowed and encouraged when the question needs them (finding the original article URL, verifying a fact, related work). If the user asks to fix a missing or wrong source URL, you may run: CONVEX_DEPLOYMENT=${process.env.CONVEX_DEPLOYMENT} npx convex run jobs:setUrl '{"jobId":"${jobId}","url":"<verified url>"${SK}}' (verify the URL resolves with curl first). No other mutations, no file edits. Your final output is the reply text only.`,
  ]
    .filter(Boolean)
    .join("\n");

  const env = { ...process.env, CLAUDECODE: undefined, OPENWORKS_WORKER: "1" };
  const child = spawnFor(name, { prompt, cwd: process.cwd(), env, mode: "chat" });

  active.set(chatKey, child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d.toString();
  });
  child.stderr.on("data", (d) => {
    const chunk = d.toString();
    stderr += chunk;
    process.stderr.write(`[chat:${jobId.slice(-6)}] ${chunk}`);
  });

  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
  }, 120_000);

  child.on("close", (code) => {
    clearTimeout(timeout);
    active.delete(chatKey);
    wakeQueues();
    console.log(`[worker] chat done ${jobId} (exit ${code}) [${name}]`);

    if (code === 0 && stdout.length > 0) {
      try {
        let reply = stdout.trim();
        try {
          reply = JSON.parse(reply).result || reply;
        } catch {}
        // Defensive: strip claude CLI diagnostic banners that occasionally
        // leak into plain-text stdout. The `--output-format json` switch
        // above is the real fix; this catches anything that slips past it
        // and any future similar banners from other CLIs.
        reply = reply.replace(/^MCP issues detected\. Run \/mcp list for status\.\s*/i, "").trim();
        if (reply && !reply.startsWith("Error")) {
          convexRun("chats:reply", JSON.stringify({ jobId, content: reply, provider: name }));
          console.log(`[worker] chat reply written for ${jobId} (${name})`);
        }
      } catch {}
    } else if (code !== 0 && code !== 143 && code !== null) {
      const next = actorNextProvider(name, order);
      if (next) {
        console.log(`[worker] chat fallback ${name} → ${next} for ${jobId} (exit ${code})`);
        answerChat(chatEntry, next);
      }
    }
  });
}

// Diet tab: identify a logged food photo and estimate calories + macros.
const activeDiet = new Set<string>();
async function processDietEntry(entry: any) {
  if (activeDiet.has(entry._id)) return;
  activeDiet.add(entry._id);
  try {
    let imgLine = "(no image was attached — estimate from the name/notes only)";
    let imgPath = "";
    if (entry.imageId) {
      const raw = convexRun("diet:imageUrl", JSON.stringify({ entryId: entry._id }));
      const url = raw && raw !== "null" ? JSON.parse(raw) : null;
      if (typeof url === "string") {
        imgPath = `./tmp/diet-${entry._id}.jpg`;
        mkdirSync("./tmp", { recursive: true });
        execFileSync("curl", ["-fsL", "--max-time", "30", "-o", imgPath, url], {
          stdio: ["ignore", "ignore", "pipe"],
          timeout: 45_000,
        });
        imgLine = `Read the food photo at ${process.cwd()}/${imgPath.replace("./", "")}.`;
      }
    }
    const prompt = [
      "You are a nutrition analyst. Identify the dish in the food photo and estimate the nutrition for the PORTION shown.",
      imgLine,
      entry.name ? `The user labelled it: ${entry.name}.` : "",
      entry.notes ? `User note: ${entry.notes}.` : "",
      "Use web search to deep-research typical calories/macros for the dish + portion when unsure.",
      'Output ONLY one JSON object, no prose: {"name":string,"kcal":number,"protein":number,"carbs":number,"fat":number,"notes":string}.',
      "kcal/protein/carbs/fat are numbers (grams for macros). notes = 1-2 sentence basis for the estimate.",
    ]
      .filter(Boolean)
      .join("\n");

    const result = await runActor({
      order: orderFor("default"),
      prompt,
      cwd: process.cwd(),
      env: { ...process.env, CLAUDECODE: undefined, OPENWORKS_WORKER: "1" },
      mode: "agent",
      timeoutMs: 4 * 60_000,
    });
    const m = result.stdout.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`no JSON in output: ${result.stdout.slice(0, 200)}`);
    const a = JSON.parse(m[0]);
    convexRun(
      "diet:setAnalysis",
      JSON.stringify({
        entryId: entry._id,
        name: typeof a.name === "string" ? a.name : undefined,
        kcal: typeof a.kcal === "number" ? a.kcal : undefined,
        protein: typeof a.protein === "number" ? a.protein : undefined,
        carbs: typeof a.carbs === "number" ? a.carbs : undefined,
        fat: typeof a.fat === "number" ? a.fat : undefined,
        notes: typeof a.notes === "string" ? a.notes : undefined,
      }),
    );
    console.log(`[worker] diet ${entry._id}: ${a.name} ~${a.kcal}kcal`);
  } catch (e: any) {
    convexRun("diet:recordError", JSON.stringify({ entryId: entry._id, error: String(e?.message ?? e).slice(0, 300) }));
    console.warn(`[worker] diet ${entry._id} failed: ${String(e?.message ?? e).slice(0, 160)}`);
  } finally {
    activeDiet.delete(entry._id);
    wakeQueues();
  }
}

function pollDiet() {
  const raw = convexRun("diet:getPending");
  if (!raw) return;
  try {
    const pending = JSON.parse(raw);
    const slots = MAX_WORKERS - active.size - activeDiet.size;
    for (const entry of pending.slice(0, Math.max(0, slots))) {
      if (activeDiet.has(entry._id)) continue;
      const claimed = convexRun("diet:claimEntry", JSON.stringify({ entryId: entry._id, provider: "agent" }));
      if (claimed && claimed !== "false") processDietEntry(entry);
    }
  } catch {}
}

// Vocab tab: gloss a headword in whatever language the deployment is set to.
// This used to ask for "the natural Japanese equivalent" and "a concise English
// meaning" for every card, with the hangul reading justified in the prompt by
// "the reader is Korean". Three languages nailed into a product other people
// install, and the reason an English headword arrived carrying a Japanese
// translation. The gloss language is settings.language, like every other piece
// of agent output here.
const activeVocab = new Set<string>();
async function processExpression(x: any) {
  if (activeVocab.has(x._id)) return;
  activeVocab.add(x._id);
  try {
    const native = getLanguageName();
    const prompt = [
      `Gloss the expression "${x.en}" for someone whose language is ${native}.`,
      `"meaning": what it means, written in ${native}, one line.`,
      `"example": one short sentence using it, then its ${native} translation.`,
      // The mailed study list is read away from the app, so the card carries
      // how to say the headword: IPA for precision, and an approximation in
      // the reader's own script, which is faster to read than the notation.
      `"ipa": the pronunciation in IPA, in slashes.`,
      `"ko": that same pronunciation approximated in the writing system of ${native}. Not a translation.`,
      'Output ONLY one JSON object, no prose: {"meaning":string,"example":string,"ipa":string,"ko":string}.',
    ].join("\n");
    const result = await runActor({
      order: orderFor("default"),
      prompt,
      cwd: process.cwd(),
      env: { ...process.env, CLAUDECODE: undefined, OPENWORKS_WORKER: "1" },
      mode: "agent",
      timeoutMs: 3 * 60_000,
    });
    const m = result.stdout.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no JSON");
    const a = JSON.parse(m[0]);
    convexRun(
      "expressions:setEnrichment",
      JSON.stringify({
        id: x._id,
        meaning: typeof a.meaning === "string" ? a.meaning : undefined,
        example: typeof a.example === "string" ? a.example : undefined,
        ipa: typeof a.ipa === "string" ? a.ipa : undefined,
        ko: typeof a.ko === "string" ? a.ko : undefined,
      }),
    );
    console.log(`[worker] vocab ${x._id}: ${x.en} -> ${a.meaning}`);
  } catch (e: any) {
    // Clear the flag so a failed enrich doesn't loop forever; the user can edit.
    convexRun("expressions:setEnrichment", JSON.stringify({ id: x._id }));
    console.warn(`[worker] vocab ${x._id} enrich failed: ${String(e?.message ?? e).slice(0, 140)}`);
  } finally {
    activeVocab.delete(x._id);
    wakeQueues();
  }
}

function pollVocab() {
  const raw = convexRun("expressions:getPendingEnrich");
  if (!raw) return;
  try {
    const pending = JSON.parse(raw);
    const slots = MAX_WORKERS - active.size - activeDiet.size - activeVocab.size - activeInsights.size;
    for (const x of pending.slice(0, Math.max(0, slots))) {
      if (activeVocab.has(x._id)) continue;
      processExpression(x);
    }
  } catch {}
}

// Paper tab "Related research": for a paper whose summary is embedded, a loose
// vector prefilter recalls candidate research projects and the CLI agent judges
// which the paper is genuinely worth referencing in (no forced links). Accepted
// ones are written as paperLinks rows; an empty result still marks the summary
// processed so it is not retried.
const activePaperLinks = new Set<string>();
async function processPaperLinks(item: {
  summaryId: string;
  jobId: string;
  title: string;
  summary: string;
  url: string;
}) {
  if (activePaperLinks.has(item.summaryId)) return;
  activePaperLinks.add(item.summaryId);
  try {
    const candidates =
      ((await convexFetch("paperLinks:candidatesForSummary", { summaryId: item.summaryId })) as
        { researchId: string; slug: string; title: string; score: number }[] | null) ?? [];
    if (candidates.length === 0) {
      await convexFetch("paperLinks:writeLinks", { summaryId: item.summaryId, jobId: item.jobId, links: [] });
      return;
    }
    const prompt = [
      "Decide which of the reader's ongoing research projects a paper is genuinely worth referencing in. Do NOT force a link: include a project only if this paper would plausibly be cited by or directly inform that project's work. Returning an empty list is correct and expected when nothing fits.",
      `PAPER title: ${item.title}`,
      `PAPER summary: ${item.summary.slice(0, 1500)}`,
      "CANDIDATE PROJECTS (slug — title):",
      ...candidates.map((c) => `- ${c.slug} — ${c.title}`),
      'Output ONLY a JSON array, no prose. Each element: {"slug":"<one candidate slug>","reason":"<one sentence: why this paper is worth referencing in that project>"}. Include only genuinely relevant projects; output [] if none.',
    ].join("\n");
    const result = await runActor({
      order: orderFor("default"),
      prompt,
      cwd: process.cwd(),
      env: { ...process.env, CLAUDECODE: undefined, OPENWORKS_WORKER: "1" },
      mode: "agent",
      timeoutMs: 3 * 60_000,
    });
    const m = result.stdout.match(/\[[\s\S]*\]/);
    const picks: { slug: string; reason: string }[] = m ? JSON.parse(m[0]) : [];
    const bySlug = new Map(candidates.map((c) => [c.slug, c]));
    const links = picks
      .filter((p) => p && typeof p.slug === "string" && bySlug.has(p.slug))
      .map((p) => {
        const c = bySlug.get(p.slug)!;
        return {
          researchId: c.researchId,
          researchSlug: c.slug,
          researchTitle: c.title,
          score: c.score,
          reason: String(p.reason ?? "").slice(0, 400),
        };
      });
    await convexFetch("paperLinks:writeLinks", { summaryId: item.summaryId, jobId: item.jobId, links });
    console.log(`[worker] paperLinks ${item.summaryId}: ${links.length}/${candidates.length} linked`);
  } catch (e: any) {
    try {
      await convexFetch("paperLinks:writeLinks", { summaryId: item.summaryId, jobId: item.jobId, links: [] });
    } catch {}
    console.warn(`[worker] paperLinks ${item.summaryId} failed: ${String(e?.message ?? e).slice(0, 140)}`);
  } finally {
    activePaperLinks.delete(item.summaryId);
    wakeQueues();
  }
}

let paperLinksRunning = false;
async function pollPaperLinks() {
  if (paperLinksRunning) return;
  const freeSlots =
    MAX_WORKERS - active.size - activeDiet.size - activeVocab.size - activePaperLinks.size - activeInsights.size;
  if (freeSlots <= 0) return;
  paperLinksRunning = true;
  try {
    const items = (await convexFetch("paperLinks:pendingForLinks", { limit: 1 })) as
      { summaryId: string; jobId: string; title: string; summary: string; url: string }[] | null;
    for (const it of items ?? []) {
      if (!activePaperLinks.has(it.summaryId)) await processPaperLinks(it);
    }
  } catch (e: any) {
    console.warn(`[worker] pollPaperLinks: ${String(e?.message ?? e).slice(0, 120)}`);
  } finally {
    paperLinksRunning = false;
  }
}

// Insights tab: enrich one collected quote/insight and pick its single best
// Notion page. Preserves the original text verbatim (image rows have their
// text extracted from the screenshot first). Mirrors pollPaperLinks.
//
// Naming one page narrows the search to the part of the workspace that holds
// notes. Left unset the agent searches everything, and the larger the
// workspace the worse the page it settles on.
const NOTION_INSIGHTS_ROOT = process.env.NOTION_INSIGHTS_ROOT;
const activeInsights = new Set<string>();
async function processInsight(row: { _id: string; text?: string; imageId?: string }) {
  if (activeInsights.has(row._id)) return;
  activeInsights.add(row._id);
  try {
    const hadText = Boolean(row.text && row.text.trim());
    let imgLine = "";
    if (row.imageId) {
      const url = (await convexFetch("insights:imageUrl", { id: row._id })) as string | null;
      if (typeof url === "string") {
        mkdirSync("./tmp", { recursive: true });
        const imgPath = `./tmp/insight-${row._id}.png`;
        execFileSync("curl", ["-fsL", "--max-time", "30", "-o", imgPath, url], {
          stdio: ["ignore", "ignore", "pipe"],
          timeout: 45_000,
        });
        imgLine = `The insight was pasted as a SCREENSHOT at ${process.cwd()}/${imgPath.replace("./", "")}. Read/view that image FIRST and extract the exact quote text from it (verbatim).`;
      }
    }
    const prompt = [
      "You are filing a single short insight/quote (a few sentences, at most one paragraph) into the reader's Notion knowledge base.",
      "Preserve the ORIGINAL text verbatim; only fix obvious grammar/spacing. Do not paraphrase or expand it.",
      hadText ? `INSIGHT: ${row.text}` : "",
      imgLine,
      "Tasks:",
      "1. Return the insight text: the original VERBATIM, or with ONLY grammar/spelling/spacing fixed (extracted verbatim from the image if one was given). Never paraphrase, translate, summarize, or restyle it.",
      "2. Infer author/source if recognizable (else leave empty).",
      "3. Write a short interpretation (what it means, how it connects).",
      "4. Write a short evaluation (a critical judgment, paper-review tone).",
      "5. Produce 2-5 lowercase tags.",
      `6. Use notion-search ${NOTION_INSIGHTS_ROOT ? `under the root page (page_url id ${NOTION_INSIGHTS_ROOT})` : "across the workspace"} to find the SINGLE best page to file this quote. notion-fetch that page, note how existing quote blocks there are formatted, and produce the exact markdown to insert. Default format is a Notion quote line then an attribution line:`,
      "   > <the quote text>",
      "   — <author, source>",
      "   Adapt to the page's own convention if it differs. Capture 2-3 real surrounding blocks (verbatim markdown) as contextBefore/After around the insertion point. If NO page genuinely fits, set notionPageId to null and explain why in notionReason.",
      'Output ONLY a JSON object, no prose: {"text":"","source":"","interpretation":"","evaluation":"","tags":[],"notionPageId":"","notionPageName":"","notionPageUrl":"","notionContent":"","notionContextBefore":"","notionContextAfter":"","notionReason":""}. Use empty string / null where unknown.',
    ]
      .filter(Boolean)
      .join("\n");
    const result = await runActor({
      order: orderFor("insight"),
      prompt,
      cwd: process.cwd(),
      env: { ...process.env, CLAUDECODE: undefined, OPENWORKS_WORKER: "1" },
      mode: "agent",
      timeoutMs: 4 * 60_000,
    });
    const m = result.stdout.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no JSON in agent output");
    const j = JSON.parse(m[0]);
    await convexFetch("insights:completeEnrich", {
      id: row._id,
      // Always forward the agent's text; the server only accepts it when it is
      // within typo/grammar edit distance of the current title (or the row was
      // an empty image row), so a paraphrase can never replace the original.
      text: typeof j.text === "string" && j.text.trim() ? j.text.trim() : undefined,
      source: j.source || undefined,
      interpretation: j.interpretation || undefined,
      evaluation: j.evaluation || undefined,
      tags: Array.isArray(j.tags) ? j.tags.slice(0, 8).map(String) : undefined,
      provider: result.provider,
      notionPageId: j.notionPageId || undefined,
      notionPageName: j.notionPageName || undefined,
      notionPageUrl: j.notionPageUrl || undefined,
      notionContent: j.notionContent || undefined,
      notionContextBefore: j.notionContextBefore || undefined,
      notionContextAfter: j.notionContextAfter || undefined,
      notionReason: j.notionReason || undefined,
    });
    console.log(`[worker] insight ${row._id} enriched -> ${j.notionPageName || "no page"}`);
  } catch (e: any) {
    try {
      await convexFetch("insights:setError", { id: row._id, error: String(e?.message ?? e) });
    } catch {}
    console.warn(`[worker] insight ${row._id} failed: ${String(e?.message ?? e).slice(0, 140)}`);
  } finally {
    activeInsights.delete(row._id);
    wakeQueues();
  }
}

let insightsRunning = false;
async function pollInsights() {
  if (insightsRunning) return;
  const free =
    MAX_WORKERS - active.size - activeDiet.size - activeVocab.size - activePaperLinks.size - activeInsights.size;
  if (free <= 0) return;
  insightsRunning = true;
  try {
    const rows = (await convexFetch("insights:listNew", {})) as any[] | null;
    for (const r of (rows ?? []).slice(0, free)) {
      if (!activeInsights.has(r._id)) processInsight(r);
    }
  } catch (e: any) {
    console.warn(`[worker] pollInsights: ${String(e?.message ?? e).slice(0, 120)}`);
  } finally {
    insightsRunning = false;
  }
}

// High-bar auto-harvest: pull only genuinely core insights out of a done
// newsletter/paper job's summaries (usually zero). Each job scanned once.
let harvestRunning = false;
async function pollInsightHarvest() {
  if (harvestRunning) return;
  const free =
    MAX_WORKERS - active.size - activeDiet.size - activeVocab.size - activePaperLinks.size - activeInsights.size;
  if (free <= 0) return;
  harvestRunning = true;
  try {
    const jobs = (await convexFetch("insights:listHarvestable", { limit: 1 })) as
      { jobId: string; type: string }[] | null;
    for (const job of jobs ?? []) {
      try {
        const summaries = ((await convexFetch("summaries:listByJob", { jobId: job.jobId })) as any[] | null) ?? [];
        const digest = summaries
          .map((s: any) => `- ${s.title ?? ""}: ${(s.summary ?? "").slice(0, 400)}${s.url ? ` (${s.url})` : ""}`)
          .join("\n")
          .slice(0, 6000);
        const prompt = [
          "Extract ONLY genuinely exceptional, quotable, standalone insights from the items below.",
          "The expected default is an EMPTY list. Include at most 2, and only if the sentence is a sharp, reusable idea worth filing forever (not a routine fact or news blurb).",
          "Each insight must be short: a few sentences, at most one paragraph. Never return a multi-paragraph blob.",
          "Preserve wording; do not invent. Provide the source name and its URL when available.",
          "ITEMS:",
          digest,
          'Output ONLY a JSON array, no prose: [{"text":"","source":"","sourceUrl":""}]. Output [] if nothing qualifies.',
        ].join("\n");
        const result = await runActor({
          order: orderFor("insight"),
          prompt,
          cwd: process.cwd(),
          env: { ...process.env, CLAUDECODE: undefined, OPENWORKS_WORKER: "1" },
          mode: "agent",
          timeoutMs: 3 * 60_000,
        });
        const mm = result.stdout.match(/\[[\s\S]*\]/);
        const items = mm ? JSON.parse(mm[0]) : [];
        const clean = (Array.isArray(items) ? items : [])
          .filter((it: any) => it && typeof it.text === "string" && it.text.trim())
          .slice(0, 2)
          .map((it: any) => ({
            text: String(it.text).trim(),
            source: it.source ? String(it.source) : undefined,
            sourceUrl: it.sourceUrl ? String(it.sourceUrl) : undefined,
          }));
        if (clean.length) {
          await convexFetch("insights:addHarvested", { jobId: job.jobId, origin: job.type, items: clean });
        }
        console.log(`[worker] harvested job ${job.jobId}: ${clean.length} insight(s)`);
      } finally {
        await convexFetch("insights:markHarvested", { jobId: job.jobId });
      }
    }
  } catch (e: any) {
    console.warn(`[worker] pollInsightHarvest: ${String(e?.message ?? e).slice(0, 120)}`);
  } finally {
    harvestRunning = false;
  }
}

// The three used to share one 3s tick. They are split because each reacts to
// a different thing: jobs and chats arrive as a change a subscription can push,
// while the unstick sweep only tests a 30-minute-old timestamp and so has
// nothing to be pushed about.
function pollJobs() {
  const raw = convexRun("jobs:getAllPending");
  if (raw) {
    try {
      const pending = JSON.parse(raw);
      if (pending.length) {
        const slots = MAX_WORKERS - active.size;
        if (slots > 0) {
          for (const job of pending.slice(0, slots)) {
            if (active.has(job._id)) continue;
            // Atomically claim the job before processing. claimJob returns
            // the FULL job document (incl. `content`) which getAllPending
            // strips for bandwidth — we MUST use this fuller record when
            // building the agent prompt, otherwise paste-mode papers go
            // through with no content and the agent ends up summarizing
            // whatever it can find nearby (this was the cause of the
            // mismatched-summary bug).
            const claimedRaw = convexRun("jobs:claimJob", JSON.stringify({ jobId: job._id }));
            if (!claimedRaw || claimedRaw === "null") continue;
            let fullJob = job;
            try {
              const parsed = JSON.parse(claimedRaw);
              if (parsed && parsed._id) fullJob = parsed;
            } catch {}
            processJob(fullJob);
          }
        }
      }
    } catch {}
  }
}

// Unstick jobs stuck in summarizing/suggesting for 30+ min. getProcessable
// collects every pending, summarizing and suggesting row, so it is the most
// expensive query the worker issues; on the old 3s tick it ran 28,800 times a
// day to test a threshold that can only come true once every 30 minutes.
function pollStuck() {
  const stuckRaw = convexRun("jobs:getProcessable");
  if (stuckRaw) {
    try {
      const stuck = JSON.parse(stuckRaw);
      const now = Date.now();
      for (const job of stuck) {
        if (job.status !== "pending" && !active.has(job._id) && now - job.createdAt > 30 * 60_000) {
          console.log(
            `[worker] unstick ${job._id} (${job.status} for ${Math.round((now - job.createdAt) / 60000)}min)`,
          );
          convexRun("jobs:updateStatus", JSON.stringify({ jobId: job._id, status: "pending" }));
        }
      }
    } catch {}
  }
}

function pollChats() {
  const chatRaw = convexRun("chats:getPending");
  if (chatRaw) {
    try {
      const pendingChats = JSON.parse(chatRaw);
      for (const entry of pendingChats) {
        if (active.size >= MAX_WORKERS) break;
        answerChat(entry);
      }
    } catch {}
  }
}

// ── Setup queue (install + verify CLIs for plug-n-play) ─────────────────

type SetupKind = "install_gh" | "verify_gh" | "oauth_gh" | "install_gws" | "verify_gws";

// gh's public OAuth client_id — same one the official gh CLI uses for its
// own device-code login. Public per github.com/cli/cli source. Scopes match
// what `gh auth login -s` configures by default.
const GH_OAUTH_CLIENT_ID = "178c6fc6a68a2e6e3a13";
const GH_OAUTH_SCOPES = "repo,read:org,gist,workflow";

function detectPlatform(): "darwin" | "linux" | "win32" | "other" {
  const p = process.platform;
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  return "other";
}

function execCapture(cmd: string, args: string[], timeoutMs: number): { code: number; stdout: string; stderr: string } {
  try {
    const out = execFileSync(cmd, args, { timeout: timeoutMs, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return { code: 0, stdout: out, stderr: "" };
  } catch (e: any) {
    return {
      code: typeof e.status === "number" ? e.status : 1,
      stdout: typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString?.() ?? ""),
      stderr: typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString?.() ?? String(e.message ?? "")),
    };
  }
}

function tailLog(s: string, n = 4000): string {
  if (s.length <= n) return s;
  return "…" + s.slice(s.length - n);
}

async function runSetup(
  kind: SetupKind,
): Promise<{ result: Record<string, unknown>; stdout: string; ok: boolean; error?: string }> {
  const plat = detectPlatform();
  let stdoutBuf = "";
  const collect = (label: string, r: { code: number; stdout: string; stderr: string }) => {
    stdoutBuf += `── ${label} (exit ${r.code}) ──\n${r.stdout}${r.stderr ? "\n[stderr] " + r.stderr : ""}\n`;
    return r;
  };

  if (kind === "install_gh") {
    if (plat === "darwin") {
      const r = collect("brew install gh", execCapture("brew", ["install", "gh"], 5 * 60_000));
      return {
        result: { platform: plat, installed: r.code === 0 },
        stdout: stdoutBuf,
        ok: r.code === 0,
        error: r.code === 0 ? undefined : "brew failed",
      };
    }
    if (plat === "linux") {
      for (const cmd of [
        ["apt-get", ["install", "-y", "gh"]],
        ["dnf", ["install", "-y", "gh"]],
        ["pacman", ["-S", "--noconfirm", "github-cli"]],
      ] as [string, string[]][]) {
        const r = collect(`${cmd[0]} ${cmd[1].join(" ")}`, execCapture(cmd[0], cmd[1], 5 * 60_000));
        if (r.code === 0)
          return { result: { platform: plat, installed: true, via: cmd[0] }, stdout: stdoutBuf, ok: true };
      }
      return {
        result: { platform: plat, installed: false },
        stdout: stdoutBuf,
        ok: false,
        error: "no package manager succeeded; install gh manually",
      };
    }
    if (plat === "win32") {
      const r = collect(
        "winget install GitHub.cli",
        execCapture("winget", ["install", "--id", "GitHub.cli", "--silent"], 5 * 60_000),
      );
      return {
        result: { platform: plat, installed: r.code === 0 },
        stdout: stdoutBuf,
        ok: r.code === 0,
        error: r.code === 0 ? undefined : "winget failed",
      };
    }
    return { result: { platform: plat }, stdout: stdoutBuf, ok: false, error: `unsupported platform ${plat}` };
  }

  if (kind === "verify_gh") {
    const version = collect("gh --version", execCapture("gh", ["--version"], 10_000));
    if (version.code !== 0) {
      return { result: { installed: false }, stdout: stdoutBuf, ok: true };
    }
    const status = collect("gh auth status", execCapture("gh", ["auth", "status"], 10_000));
    const loggedIn = status.code === 0;
    let username: string | undefined;
    if (loggedIn) {
      const who = collect("gh api user", execCapture("gh", ["api", "user", "--jq", ".login"], 10_000));
      if (who.code === 0) username = who.stdout.trim();
    }
    return {
      result: { installed: true, version: version.stdout.split("\n")[0], loggedIn, username },
      stdout: stdoutBuf,
      ok: true,
    };
  }

  if (kind === "install_gws") {
    // gws ships as @googleworkspace/cli on npm — works on every platform
    // that has node. Prefer pnpm if available (often already on PATH), fall
    // back to npm. No package manager → user has to install node themselves.
    const pkg = "@googleworkspace/cli";
    const pmCandidates: [string, string[]][] = [
      ["pnpm", ["add", "-g", pkg]],
      ["npm", ["install", "-g", pkg]],
    ];
    let installed = false;
    let via: string | undefined;
    for (const [cmd, args] of pmCandidates) {
      const r = collect(`${cmd} ${args.join(" ")}`, execCapture(cmd, args, 5 * 60_000));
      if (r.code === 0) {
        installed = true;
        via = cmd;
        break;
      }
    }
    return {
      result: { platform: plat, installed, via, pkg },
      stdout: stdoutBuf,
      ok: installed,
      error: installed ? undefined : "no package manager succeeded; install node + pnpm/npm first",
    };
  }

  if (kind === "verify_gws") {
    const version = collect("gws --version", execCapture("gws", ["--version"], 10_000));
    if (version.code !== 0) {
      return { result: { installed: false }, stdout: stdoutBuf, ok: true };
    }
    const profile = collect(
      "gws gmail getProfile",
      execCapture("gws", ["gmail", "users", "getProfile", "--params", '{"userId":"me"}', "--format", "json"], 15_000),
    );
    const loggedIn = profile.code === 0;
    let account: string | undefined;
    if (loggedIn) {
      try {
        const p = JSON.parse(profile.stdout);
        account = p.emailAddress;
      } catch {}
    }
    return {
      result: { installed: true, version: version.stdout.split("\n")[0], loggedIn, account },
      stdout: stdoutBuf,
      ok: true,
    };
  }

  return { result: {}, stdout: stdoutBuf, ok: false, error: "unknown kind" };
}

async function runOauthGh(
  reqId: string,
): Promise<{ result: Record<string, unknown>; stdout: string; ok: boolean; error?: string }> {
  // 1. Request a device code from github.com
  const deviceRes = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: GH_OAUTH_CLIENT_ID, scope: GH_OAUTH_SCOPES }),
  });
  if (!deviceRes.ok) {
    return { result: {}, stdout: "", ok: false, error: `device-code request failed (${deviceRes.status})` };
  }
  const device = (await deviceRes.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };
  // 2. Stream the user-facing details back through Convex so the UI can
  //    render them while we poll. Status stays "running".
  convexRun(
    "setup:setProgress",
    JSON.stringify({
      id: reqId,
      result: JSON.stringify({
        stage: "device_code",
        userCode: device.user_code,
        verificationUri: device.verification_uri,
        expiresIn: device.expires_in,
      }),
      stdout: `Open ${device.verification_uri} and enter code ${device.user_code}\n`,
    }),
  );
  console.log(`[oauth_gh] device code ${device.user_code} @ ${device.verification_uri}`);

  // 3. Poll for the access token. github recommends >= interval seconds.
  const deadline = Date.now() + Math.min(device.expires_in, 600) * 1000;
  const intervalMs = Math.max(device.interval, 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GH_OAUTH_CLIENT_ID,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    if (!tokenRes.ok) continue;
    const t = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (t.access_token) {
      // 4. Hand the token to gh so future `gh` invocations are authed.
      try {
        execFileSync("gh", ["auth", "login", "--with-token", "--hostname", "github.com"], {
          input: t.access_token,
          timeout: 15_000,
        });
      } catch (e: any) {
        return {
          result: { stage: "complete", loggedIn: false },
          stdout: `gh auth login --with-token failed: ${String(e?.message ?? e).slice(0, 200)}`,
          ok: false,
          error: "gh auth login --with-token failed",
        };
      }
      // 5. Verify so badge flips green immediately.
      let username: string | undefined;
      try {
        username = execFileSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8", timeout: 10_000 }).trim();
      } catch {}
      return {
        result: { stage: "complete", loggedIn: true, username },
        stdout: "OAuth complete\n",
        ok: true,
      };
    }
    if (t.error && t.error !== "authorization_pending" && t.error !== "slow_down") {
      return { result: { stage: "complete", loggedIn: false }, stdout: "", ok: false, error: t.error };
    }
  }
  return {
    result: { stage: "complete", loggedIn: false },
    stdout: "",
    ok: false,
    error: "device-code expired before auth completed",
  };
}

let setupRunning = false;

// `pendingKnown` is set when a subscription already delivered a non-empty
// queue, which makes the listing below redundant and saves a round trip on the
// path a human is waiting out.
async function handleSetup(pendingKnown = false) {
  if (setupRunning) return;
  // Ask before claiming. `claim` is a mutation, so using it to discover
  // whether there is anything to do opened an empty write transaction on
  // every tick — the only uncacheable call in the worker's idle traffic. The
  // listing is a query, so Convex caches it and a subscription can push it.
  // This is advisory only: `claim` is still the atomic step, so two machines
  // seeing the same row here still ends with exactly one of them running it.
  if (!pendingKnown) {
    const pendingRaw = convexRun("setup:listByStatus", JSON.stringify({ status: "pending" }));
    if (!pendingRaw) return;
    try {
      if ((JSON.parse(pendingRaw) as unknown[]).length === 0) return;
    } catch {
      return;
    }
  }
  const raw = convexRun("setup:claim");
  if (!raw || raw === "null") return;
  let req: { _id: string; kind: SetupKind } | null = null;
  try {
    req = JSON.parse(raw);
  } catch {
    return;
  }
  if (!req) return;
  setupRunning = true;
  try {
    console.log(`[setup] running ${req.kind} (${req._id})`);
    const r = req.kind === "oauth_gh" ? await runOauthGh(req._id) : await runSetup(req.kind);
    convexRun(
      "setup:complete",
      JSON.stringify({
        id: req._id,
        status: r.ok ? "done" : "error",
        result: JSON.stringify(r.result),
        stdout: tailLog(r.stdout),
        error: r.error,
      }),
    );
    console.log(`[setup] ${req.kind} ${r.ok ? "done" : "error"}`);
  } catch (e: any) {
    convexRun(
      "setup:complete",
      JSON.stringify({
        id: req._id,
        status: "error",
        error: String(e?.message ?? e),
      }),
    );
  } finally {
    setupRunning = false;
  }
}

async function handleMailbox() {
  const raw = convexRun("mailbox:getPendingRequest");
  if (!raw || raw === "null") return;
  let req;
  try {
    req = JSON.parse(raw);
  } catch {
    return;
  }
  if (!req) return;
  const claimed = convexRun("mailbox:claimRequest", JSON.stringify({ id: req._id }));
  if (!claimed || claimed === "null") return;

  if (req.kind === "list") {
    const q =
      req.query || "is:unread (from:news@alphasignal.ai OR from:dan@tldrnewsletter.com OR alphaxiv OR alphasignal)";
    try {
      const t0 = Date.now();
      const params = JSON.stringify({ userId: "me", q, maxResults: 50 });
      const listOut = execFileSync(
        "gws",
        ["gmail", "users", "messages", "list", "--params", params, "--format", "json"],
        {
          timeout: 30_000,
          encoding: "utf8",
        },
      );
      const list = JSON.parse(listOut);
      const ids = (list.messages || []).map((m: { id: string }) => m.id) as string[];
      // Was: one execFileSync per id sequentially — N gws spawns back-to-back
      // ran 5–20s for 5–10 unread. Now we kick all gets off in parallel via
      // execFile + Promise.all. gws spawn cost is the real bottleneck so any
      // overlap helps; gmail API itself handles concurrent reads fine.
      const getOne = (id: string) =>
        new Promise<{ id: string; from: string; subject: string; date: string }>((resolve) => {
          execFile(
            "gws",
            [
              "gmail",
              "users",
              "messages",
              "get",
              "--params",
              JSON.stringify({ userId: "me", id, format: "metadata" }),
              "--format",
              "json",
            ],
            { timeout: 10_000, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
            (err, stdout) => {
              if (err) {
                resolve({ id, from: "", subject: `(fetch failed: ${err.message.slice(0, 60)})`, date: "" });
                return;
              }
              try {
                const md = JSON.parse(stdout) as { payload?: { headers?: { name: string; value: string }[] } };
                const hdrs = Object.fromEntries((md.payload?.headers ?? []).map((h) => [h.name, h.value]));
                resolve({ id, from: hdrs.From ?? "", subject: hdrs.Subject ?? "", date: hdrs.Date ?? "" });
              } catch (e) {
                resolve({ id, from: "", subject: `(parse failed: ${(e as Error).message?.slice(0, 60)})`, date: "" });
              }
            },
          );
        });
      const entries = await Promise.all(ids.map(getOne));
      convexRun(
        "mailbox:completeRequest",
        JSON.stringify({ id: req._id, status: "done", result: JSON.stringify(entries) }),
      );
      console.log(`[mailbox] list → ${entries.length} entries (${Date.now() - t0}ms)`);
    } catch (e) {
      convexRun(
        "mailbox:completeRequest",
        JSON.stringify({ id: req._id, status: "error", error: String(e).slice(0, 500) }),
      );
      console.error(`[mailbox] list failed: ${(e as Error).message}`);
    }
  } else if (req.kind === "markRead" && req.emailId) {
    try {
      execFileSync(
        "gws",
        [
          "gmail",
          "users",
          "messages",
          "batchModify",
          "--json",
          JSON.stringify({ ids: [req.emailId], removeLabelIds: ["UNREAD"] }),
          "--params",
          JSON.stringify({ userId: "me" }),
        ],
        { timeout: 15_000, encoding: "utf8" },
      );
      convexRun("mailbox:completeRequest", JSON.stringify({ id: req._id, status: "done" }));
      console.log(`[mailbox] markRead ${req.emailId}`);
    } catch (e) {
      convexRun(
        "mailbox:completeRequest",
        JSON.stringify({ id: req._id, status: "error", error: String(e).slice(0, 500) }),
      );
    }
  }
}

// ── Calendar sync (outlook → planItems via mgc + planner agent) ─────────

const MGC_BIN = `${process.env.HOME}/.local/msgraph-cli/mgc`;
// User's primary outlook calendar may not be the default Microsoft Graph
// calendar (the one tied to the gmail-linked Microsoft account). Set
// OUTLOOK_CALENDAR_ID in .env.local to the calendar that actually holds
// the events to sync. When unset we fall back to `me calendar-view`
// (default), so an unconfigured environment still works without errors.
const OUTLOOK_CALENDAR_ID = process.env.OUTLOOK_CALENDAR_ID;
// Additional outlook calendars merged into the same sync, comma-separated.
// Events from all listed calendars are concatenated before the recurring-event
// filter and planner pass.
const OUTLOOK_EXTRA_CALENDAR_IDS = (process.env.OUTLOOK_EXTRA_CALENDAR_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

async function handleCalendar() {
  const raw = convexRun("calendar:getPendingRequest");
  if (!raw || raw === "null") return;
  let req;
  try {
    req = JSON.parse(raw);
  } catch {
    return;
  }
  if (!req || req.kind !== "syncDay") return;
  const claimed = convexRun("calendar:claimRequest", JSON.stringify({ id: req._id }));
  if (!claimed || claimed === "null") return;

  const { planSlug, date } = req as { planSlug: string; date: string };
  try {
    const start = `${date}T00:00:00Z`;
    const end = `${date}T23:59:59Z`;
    // Fetch one calendar's events as an array. Throws on mgc failure; caller
    // collects errors per calendar so a single bad ID doesn't fail the day.
    const fetchCal = (calId: string | null): Array<Record<string, unknown>> => {
      const args = calId
        ? [
            "me",
            "calendars",
            "calendar-view",
            "list",
            "--calendar-id",
            calId,
            "--start-date-time",
            start,
            "--end-date-time",
            end,
            "--top",
            "50",
            "--select",
            "id,subject,start,end,location,bodyPreview,categories,showAs,isAllDay,organizer,type,seriesMasterId",
          ]
        : [
            "me",
            "calendar-view",
            "list",
            "--start-date-time",
            start,
            "--end-date-time",
            end,
            "--top",
            "50",
            "--select",
            "id,subject,start,end,location,bodyPreview,categories,showAs,isAllDay,organizer,type,seriesMasterId",
            "--orderby",
            "start/dateTime",
          ];
      const out = execFileSync(MGC_BIN, args, { timeout: 30_000, encoding: "utf8" });
      return (JSON.parse(out).value || []) as Array<Record<string, unknown>>;
    };
    // Merge primary + extras. mgc returns event.id as a globally unique
    // identifier so cross-calendar dedupe via Set<id> is safe.
    const allCalIds = OUTLOOK_CALENDAR_ID
      ? [OUTLOOK_CALENDAR_ID, ...OUTLOOK_EXTRA_CALENDAR_IDS]
      : [null, ...OUTLOOK_EXTRA_CALENDAR_IDS.map((id) => id as string)];
    const rawEvents: Array<Record<string, unknown>> = [];
    const seenIds = new Set<string>();
    for (const cid of allCalIds) {
      try {
        for (const e of fetchCal(cid)) {
          const eid = (e as { id?: string }).id;
          if (eid && seenIds.has(eid)) continue;
          if (eid) seenIds.add(eid);
          rawEvents.push(e);
        }
      } catch (err) {
        console.error(
          `[calendar] ${planSlug}/${date} cal=${(cid ?? "default").slice(0, 16)}... fetch failed: ${(err as Error).message}`,
        );
      }
    }
    // Drop everything from a recurring series — both `occurrence` instances
    // and the `seriesMaster` template. Only one-off events (singleInstance)
    // and modified-instance overrides (exception) ever become plan items.
    // Recurring routines are noise on every day and are explicitly excluded
    // by user request, even if it means a day has zero items.
    const events = rawEvents.filter((e) => {
      const t = (e as { type?: string }).type;
      return t === undefined || t === "singleInstance" || t === "exception";
    });
    if (events.length === 0) {
      convexRun(
        "calendar:completeRequest",
        JSON.stringify({ id: req._id, status: "done", result: JSON.stringify({ events: 0, items: 0 }) }),
      );
      console.log(`[calendar] ${planSlug}/${date}: 0 events`);
      return;
    }

    // Ask planner agent (codex then antigravity then claude) to convert outlook events
    // into planItem JSON. We only consume stdout JSON — no MCP, no side
    // effects from the agent itself.
    const prompt = [
      `You are a planner. Convert these outlook calendar events for date ${date} into a JSON array of plan items.`,
      `Output ONLY valid JSON, no prose, no markdown fences.`,
      `Each item: {"title": string, "kind": "event"|"todo", "time": "HH:MM"|null, "timeStart": "HH:MM"|null, "timeEnd": "HH:MM"|null, "location": string|null, "notes": string|null, "tier": 0..3, "tags": string[], "calendarEventId": string}.`,
      `tier guide: 0=own commitment, 1=must attend, 2=high value, 3=optional background. Default to 2 unless clearly otherwise.`,
      `IMPORTANT: any event with type="occurrence" (instance of a recurring series, e.g. daily routines like vitamins, brushing teeth, showering) MUST be tier 3 — never 0/1/2. They're background routines, not picks.`,
      `Use event.id as calendarEventId verbatim.`,
      `If isAllDay, set time/timeStart/timeEnd to null. Otherwise extract HH:MM from start.dateTime / end.dateTime.`,
      `Skip declined / cancelled / showAs="free" events.`,
      `Events:`,
      JSON.stringify(events),
    ].join("\n");

    const result = await runActor({
      order: orderFor("default"),
      prompt,
      cwd: "/tmp",
      env: { ...process.env, CLAUDECODE: undefined, OPENWORKS_WORKER: "1" },
      mode: "agent",
      timeoutMs: 5 * 60_000,
    });

    // Extract JSON array from stdout (some CLIs wrap output).
    const m = result.stdout.match(/\[[\s\S]*\]/);
    if (!m) throw new Error(`planner output had no JSON array: ${result.stdout.slice(0, 200)}`);
    const items = JSON.parse(m[0]) as Array<Record<string, unknown>>;

    // Strip null fields — the planner prompt allows nulls for optional times,
    // but Convex's v.optional(v.string()) rejects null. Drop any key whose
    // value is null/undefined before sending. Also default tags to [].
    // Force tier=3 for any item whose source outlook event was a recurring
    // occurrence — the agent is told to do this but isn't always reliable,
    // and we don't want a daily vitamins routine showing up as a starred pick.
    const occurrenceIds = new Set(
      events.filter((e) => (e as { type?: string }).type === "occurrence").map((e) => (e as { id: string }).id),
    );
    const cleaned = items.map((it) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(it)) {
        if (v === null || v === undefined) continue;
        out[k] = v;
      }
      if (!Array.isArray(out.tags)) out.tags = [];
      const evId = typeof out.calendarEventId === "string" ? out.calendarEventId : undefined;
      if (evId && occurrenceIds.has(evId)) out.tier = 3;
      return out;
    });

    const upsertOut = convexRun("calendar:upsertItemsFromCalendar", JSON.stringify({ planSlug, date, items: cleaned }));
    convexRun(
      "calendar:completeRequest",
      JSON.stringify({
        id: req._id,
        status: "done",
        result: JSON.stringify({ events: events.length, items: items.length, upsert: upsertOut }),
      }),
    );
    console.log(`[calendar] ${planSlug}/${date}: ${events.length} events → ${items.length} items (${result.provider})`);
  } catch (e) {
    convexRun(
      "calendar:completeRequest",
      JSON.stringify({ id: req._id, status: "error", error: String((e as Error).message ?? e).slice(0, 500) }),
    );
    console.error(`[calendar] ${planSlug}/${date} failed: ${(e as Error).message}`);
  }
}

// ── Citations: bib sync + citation→paper promote (PDF text extraction) ──

import * as os from "os";
import { existsSync, readdirSync } from "fs";
import { resolve as resolvePath } from "path";

const MACHINE_ID = process.env.OPENWORKS_MACHINE_ID || os.hostname();

type BibEntry = { type: string; key: string; fields: Record<string, string> };

// Minimal-but-effective bibtex parser — covers @article{key, field={value}, ...}
// shape with single-level brace nesting (the common case for references.bib).
function parseBib(text: string): BibEntry[] {
  const entries: BibEntry[] = [];
  const entryRe = /@(\w+)\s*\{\s*([^,\s]+)\s*,([^@]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(text)) !== null) {
    const type = m[1].toLowerCase();
    const key = m[2];
    const body = m[3];
    const fields: Record<string, string> = {};
    const fieldRe = /(\w+)\s*=\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;
    let f: RegExpExecArray | null;
    while ((f = fieldRe.exec(body)) !== null) {
      fields[f[1].toLowerCase()] = f[2].trim();
    }
    entries.push({ type, key, fields });
  }
  return entries;
}

function extractAuthors(field: string | undefined): string[] {
  if (!field) return [];
  return field
    .split(/\s+and\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Jabref/Zotero "file" field shape: "title:relative/path.pdf:PDF" or
// "relative/path.pdf" or ":relative/path.pdf:". Pull out the path.
function extractPdfPath(field: string | undefined): string | undefined {
  if (!field) return undefined;
  const parts = field.split(";")[0].split(":");
  const candidate = parts.find((p) => p.toLowerCase().endsWith(".pdf"));
  return candidate?.trim();
}

function extractArxiv(fields: Record<string, string>): string | undefined {
  const eprint = fields.eprint || fields.archiveprefix;
  if (eprint && /^\d{4}\.\d{4,5}(v\d+)?$/.test(eprint.trim())) return eprint.trim();
  const url = fields.url || "";
  const m = url.match(/arxiv\.org\/abs\/(\d{4}\.\d{4,5})/i);
  return m?.[1];
}

function hostForCurrent(hosts: Array<{ machineId: string; rootPath: string; bibRelPath?: string }>) {
  return hosts.find((h) => h.machineId === MACHINE_ID) ?? null;
}

const HOME = process.env.HOME || os.homedir();
const PROJECTS_DIR = `${HOME}/Projects`;

// Guess a project's rootPath from ~/Projects when no host is registered.
// Same heuristic as agent-worker.mts phase-infer.
function guessHostFor(slug: string): { rootPath: string; bibRelPath?: string } | null {
  if (!existsSync(PROJECTS_DIR)) return null;
  const entries = readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const candidates = [slug, slug.toUpperCase(), slug.toLowerCase(), slug.replace(/-/g, ""), slug.replace(/-/g, "_")];
  let dir: string | undefined;
  for (const c of candidates)
    if (entries.includes(c)) {
      dir = c;
      break;
    }
  if (!dir) {
    const head = slug.slice(0, 4).toLowerCase();
    dir = entries.find((e) => e.toLowerCase().startsWith(head));
  }
  if (!dir) return null;
  const rootPath = `${PROJECTS_DIR}/${dir}`;
  // Look for references.bib in common locations.
  const candidatesBib = ["references.bib", "paper/references.bib", "papers/references.bib"];
  const bibRelPath = candidatesBib.find((p) => existsSync(`${rootPath}/${p}`));
  return { rootPath, bibRelPath };
}

async function handleCitations() {
  const raw = convexRun("researchCitations:getPendingRequest");
  if (!raw || raw === "null") return;
  let req;
  try {
    req = JSON.parse(raw);
  } catch {
    return;
  }
  if (!req) return;
  const claimed = convexRun("researchCitations:claimRequest", JSON.stringify({ id: req._id }));
  if (!claimed || claimed === "null") return;

  try {
    // Look up the project to find its host (rootPath, bibRelPath) for THIS machine.
    const projRaw = convexRun("research:getStateInfo", JSON.stringify({ slug: req.researchSlug }));
    if (!projRaw || projRaw === "null") throw new Error(`unknown project: ${req.researchSlug}`);
    const hostsRaw = convexRun("researchHosts:listHosts", JSON.stringify({ researchSlug: req.researchSlug }));
    const hosts = hostsRaw ? JSON.parse(hostsRaw) : [];
    let host = hostForCurrent(hosts);
    if (!host) {
      // No registered host on this machine — fall back to guessing from
      // ~/Projects so the user doesn't have to wire up rootPath manually
      // for every project.
      const guessed = guessHostFor(req.researchSlug);
      if (!guessed) throw new Error(`no host registered + no folder match in ~/Projects for ${req.researchSlug}`);
      host = { machineId: MACHINE_ID, rootPath: guessed.rootPath, bibRelPath: guessed.bibRelPath };
      console.log(
        `[citations] ${req.researchSlug}: using guessed host ${guessed.rootPath} (bib=${guessed.bibRelPath ?? "—"})`,
      );
    }

    if (req.kind === "sync") {
      if (!host.bibRelPath) throw new Error(`host has no bibRelPath`);
      const bibAbs = resolvePath(host.rootPath, host.bibRelPath);
      if (!existsSync(bibAbs)) throw new Error(`bib not found: ${bibAbs}`);
      const text = readFileSync(bibAbs, "utf8");
      const entries = parseBib(text);
      const items = entries.map((e) => ({
        key: e.key,
        title: e.fields.title?.replace(/\s+/g, " "),
        authors: extractAuthors(e.fields.author),
        year: e.fields.year,
        arxivId: extractArxiv(e.fields),
        doi: e.fields.doi,
        url: e.fields.url,
        pdfRelPath: extractPdfPath(e.fields.file),
        raw: text.slice(text.indexOf(`@${e.type}{${e.key}`), text.indexOf(`@${e.type}{${e.key}`) + 800),
      }));
      const upsertOut = convexRun(
        "researchCitations:upsertBatch",
        JSON.stringify({ researchSlug: req.researchSlug, items }),
      );
      convexRun(
        "researchCitations:completeRequest",
        JSON.stringify({ id: req._id, status: "done", result: upsertOut ?? "" }),
      );
      console.log(`[citations] ${req.researchSlug} sync: ${entries.length} entries (${MACHINE_ID})`);
      return;
    }

    if (req.kind === "promote" && req.citationKey) {
      const citRaw = convexRun(
        "researchCitations:get",
        JSON.stringify({ researchSlug: req.researchSlug, key: req.citationKey }),
      );
      if (!citRaw || citRaw === "null") throw new Error(`citation not found: ${req.citationKey}`);
      const cit = JSON.parse(citRaw);

      let fullText: string | undefined;
      if (cit.pdfRelPath) {
        const pdfAbs = resolvePath(host.rootPath, cit.pdfRelPath);
        if (existsSync(pdfAbs)) {
          try {
            const out = execFileSync("pdftotext", ["-layout", "-q", pdfAbs, "-"], {
              encoding: "utf8",
              maxBuffer: 5 * 1024 * 1024,
              timeout: 60_000,
            });
            // Convex doc size limit is generous but no need to store > 200 KB
            // of text; truncate so a fat PDF doesn't blow up the row.
            fullText = out.slice(0, 200_000);
          } catch (e) {
            console.warn(`[citations] pdftotext failed for ${cit.pdfRelPath}: ${(e as Error).message}`);
          }
        }
      }

      const url =
        cit.url || (cit.arxivId ? `https://arxiv.org/abs/${cit.arxivId}` : cit.doi ? `https://doi.org/${cit.doi}` : "");

      convexRun(
        "researchCitations:promoteToPaper",
        JSON.stringify({
          researchSlug: req.researchSlug,
          citationKey: req.citationKey,
          arxivId: cit.arxivId,
          title: cit.title || cit.key,
          authors: cit.authors || [],
          url,
          pdfRelPath: cit.pdfRelPath,
          fullText,
        }),
      );
      convexRun(
        "researchCitations:completeRequest",
        JSON.stringify({
          id: req._id,
          status: "done",
          result: JSON.stringify({ promoted: cit.key, text_kb: fullText ? Math.round(fullText.length / 1024) : 0 }),
        }),
      );
      console.log(`[citations] ${req.researchSlug} promote ${cit.key}${fullText ? " (+text)" : ""}`);
      return;
    }
  } catch (e) {
    convexRun(
      "researchCitations:completeRequest",
      JSON.stringify({ id: req._id, status: "error", error: String((e as Error).message ?? e).slice(0, 500) }),
    );
    console.error(`[citations] ${req.researchSlug} failed: ${(e as Error).message}`);
  }
}

// Local embedding backfill: drain any summaries / research projects / plan
// items still missing a 384-dim vector and write it back via the embeddings
// mutations. Vectors are computed on-device (all-MiniLM-L6-v2, no API). Bounded
// to 64 rows per target per tick so a large first backfill never starves the
// job poll, and runs on a slower cadence since embeddings are not latency
// sensitive. Vector search (related papers / related research) depends on this.
// Vectors are written to the `embeddings` side table under the model that
// produced them, never onto the row itself: a summary read should not have to
// carry one. The model id travels with the write so a search cannot silently
// compare vectors from two different spaces.
const EMBED_TARGETS = [
  { list: "embeddings:listSummariesToEmbed", target: "summaries" },
  { list: "embeddings:listResearchToEmbed", target: "researchProjects" },
  { list: "embeddings:listPlanItemsToEmbed", target: "planItems" },
] as const;
// The listings read only un-embedded rows via the by_embedded index (max 64
// per call, no vectors in the payload), so a tick with an empty queue costs
// almost nothing and no cursor state is needed.
let embeddingRunning = false;
async function pollEmbeddings() {
  if (embeddingRunning) return;
  embeddingRunning = true;
  try {
    for (const t of EMBED_TARGETS) {
      const items = (await convexFetch(t.list, {})) as { id: string; text: string }[] | null;
      if (!items || items.length === 0) continue;
      const vecs = await embed(items.map((it) => (it.text && it.text.trim()) || "empty"));
      for (let i = 0; i < items.length; i++) {
        await convexFetch("embeddings:setEmbedding", {
          model: EMBED_MODEL,
          targetTable: t.target,
          targetId: items[i].id,
          vec: vecs[i],
        });
      }
      console.log(`[worker] embedded ${items.length} ${t.target} with ${EMBED_MODEL}`);
    }
  } catch (e) {
    console.error(`[worker] embed error: ${(e as Error).message}`);
  } finally {
    embeddingRunning = false;
  }
}

// ── Discovery ──────────────────────────────────────────────────────────────
// Every queue below used to be read on a timer, which costs the same whether
// or not there is anything in it: an idle worker measured 6.93 Convex calls a
// second, and 98% of those returned an empty list. Convex re-runs a subscribed
// query only when its result actually changes, so the same discovery now costs
// one execution per queue at startup and then nothing until work appears.
//
// Only the trigger changed. Each handler still lists and claims exactly as it
// did on the timer, and the claim mutation — not the listing — is what stops
// two machines taking the same item, so multi-machine behaviour is unaffected.
// Pickup also got faster: an item arrives as a push instead of waiting out a
// tick, which is what the 1s request ticker was reaching for.
// `run` is called with the pushed result when a subscription fires, and with
// nothing by the sweep. Only the setup queue uses the value, to skip a listing
// it would otherwise repeat.
const WATCHES: { query: string; args?: Record<string, unknown>; run: (pushed?: unknown) => void }[] = [
  { query: "jobs:getAllPending", run: pollJobs },
  { query: "chats:getPending", run: pollChats },
  { query: "diet:getPending", run: pollDiet },
  { query: "expressions:getPendingEnrich", run: pollVocab },
  { query: "paperLinks:pendingForLinks", args: { limit: 1 }, run: pollPaperLinks },
  { query: "insights:listNew", run: pollInsights },
  { query: "insights:listHarvestable", args: { limit: 1 }, run: pollInsightHarvest },
  { query: "mailbox:getPendingRequest", run: () => void handleMailbox() },
  { query: "calendar:getPendingRequest", run: () => void handleCalendar() },
  { query: "researchCitations:getPendingRequest", run: () => void handleCitations() },
  {
    query: "setup:listByStatus",
    args: { status: "pending" },
    run: (pushed) => {
      if (pushed === undefined) return void handleSetup();
      if (Array.isArray(pushed) && pushed.length > 0) return void handleSetup(true);
    },
  },
  ...EMBED_TARGETS.map((t) => ({ query: t.list, run: pollEmbeddings })),
];

// A push covers "something new arrived". It does not cover an item the worker
// itself declined because every slot was busy: nothing changes server-side
// when that happens, so no further push is coming. On the old timer the next
// tick picked it up 3s later, so these are re-run the moment a slot frees to
// keep that behaviour. The request queues are absent because none of them is
// capacity-bound.
const CAPACITY_BOUND: (() => void)[] = [
  pollJobs,
  pollChats,
  pollDiet,
  pollVocab,
  pollPaperLinks,
  pollInsights,
  pollInsightHarvest,
];
function wakeQueues() {
  for (const run of CAPACITY_BOUND) run();
}

// ── Digest mail ────────────────────────────────────────────────────────────
// Sent from here rather than a Convex cron because gws is a local CLI, so the
// backend cannot reach a mailbox. That makes the send only as reliable as this
// process, which is why the period is claimed in Convex: a restart cannot
// resend, and a machine asleep at the send hour still catches up on its next
// sweep instead of losing the day.
const DIGEST_TO = process.env.OPENWORKS_DIGEST_TO || "";
const DIGEST_HOUR = Number(process.env.OPENWORKS_DIGEST_HOUR ?? 8);
const DIGEST_APP_URL = process.env.OPENWORKS_APP_URL || "http://localhost:6001/";
let digestRunning = false;
// Periods this process has already settled, so a sweep after the send does not
// ask the backend again every minute for the rest of the day. Convex remains
// the authority across restarts; this only spares the repeat call.
const digestSettled = new Set<string>();

// `listOpenPRs` answers from the search payload alone, which carries no checks
// and no diffstat: the browser fills those in afterwards from two more calls.
// The mail has no "afterwards", so it makes the same calls before rendering.
// Each one is wrapped on its own, because a mail that lists the PRs without
// their checks beats a mail with no PR section because one repo 404'd.
async function withPRStatus(prs: DigestPR[]): Promise<DigestPR[]> {
  const key = (p: { repo: string; number: number }) => `${p.repo}#${p.number}`;
  const merged = new Map(prs.map((p) => [key(p), { ...p }]));

  try {
    const details = (await convexFetch("github:listPRDetails", {
      prs: prs.map((p) => ({ repo: p.repo, number: p.number })),
    })) as {
      repo: string;
      number: number;
      additions: number;
      deletions: number;
      changedFiles: number;
      mergeable: boolean | null;
    }[];
    for (const d of details ?? []) Object.assign(merged.get(key(d)) ?? {}, d);
  } catch (e) {
    console.warn(`[digest] PR diffstat skipped: ${String((e as Error).message).slice(0, 120)}`);
  }

  // getChecks is one PR per call, so cap the fan-out: a hundred open PRs is a
  // rate limit, and the tail of a bot-bump list is not worth one.
  const CHECKED = 40;
  const targets = [...merged.values()].slice(0, CHECKED);
  await Promise.all(
    targets.map(async (p) => {
      try {
        const c = (await convexFetch("github:getChecks", { repo: p.repo, number: p.number })) as {
          checksPass: number;
          checksTotal: number;
          checksState: string;
          mergeable: boolean | null;
        } | null;
        if (c) Object.assign(p, c);
      } catch {
        // Leave this PR without checks rather than failing the batch.
      }
    }),
  );
  return [...merged.values()];
}

async function pollDigest() {
  if (!DIGEST_TO || digestRunning) return;
  digestRunning = true;
  try {
    for (const due of digestsDue(new Date(), DIGEST_HOUR)) {
      const settledKey = `${due.kind}:${due.periodKey}`;
      if (digestSettled.has(settledKey)) continue;
      const claimed = await convexFetch("digest:claimSend", { kind: due.kind, periodKey: due.periodKey });
      digestSettled.add(settledKey);
      if (claimed !== true) continue;
      let subject: string | undefined;
      try {
        const snapshot = await convexFetch("digest:snapshot", {
          since: due.since,
          until: due.until,
          prevSince: due.prevSince,
        });
        // PRs come from GitHub rather than the database, so a rate limit or a
        // missing token drops the section instead of the whole mail.
        let prs: DigestPR[] | undefined;
        try {
          const grouped = (await convexFetch("github:listOpenPRs", {})) as Record<string, DigestPR[]> | null;
          if (grouped) prs = Object.values(grouped).flat();
        } catch (e) {
          console.warn(`[digest] PRs skipped: ${String((e as Error).message).slice(0, 120)}`);
        }
        if (prs?.length) prs = await withPRStatus(prs);
        const rendered = renderDigest({ kind: due.kind, snapshot, prs, appUrl: DIGEST_APP_URL });
        subject = rendered.subject;
        const raw = buildMime(DIGEST_TO, rendered.subject, rendered.html, rendered.text);
        execFileSync("gws", gwsSendArgs(DIGEST_TO, raw), {
          encoding: "utf8",
          timeout: 60_000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        await convexFetch("digest:recordSend", { kind: due.kind, periodKey: due.periodKey, subject });
        console.log(`[digest] sent ${due.kind} ${due.periodKey}: ${subject}`);
      } catch (e) {
        const error = String((e as Error).message ?? e).slice(0, 500);
        await convexFetch("digest:recordSend", { kind: due.kind, periodKey: due.periodKey, subject, error });
        console.error(`[digest] ${due.kind} ${due.periodKey} failed: ${error}`);
      }
    }
  } finally {
    digestRunning = false;
  }
}

// Backstop for a socket that dropped without recovering, and the only thing
// that drives the unstick sweep now that it no longer rides the job tick.
const SWEEP_INTERVAL = 60_000;
function sweep() {
  for (const w of WATCHES) w.run();
  pollStuck();
  void pollDigest();
}

console.log(`[worker] provider=${PROVIDER}, max ${MAX_WORKERS}, machine=${MACHINE_ID}`);
const watcher = await connectConvexWatcher({
  url: CONVEX_HTTP_URL,
  serviceKey: OPENWORKS_SERVICE_KEY,
  onError: (fn, e) => console.error(`[watch] ${fn}: ${e.message}`),
});

// Usage rows are written on every view change, so the table grows with use and
// nothing here is worth keeping for a year. Bounded per call, so this repeats
// until a pass comes back empty rather than one transaction deleting a season.
const USAGE_RETENTION_DAYS = Number(process.env.OPENWORKS_USAGE_RETENTION_DAYS ?? 180);
async function purgeUsage() {
  try {
    for (let i = 0; i < 20; i++) {
      const r = (await convexFetch("usage:purge", { days: USAGE_RETENTION_DAYS })) as {
        sessions: number;
        events: number;
        done: boolean;
      } | null;
      if (!r || (r.sessions === 0 && r.events === 0)) return;
      console.log(`[worker] usage purge: ${r.sessions} visits, ${r.events} events`);
      if (r.done) return;
    }
  } catch (e) {
    console.warn(`[worker] usage purge skipped: ${String((e as Error).message).slice(0, 120)}`);
  }
}
setInterval(() => void purgeUsage(), 6 * 60 * 60_000);
void purgeUsage();

if (watcher.live) {
  for (const w of WATCHES) watcher.watch(w.query, w.args ?? {}, (pushed) => w.run(pushed));
  setInterval(sweep, SWEEP_INTERVAL);
  pollStuck();
  console.log(`[worker] watching ${WATCHES.length} queues, ${SWEEP_INTERVAL / 1000}s sweep`);
} else {
  // No deployment URL resolved, so there is no socket to subscribe over and
  // every call goes through the convex CLI. Keep the original timers.
  console.log(`[worker] no deployment url — polling every ${POLL_INTERVAL / 1000}s`);
  for (const w of WATCHES) w.run();
  setInterval(() => {
    for (const w of WATCHES) w.run();
  }, POLL_INTERVAL);
  pollStuck();
  setInterval(pollStuck, POLL_INTERVAL);
  setInterval(() => void pollDigest(), SWEEP_INTERVAL);
}

// Graceful shutdown. Handling SIGINT alone was not enough: SIGTERM and SIGHUP
// take node's default path, which exits without running a handler, so the log
// simply stopped mid-sentence and the only way to date the death was the log
// file's mtime. Naming the signal is what makes the next one diagnosable.
function shutdown(signal: NodeJS.Signals) {
  console.log(`[worker] ${new Date().toISOString()} ${signal} received, shutting down...`);
  if (active.size === 0) process.exit(0);
  let remaining = active.size;
  for (const child of active.values()) {
    child.kill("SIGTERM");
    child.on("close", () => {
      remaining--;
      if (remaining === 0) process.exit(0);
    });
  }
  // Force exit after 10s if children don't close
  setTimeout(() => {
    console.log("[worker] force exit");
    process.exit(1);
  }, 10_000);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => shutdown(signal));

// Catches the paths no signal handler covers: a thrown error, an explicit
// exit, a closed event loop. SIGKILL still leaves nothing behind, and that
// absence is now itself the diagnosis.
process.on("exit", (code) => console.log(`[worker] ${new Date().toISOString()} exit ${code}`));
