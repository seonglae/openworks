import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// The research MCP server is the one thing here that no other test can reach.
// It runs under bare node rather than tsx, imports no workspace package, and is
// launched by the agent CLIs rather than by this repo, so a typecheck says
// nothing about whether it starts and `pnpm test` never loaded it.
//
// That gap is expensive because the failure is silent. `zod` was imported but
// never declared, which npm's flat node_modules resolved anyway as a transitive
// dependency of the MCP SDK; under pnpm only declared dependencies are linked,
// so every launch died on ERR_MODULE_NOT_FOUND before serving a single tool. A
// CLI whose MCP server fails to start simply has no research tools and carries
// on without them, and nothing anywhere says so.
//
// So this asserts the one property that failure violates: it starts, and it
// answers. A handshake against the real binary is the only check that covers an
// undeclared import, since every cheaper check passes while it is broken.

// From the runner's root rather than this file's own directory: `import.meta`
// is not available under the CommonJS target the test tsconfig builds to.
const SERVER = resolve(process.cwd(), "mcp/research-server.mjs");

type Rpc = { id?: number; result?: { tools?: { name: string }[] } };

// A live stdio session, torn down once for the whole file: startup dominates
// the cost and every case here asks the same process a different question.
function session() {
  const proc = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (d: string) => (stdout += d));
  proc.stderr.on("data", (d: string) => (stderr += d));

  // Exiting at all is a failure here, so it is captured rather than awaited:
  // the assertion belongs to whichever request was in flight.
  let exited: string | null = null;
  proc.on("exit", (code) => (exited = `exited ${code}: ${stderr.slice(0, 400)}`));

  const call = (id: number, method: string, params: unknown) =>
    new Promise<Rpc>((ok, fail) => {
      const started = Date.now();
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      const poll = setInterval(() => {
        if (exited) {
          clearInterval(poll);
          fail(new Error(exited));
          return;
        }
        for (const line of stdout.split("\n")) {
          if (!line.trim()) continue;
          let msg: Rpc;
          try {
            msg = JSON.parse(line) as Rpc;
          } catch {
            continue;
          }
          if (msg.id === id) {
            clearInterval(poll);
            ok(msg);
            return;
          }
        }
        if (Date.now() - started > 20_000) {
          clearInterval(poll);
          fail(new Error(`no reply to ${method}; stderr: ${stderr.slice(0, 400)}`));
        }
      }, 50);
    });

  return { call, stop: () => proc.kill() };
}

const s = session();
afterAll(() => s.stop());

describe("the research MCP server", () => {
  // Otherwise a moved server file or an unexpected cwd reads as a spawn that
  // produced no reply, which is the same symptom as the bug this file guards.
  it("is where the CLIs are configured to find it", () => {
    expect(existsSync(SERVER)).toBe(true);
  });

  it("starts and completes a handshake", async () => {
    const res = await s.call(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest", version: "1" },
    });
    expect(res.result).toBeTruthy();
  }, 30_000);

  // Registering a tool is what evaluates its zod schema, so a missing zod takes
  // the whole surface down rather than one tool.
  it("serves the research tool surface", async () => {
    const res = await s.call(2, "tools/list", {});
    const names = (res.result?.tools ?? []).map((t) => t.name);
    expect(names.length).toBeGreaterThan(40);
    // The entry points every agent uses to find, advance and discuss a project.
    expect(names).toContain("list_projects");
    expect(names).toContain("advance");
    expect(names).toContain("post_comment");
    expect(names).toContain("save_report");
    expect(names).toContain("list_reports");
  }, 30_000);
});
