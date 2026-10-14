#!/usr/bin/env node
// agent-worker: polls agentRuns(status=pending) and dispatches the spawned CLI
// (gemini, then codex, then claude). Mirrors the pattern in worker.mts but for
// the trigger-based collaboration system instead of newsletters.
//
// Run `npx tsx scripts/agent-worker.mts` from the repo root, which is where
// both workers resolve .env.local and every relative path from. Started by
// hand it stays dead once anything stops it; deploy/launchd is what keeps it
// running.

import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { resolve } from "path";
import { existsSync, readdirSync, readFileSync } from "fs";
import * as os from "os";
import { ORDERS, runActor } from "./actor.mts";
import { statesFor } from "@openworks/domain";
import { dispatchAgentRun, parsePhaseOutput, recordRunError } from "./agent-dispatch.mts";
import { connectConvexWatcher, createConvexClient, loadEnvLocal, resolveConvexUrl } from "@openworks/node";

const execFileP = promisify(execFile);
const PROJECT_ROOT = resolve(new URL("..", import.meta.url).pathname);

// Load .env.local, as worker.mts does. This one only ever read CONVEX_URL out
// of the file and took everything else from the real environment, so launching
// it the documented way left OPENWORKS_SERVICE_KEY unset and every call failed the
// owner gate with "auth required". A value already in the environment wins.
for (const [key, val] of Object.entries(loadEnvLocal(PROJECT_ROOT))) {
  if (!process.env[key]) process.env[key] = val;
}
const CONVEX_BIN = resolve(PROJECT_ROOT, "node_modules/.bin/convex");
// Only used when no deployment URL resolves and the socket is unavailable.
const POLL_MS = 5000;
// Backstop for a dropped socket, and for a run left behind because a drain was
// already in flight when its push arrived.
const SWEEP_MS = 60_000;
const SPAWN_TIMEOUT_MS = 5 * 60 * 1000;

// Calling functions over HTTP keeps everything in this single process — the old
// path spawned a full convex CLI node process (~60-110MB RSS) for every call,
// twice per 5s poll tick.
const CONVEX_HTTP_URL = resolveConvexUrl(PROJECT_ROOT);

// Function kind (query/mutation/action) discovered on first call and cached
// so steady state is one request per call.
const convexFnKind = new Map<string, string>();

// Single-owner service key, injected into every backend call (worker hits the
// anonymous HTTP API / admin CLI, never a Clerk session). No-op until set.
const OPENWORKS_SERVICE_KEY = process.env.OPENWORKS_SERVICE_KEY;

