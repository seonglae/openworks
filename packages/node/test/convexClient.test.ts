import { describe, expect, it } from "vitest";
import { createConvexClient } from "../src/convexClient.ts";

type Call = { url: string; body: { path: string; args: Record<string, unknown> } };

// Stands in for the deployment: `kinds` says which endpoint each function is
// actually defined on, and anything else gets the server's real wrong-kind
// message so the probe loop is exercised rather than mocked around.
function fakeDeployment(kinds: Record<string, string>, values: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const endpoint = url.split("/api/")[1];
    const want = kinds[body.path];
    if (want === undefined) return { json: async () => ({ status: "error", errorMessage: "Could not find function" }) };
    if (endpoint !== want) {
      const proper = want[0].toUpperCase() + want.slice(1);
      return {
        json: async () => ({
          status: "error",
          errorMessage: `Trying to execute ${body.path} as Query, but it is defined as ${proper}.`,
        }),
      };
    }
    return { json: async () => ({ status: "success", value: values[body.path] ?? null }) };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const base = {
  url: "https://x.convex.cloud",
  timeoutMs: 1_000,
  cliFallback: async () => "cli",
};

describe("createConvexClient", () => {
  it("finds a mutation after the query probe is rejected", async () => {
    const { impl, calls } = fakeDeployment({ "jobs:create": "mutation" }, { "jobs:create": { id: 1 } });
    const convex = createConvexClient({ ...base, fetchImpl: impl });
    expect(await convex("jobs:create", {})).toEqual({ id: 1 });
    expect(calls.map((c) => c.url.split("/api/")[1])).toEqual(["query", "mutation"]);
  });

  it("remembers the kind so the second call costs one request", async () => {
    const { impl, calls } = fakeDeployment({ "jobs:create": "mutation" });
    const convex = createConvexClient({ ...base, fetchImpl: impl });
    await convex("jobs:create", {});
    await convex("jobs:create", {});
    expect(calls.length).toBe(3);
    expect(calls[2].url).toContain("/api/mutation");
  });

  it("shares a caller-supplied cache, so another transport's discovery counts", async () => {
    const kindCache = new Map([["jobs:create", "mutation"]]);
    const { impl, calls } = fakeDeployment({ "jobs:create": "mutation" });
    const convex = createConvexClient({ ...base, fetchImpl: impl, kindCache });
    await convex("jobs:create", {});
    expect(calls.length).toBe(1);
  });

  it("throws a real function error instead of walking the other kinds", async () => {
    const { impl, calls } = fakeDeployment({});
    const convex = createConvexClient({ ...base, fetchImpl: impl });
    await expect(convex("jobs:nope", {})).rejects.toThrow("jobs:nope: Could not find function");
    expect(calls.length).toBe(1);
  });

  it("injects the service key, and never overwrites one the caller passed", async () => {
    const { impl, calls } = fakeDeployment({ a: "query", b: "query" });
    const convex = createConvexClient({ ...base, fetchImpl: impl, serviceKey: "sk" });
    await convex("a", {});
    await convex("b", { serviceKey: "explicit" });
    expect(calls[0].body.args.serviceKey).toBe("sk");
    expect(calls[1].body.args.serviceKey).toBe("explicit");
  });

  it("sends no key when none is configured", async () => {
    const { impl, calls } = fakeDeployment({ a: "query" });
    const convex = createConvexClient({ ...base, fetchImpl: impl });
    await convex("a", {});
    expect("serviceKey" in calls[0].body.args).toBe(false);
  });

  it("returns null rather than undefined when a handler returns nothing", async () => {
    const { impl } = fakeDeployment({ a: "query" });
    const convex = createConvexClient({ ...base, fetchImpl: impl });
    expect(await convex("a", {})).toBeNull();
  });

  it("falls back to the CLI when no deployment url resolved, still injecting the key", async () => {
    let seen: unknown;
    const convex = createConvexClient({
      ...base,
      url: null,
      serviceKey: "sk",
      cliFallback: async (_fn, args) => {
        seen = args;
        return "from-cli";
      },
    });
    expect(await convex("a", {})).toBe("from-cli");
    expect(seen).toEqual({ serviceKey: "sk" });
  });
});
