import { describe, expect, it } from "vitest";
import { ORDERS, nextProvider, orderFor, providerInvocation } from "../scripts/actor.mts";

// These flags are the difference between an agent that can do the work and one
// that silently cannot. A wrong flag does not crash: the CLI exits 0 having
// achieved nothing, the job never leaves `summarizing`, and processJob falls
// through to the next provider — which reads as the model being bad rather
// than the invocation being wrong. So the argv is pinned here.
const inv = (provider: Parameters<typeof providerInvocation>[0], opts = {}) =>
  providerInvocation(provider, { prompt: "p", ...opts });

describe("codex invocation", () => {
  // The bug this pins: codex exec sandboxes to workspace-write, which denies
  // network. Every prompt the worker builds writes its result back with
  // `npx convex run`, so without this codex could not finish a single job.
  it("enables network access, because every job writes its result over the network", () => {
    const { args } = inv("codex");
    expect(args).toContain("sandbox_workspace_write.network_access=true");
  });

  it("keeps network access in chat and agent mode too", () => {
    for (const mode of ["chat", "agent"] as const) {
      expect(inv("codex", { mode }).args).toContain("sandbox_workspace_write.network_access=true");
    }
  });

  // The guardian's PreToolUse hook blocks tool calls and fails the run, which
  // cascades the chain down to claude and burns premium quota.
  it("disables the hai-guardian plugin per call", () => {
    expect(inv("codex").args).toContain('plugins."hai-guardian@hai-marketplace".enabled=false');
  });

  it("runs exec and takes its prompt on stdin", () => {
    const { cmd, args, useStdin } = inv("codex");
    expect(cmd).toBe("codex");
    expect(args[0]).toBe("exec");
    expect(useStdin).toBe(true);
  });

  // --full-auto is deprecated in favour of --sandbox and exec already defaults
  // to workspace-write with approval never, so passing it only wrote a
  // deprecation warning to stderr — the string processJob surfaces in the UI
  // as the reason a job failed.
  it("does not pass the deprecated --full-auto", () => {
    expect(inv("codex").args).not.toContain("--full-auto");
  });

  it("attaches the Openworks MCP unless the caller skips it", () => {
    expect(inv("codex").args.join(" ")).toContain("mcp_servers.openworks.command");
    expect(inv("codex", { skipMcp: true }).args.join(" ")).not.toContain("mcp_servers.openworks.command");
  });
});

describe("the other providers in the chain", () => {
  // Neither is sandboxed, which is why they completed the jobs codex could
  // not. That asymmetry is the whole reason the codex flag was needed.
  it("antigravity takes the prompt as an argument and skips permissions", () => {
    const { cmd, args, useStdin } = inv("antigravity");
    expect(cmd).toBe("agy");
    expect(args).toEqual(["--print", "p", "--dangerously-skip-permissions"]);
    expect(useStdin).toBe(false);
  });

  it("claude asks for JSON so CLI banners stay out of the reply text", () => {
    expect(inv("claude", { mode: "job" }).args).toContain("--output-format");
    expect(inv("claude", { mode: "chat" }).args).toContain("--output-format");
  });

  it("claude in agent mode inlines the prompt rather than reading stdin", () => {
    const { args, useStdin } = inv("claude", { mode: "agent" });
    expect(args.slice(0, 2)).toEqual(["-p", "p"]);
    expect(useStdin).toBe(false);
  });

  it("rejects a provider it does not know", () => {
    expect(() => inv("gemini" as never)).toThrow("unknown provider");
  });
});

describe("fallback order", () => {
  it("puts codex first everywhere, so a broken codex costs every job an attempt", () => {
    for (const order of Object.values(ORDERS)) expect(order[0]).toBe("codex");
  });

  it("sends pr-fix to claude before antigravity, unlike every other task", () => {
    expect(ORDERS["pr-fix"]).toEqual(["codex", "claude", "antigravity"]);
  });

  it("falls back to the default order for an unknown task type", () => {
    expect(orderFor("no-such-task")).toEqual(ORDERS.default);
    expect(orderFor(undefined)).toEqual(ORDERS.default);
  });

  it("reports no next provider once the chain is exhausted", () => {
    const order = ORDERS.default;
    expect(nextProvider(order[0], order)).toBe(order[1]);
    expect(nextProvider(order[order.length - 1], order)).toBeNull();
  });
});