async function convexCli(fn, args) {
  const { stdout } = await execFileP(CONVEX_BIN, ["run", fn, JSON.stringify(args)], {
    cwd: PROJECT_ROOT,
    timeout: 30_000,
    maxBuffer: 50 * 1024 * 1024,
  });
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

const convex = createConvexClient({
  url: CONVEX_HTTP_URL,
  serviceKey: OPENWORKS_SERVICE_KEY,
  timeoutMs: 30_000,
  kindCache: convexFnKind,
  cliFallback: convexCli,
}) as (fn: string, args?: any) => Promise<any>;

async function processOne() {
  const runs = await convex("agentSubscriptions:listRuns", { status: "pending", limit: 1 });
  if (!runs || runs.length === 0) return false;
  const run = runs[0];
  const claimed = await convex("agentSubscriptions:claimRun", { id: run._id });
  if (!claimed) return false;
  console.log(
    `[${new Date().toISOString()}] dispatch ${run.agentId} (${run.triggerType} ${run.triggerEntityType}/${run.triggerEntityKey})`,
  );
  const result = await dispatchAgentRun(claimed, {
    invoke: (prompt) =>
      runActor({
        order: ORDERS.agentRun,
        prompt,
        cwd: PROJECT_ROOT,
        env: process.env,
        mode: "agent",
        timeoutMs: SPAWN_TIMEOUT_MS,
        onAttempt: (e) => {
          if (e.event === "fail") console.warn(`  × ${e.provider}: ${e.error}`);
        },
      }),
    complete: (args) => convex("agentSubscriptions:completeRun", args),
  });
  if (result.status === "done") console.log(`  ✓ ${result.provider} done`);
  else console.error(`  × agent run failed: ${result.error}`);
  if (!result.recorded) console.warn(`  × could not record run error: ${result.completionError}`);
  return true;
}

// ── Per-research phase inference ────────────────────────────────────────

const HOME = process.env.HOME || os.homedir();
const PROJECTS_DIR = `${HOME}/Projects`;
const MACHINE_ID = process.env.OPENWORKS_MACHINE_ID || os.hostname();

// Guess a project's local folder when no host is registered. Tries the
// slug verbatim, then case variants, then a couple of common renamings.
function guessRootPath(slug: string): string | null {
  if (!existsSync(PROJECTS_DIR)) return null;
  const entries = readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const candidates = [slug, slug.toUpperCase(), slug.toLowerCase(), slug.replace(/-/g, ""), slug.replace(/-/g, "_")];
  for (const c of candidates) {
    if (entries.includes(c)) return `${PROJECTS_DIR}/${c}`;
  }
  // Loose fuzzy: directory name shares the first 4+ chars of the slug
  const head = slug.slice(0, 4).toLowerCase();
  const fuzzy = entries.find((e) => e.toLowerCase().startsWith(head));
  return fuzzy ? `${PROJECTS_DIR}/${fuzzy}` : null;
}

function gitContextFor(rootPath: string): { tree: string; log: string; bibPresent: boolean; paperDirs: string[] } {
  let log = "";
  try {
    log = execFileSync("git", ["-C", rootPath, "log", "--pretty=format:%h %ad %s", "--date=short", "-n", "60"], {
      encoding: "utf8",
      timeout: 10_000,
    });
  } catch {}
  let tree = "";
  try {
    tree = execFileSync("ls", ["-1", rootPath], { encoding: "utf8", timeout: 5_000 });
  } catch {}
  const ls = tree.split("\n").filter(Boolean);
  const paperDirs = ls.filter((n) => /^paper(-|$)/i.test(n));
  const bibPresent =
    existsSync(`${rootPath}/references.bib`) || paperDirs.some((d) => existsSync(`${rootPath}/${d}/references.bib`));
  return { tree, log, bibPresent, paperDirs };
}

async function processPhaseInfer(): Promise<boolean> {
  const run = await convex("researchPhaseInfer:getPendingRun", {});
  if (!run) return false;
  const claimed = await convex("researchPhaseInfer:claimRun", { id: run._id });
  if (!claimed) return false;

  try {
    const slug = claimed.researchSlug as string;
    if (claimed.kindSnapshot !== "own" && claimed.kindSnapshot !== "review") {
      throw new Error("Phase run has no supported enqueue-time kind snapshot; request a fresh inference");
    }
    const rootPath = (claimed.rootPath as string | undefined) || guessRootPath(slug);
    if (!rootPath || !existsSync(rootPath)) {
      throw new Error(`rootPath not found (slug=${slug})`);
    }
    const ctx = gitContextFor(rootPath);
    const allowed = statesFor(claimed.kindSnapshot).join(" | ");
    const prompt = [
      `You are a research-state inference subagent.`,
      `Project slug: "${slug}". Folder: ${rootPath}.`,
      `Queued project kind: ${claimed.kindSnapshot}. Queued phase: ${claimed.phaseSnapshot}.`,
      `Inspect the folder tree and git log below; infer the project's current FSM phase plus the sequence of phases it has visited with approximate timestamps and short reasons.`,
      `The local folder is observed now, not an immutable snapshot of the files at enqueue time. Do not present it as pinned historical evidence.`,
      ``,
      `Allowed phases (use exactly these strings): ${allowed}.`,
      `Output STRICT JSON on a single line, no prose, no markdown fences:`,
      `{"phase": "<current>", "history": [{"state": "<state>", "at": <unix_ms_or_null>, "note": "<≤80 chars>"}, ...]}`,
      `Order history oldest→newest. The last entry's state should equal "phase".`,
      claimed.kindSnapshot === "own"
        ? `Heuristics: paper/ folder present → writing or later. references.bib has many entries → past literature. tags / commits mentioning "rebuttal" / "camera-ready" → rebuttal or accepted. "submit" / "neurips" / "iclr" branch names → submit_main. "workshop" → submit_workshop. Otherwise use the allowed state best supported by the recent commits.`
        : `Infer the review workflow from evidence of setup, literature review, drafting, ranking, submission, rebuttal audit and final scoring. Do not substitute the author's writing/publication phases for the allowed review states.`,
      ``,
      `Folder tree (top-level):\n${ctx.tree}`,
      `paper subdirs: ${ctx.paperDirs.join(", ") || "(none)"} | references.bib: ${ctx.bibPresent}`,
      ``,
      `Git log (newest first, up to 60 commits):\n${ctx.log.slice(0, 8000)}`,
    ].join("\n");

    const result = await runActor({
      order: ORDERS.agentRun,
      prompt,
      cwd: rootPath,
      env: { ...process.env, CLAUDECODE: undefined, OPENWORKS_WORKER: "1" },
      mode: "agent",
      timeoutMs: SPAWN_TIMEOUT_MS,
      onAttempt: (e) => {
        if (e.event === "fail") console.warn(`  × ${e.provider}: ${e.error}`);
      },
    });

    const parsed = parsePhaseOutput(result.stdout);
    await convex("researchPhaseInfer:applyInferred", {
      runId: claimed._id,
      researchSlug: slug,
      phase: parsed.phase,
      history: parsed.history,
    });
    await convex("researchPhaseInfer:completeRun", {
      id: claimed._id,
      status: "done",
      inferredPhase: parsed.phase,
      inferredHistory: JSON.stringify(parsed.history),
      rawOutput: result.stdout.slice(0, 4000),
    });
    console.log(`[phase-infer] ${slug} → ${parsed.phase} (history ${parsed.history.length})`);
    return true;
  } catch (e) {
    const completion = await recordRunError(claimed._id, e, (args) => convex("researchPhaseInfer:completeRun", args));
    if (!completion.recorded) console.warn(`[phase-infer] could not record run error: ${completion.completionError}`);
    console.error(`[phase-infer] failed: ${(e as Error).message}`);
    return true;
  }
}

// Both queues are drained in one pass because the old loop retried straight
// away after a handled run and only slept once both came back empty. The guard
// stands in for the loop being single-threaded: a push arriving mid-run must
// not start a second drain over the same rows.
let draining = false;
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while ((await processOne()) || (await processPhaseInfer())) {}
  } catch (e) {
    console.error("loop error:", (e as Error).message);
  } finally {
    draining = false;
  }
}

