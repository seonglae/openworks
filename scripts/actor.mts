// actor.mjs: single entry point for spawning agent CLIs (antigravity / codex /
// claude). Both worker.mjs and agent-worker.mjs route through this so the
// fallback chain, argv layout, stdin/-p semantics, and MCP wiring are
// defined exactly once.
//
// Two surfaces:
//   spawnProvider(name, opts)   — low-level: returns the child process.
//                                  Callers wire stdout/stderr/timeouts
//                                  themselves (worker.mjs needs this because
//                                  it tracks live processes in an active map
//                                  and SIGTERMs them when the job is
//                                  already-done elsewhere).
//   runActor({ order, ... })    — high-level: iterates the fallback chain
//                                  sequentially, returns Promise resolved
//                                  with the first success. agent-worker.mjs
//                                  uses this because each run is fire-and-
//                                  forget.

import { spawn, type ChildProcess } from "child_process";
import { resolve } from "path";

// Absolute path to the Openworks research-mcp server. Exposed INLINE to every
// spawned agent (chat replies + triggered agent runs included) so they can call
// similar_articles / research state / comments without depending on each CLI's
// global MCP registration. The server reads OPENWORKS_SERVICE_KEY + CONVEX_DEPLOYMENT
// from the inherited environment, so no secret is ever placed on the argv.
const OPENWORKS_MCP_PATH = resolve(new URL("..", import.meta.url).pathname, "mcp/research-server.mjs");
const openworksMcpInlineJSON = JSON.stringify({
  mcpServers: { openworks: { command: "node", args: [OPENWORKS_MCP_PATH] } },
});
const codexOpenworksMcpArgs = [
  "-c",
  'mcp_servers.openworks.command="node"',
  "-c",
  `mcp_servers.openworks.args=["${OPENWORKS_MCP_PATH}"]`,
];

export type ProviderName = "antigravity" | "codex" | "claude";
// "job"  = newsletter / paper / article — claude gets full flags incl. JSON output + MCP
// "chat" = follow-up chat reply       — claude gets flags + JSON + inline Openworks MCP
// "agent"= triggered subscription run — claude is invoked as `-p PROMPT` (inline)
//          with the Openworks MCP attached so it can use research / similar_articles tools
export type Mode = "job" | "chat" | "agent";

export type SpawnOpts = {
  prompt: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  mode?: Mode;
  skipMcp?: boolean;
  mcpConfig?: string;
};

export type RunResult = { stdout: string; stderr: string; code: number };
export type ActorResult = RunResult & { provider: ProviderName };

export type AttemptEvent =
  | { event: "attempt"; provider: ProviderName }
  | { event: "success"; provider: ProviderName; code: number }
  | { event: "fail"; provider: ProviderName; error: string };

export type RunActorOpts = SpawnOpts & {
  order: ProviderName[];
  timeoutMs?: number;
  onAttempt?: (e: AttemptEvent) => void;
};

// Per-task-type fallback chains. codex-first across the board after the Google
// CLI's summaries were observed to be sloppy (mixing papers, weak prose). codex
// then antigravity then claude is the global default; pr-fix keeps codex then
// claude then antigravity since claude handles repo context better for diffs.
// (antigravity = `agy`, the Gemini-powered CLI that replaced the deprecated
// gemini CLI.)
export const ORDERS: Record<string, ProviderName[]> = {
  newsletter: ["codex", "antigravity", "claude"],
  paper: ["codex", "antigravity", "claude"],
  insight: ["codex", "antigravity", "claude"],
  article: ["codex", "antigravity", "claude"],
  chat: ["codex", "antigravity", "claude"],
  agentRun: ["codex", "antigravity", "claude"],
  "pr-fix": ["codex", "claude", "antigravity"],
  default: ["codex", "antigravity", "claude"],
};

export function orderFor(taskType?: string): ProviderName[] {
  if (taskType && ORDERS[taskType]) return ORDERS[taskType];
  return ORDERS.default;
}

export function nextProvider(name: ProviderName, order: ProviderName[]): ProviderName | null {
  const i = order.indexOf(name);
  if (i < 0 || i + 1 >= order.length) return null;
  return order[i + 1];
}

// How one provider is invoked. Split out of spawnProvider so the argv can be
// asserted without launching a CLI: the flags here decide whether an agent can
// reach the network or the database at all, and getting one wrong fails the
// run in a way that looks like the model misbehaving rather than a config bug.
export type Invocation = { cmd: string; args: string[]; useStdin: boolean };

// opts:
//   prompt       : instructions, passed via --print (antigravity) or stdin (codex/claude)
//   mode         — "job" | "chat" | "agent" (affects claude flags)
//   skipMcp      — when true, omit the inline Openworks MCP
//   mcpConfig    — absolute path to claude MCP config (only used when
//                  mode === "job" && !skipMcp)
export function providerInvocation(provider: ProviderName, opts: Omit<SpawnOpts, "cwd" | "env">): Invocation {
  const { prompt, mode = "job", skipMcp, mcpConfig } = opts;
  let cmd: string;
  let args: string[];
  let useStdin: boolean;
  if (provider === "antigravity") {
    // antigravity (`agy`, Gemini-powered) replaces the deprecated gemini CLI.
    // `--print` runs one prompt non-interactively; `--dangerously-skip-permissions`
    // auto-approves tool calls (yolo-equivalent). No hai-guardian plugin is
    // imported into agy, so no per-call exclusion is needed here.
    cmd = "agy";
    args = ["--print", prompt, "--dangerously-skip-permissions"];
    useStdin = false;
  } else if (provider === "codex") {
    cmd = "codex";
    // Per-call disable of the hai-guardian codex plugin: the guardian PreToolUse
    // hook blocks the agent's tool calls and fails the run, cascading the
    // fallback chain down to claude and burning premium quota. Decoupled from
    // the global ~/.codex/config.toml plugin state on purpose, since the user
    // develops the guardian and re-enables it often.
    const noGuardian = ["-c", 'plugins."hai-guardian@hai-marketplace".enabled=false'];
    // codex exec sandboxes to workspace-write, and workspace-write denies
    // network by default. Every prompt this worker builds ends by writing its
    // result back with `npx convex run`, and papers have to be fetched first,
    // so without this codex could not finish a single job: DNS failed, nothing
    // reached the database, the job never left `summarizing`, and processJob
    // (which judges by DB status, not exit code) fell through to antigravity
    // every time. codex is first in every chain, so that was one wasted attempt
    // per job. The other two providers run unsandboxed already, so this closes
    // an asymmetry rather than widening the blast radius.
    const network = ["-c", "sandbox_workspace_write.network_access=true"];
    // Inline the Openworks MCP for every mode (chat + agent included) unless skipped.
    const mcp = skipMcp ? [] : codexOpenworksMcpArgs;
    // `exec` already defaults to workspace-write with approval never, and
    // --full-auto is deprecated in favour of --sandbox, so it only added a
    // deprecation warning to stderr — which is the string processJob surfaces
    // as the failure reason in the UI.
    args = ["exec", ...noGuardian, ...network, ...mcp];
    useStdin = true;
  } else if (provider === "claude") {
    cmd = "claude";
    if (mode === "agent") {
      // Triggered subscription run: inline prompt. Attach the Openworks MCP inline
      // (and skip permissions so the agent can call its tools autonomously) so
      // agent runs can use similar_articles / post_comment / research state.
      args = ["-p", prompt, "--dangerously-skip-permissions"];
      if (!skipMcp) args.push("--mcp-config", openworksMcpInlineJSON);
      useStdin = false;
    } else {
      const claudeArgs = ["-p", "--no-session-persistence", "--dangerously-skip-permissions"];
      // Use JSON output for both job and chat. Plain text mode leaks CLI
      // diagnostic banners (e.g. "MCP issues detected. Run /mcp list for
      // status.") directly into stdout, which then ended up concatenated
      // onto chat replies. JSON mode keeps the response inside `.result`
      // and pushes the noise elsewhere.
      if (mode === "job" || mode === "chat") claudeArgs.push("--output-format", "json");
      // The Openworks MCP goes to job AND chat inline; the optional caller-supplied
      // mcpConfig (e.g. the headless-playwright server for fetching) is layered
      // on for jobs. --mcp-config accepts multiple values and merges them.
      if (!skipMcp) {
        claudeArgs.push("--mcp-config", openworksMcpInlineJSON);
        if (mode === "job" && mcpConfig) claudeArgs.push("--mcp-config", mcpConfig);
      }
      args = claudeArgs;
      useStdin = true;
    }
  } else {
    throw new Error(`unknown provider: ${provider}`);
  }
  return { cmd, args, useStdin };
}

// Spawn one provider. Returns the child process directly so the caller can
// attach handlers, track it, and SIGTERM/SIGKILL on demand.
export function spawnProvider(provider: ProviderName, opts: SpawnOpts): ChildProcess {
  const { prompt, cwd, env } = opts;
  const { cmd, args, useStdin } = providerInvocation(provider, opts);
  const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env });
  if (useStdin) {
    child.stdin!.write(prompt);
    child.stdin!.end();
  } else {
    child.stdin!.end();
  }
  return child;
}

// High-level: run sequential fallback chain. Resolves on the first non-zero-
// exit success. Rejects when every provider in the chain has failed.
//
// args:
//   order       — providers to try, in priority order
//   prompt      — instructions for every attempt
//   cwd         — working directory
//   env         — environment
//   mode        — passed to spawnProvider
//   skipMcp     — passed to spawnProvider
//   mcpConfig   — passed to spawnProvider
//   timeoutMs   — per-attempt timeout (default 30 min)
//   onAttempt   — optional callback ({ event, provider, ...}) for logging
export async function runActor(opts: RunActorOpts): Promise<ActorResult> {
  const { order, timeoutMs = 30 * 60_000, onAttempt, ...spawn } = opts;
  let lastErr: Error | undefined;
  for (const provider of order) {
    onAttempt?.({ event: "attempt", provider });
    try {
      const result = await runOne(provider, { ...spawn, timeoutMs });
      onAttempt?.({ event: "success", provider, code: result.code });
      return { provider, ...result };
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      onAttempt?.({ event: "fail", provider, error: lastErr.message });
    }
  }
  throw lastErr ?? new Error("all providers failed");
}

function runOne(provider: ProviderName, opts: SpawnOpts & { timeoutMs: number }): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawnProvider(provider, opts);
    let stdout = "";
    let stderr = "";
    let killed = false;
    const t = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
      reject(new Error(`${provider}: timeout after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
    child.stdout!.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(t);
      if (killed) return;
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(new Error(`${provider}: exit ${code}\n${stderr.slice(0, 500)}`));
    });
  });
}