// Given its own cadence rather than living inside drain(): its job is to
// recover rows a dead process left behind, so it must not depend on the drain
// loop being healthy, and a push-triggered drain would run it far too often.
async function reap() {
  try {
    const r = await convex("agentSubscriptions:reapStaleRuns", {});
    if (r?.reaped)
      console.log(`[${new Date().toISOString()}] reaped ${r.reaped} abandoned run(s): ${r.ids.join(", ")}`);
  } catch (e) {
    console.error("reap error:", (e as Error).message);
  }
}

async function main() {
  void reap();
  setInterval(() => void reap(), SWEEP_MS);

  // Same move as worker.mts: the queue tells us when it has something instead
  // of being asked every 5s. claimRun still decides which machine gets a run,
  // so nothing about multi-machine dispatch changes here.
  const watcher = await connectConvexWatcher({
    url: CONVEX_HTTP_URL,
    serviceKey: OPENWORKS_SERVICE_KEY,
    onError: (fn, e) => console.error(`[watch] ${fn}: ${e.message}`),
  });

  if (watcher.live) {
    watcher.watch("agentSubscriptions:listRuns", { status: "pending", limit: 1 }, () => void drain());
    watcher.watch("researchPhaseInfer:getPendingRun", {}, () => void drain());
    setInterval(() => void drain(), SWEEP_MS);
    console.log(`agent-worker started, watching 2 queues, ${SWEEP_MS / 1000}s sweep, machine=${MACHINE_ID}`);
    return;
  }

  console.log(`agent-worker started, polling every ${POLL_MS}ms, machine=${MACHINE_ID}`);
  while (true) {
    await drain();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// This process had no signal handling at all, so every stop was indistinguishable
// from a crash and left whatever it had claimed sitting in `running`. It cannot
// finish an in-flight CLI run on the way out, so it records that one was lost
// and leaves the row to reapStaleRuns.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    const abandoned = draining ? " (a run was in flight)" : "";
    console.log(`[${new Date().toISOString()}] agent-worker ${signal} received, exiting${abandoned}`);
    process.exit(0);
  });
}

process.on("exit", (code) => console.log(`[${new Date().toISOString()}] agent-worker exit ${code}`));

main();
