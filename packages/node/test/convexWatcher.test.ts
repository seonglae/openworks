import { describe, expect, it } from "vitest";
import { createConvexWatcher, type WatchClient } from "../src/convexWatcher.ts";

type Sub = {
  query: unknown;
  args: Record<string, unknown>;
  cb: (v: unknown) => unknown;
  onError?: (e: Error) => unknown;
};

// Stands in for the websocket client, so these tests exercise the wrapper's
// own logic (key injection, error routing, unsubscribe) without a socket.
function fakeClient() {
  const subs: Sub[] = [];
  let closed = false;
  const impl: WatchClient = {
    onUpdate(query, args, cb, onError) {
      const sub: Sub = { query, args, cb, onError };
      subs.push(sub);
      return () => {
        subs.splice(subs.indexOf(sub), 1);
      };
    },
    async close() {
      closed = true;
    },
  };
  return { impl, subs, isClosed: () => closed };
}

const base = { url: "https://x.convex.cloud" };

describe("createConvexWatcher", () => {
  it("injects the service key, and never overwrites one the caller passed", () => {
    const { impl, subs } = fakeClient();
    const w = createConvexWatcher({ ...base, serviceKey: "sk", clientImpl: impl });
    w.watch("jobs:getAllPending", {}, () => {});
    w.watch("jobs:getAllPending", { serviceKey: "explicit" }, () => {});
    expect(subs[0].args.serviceKey).toBe("sk");
    expect(subs[1].args.serviceKey).toBe("explicit");
  });

  it("sends no key when none is configured", () => {
    const { impl, subs } = fakeClient();
    const w = createConvexWatcher({ ...base, clientImpl: impl });
    w.watch("jobs:getAllPending", {}, () => {});
    expect("serviceKey" in subs[0].args).toBe(false);
  });

  it("delivers each result change to the caller", () => {
    const { impl, subs } = fakeClient();
    const w = createConvexWatcher({ ...base, clientImpl: impl });
    const seen: unknown[] = [];
    w.watch("jobs:getAllPending", {}, (v) => seen.push(v));
    subs[0].cb([]);
    subs[0].cb([{ _id: "j1" }]);
    expect(seen).toEqual([[], [{ _id: "j1" }]]);
  });

  it("unsubscribing stops delivery", () => {
    const { impl, subs } = fakeClient();
    const w = createConvexWatcher({ ...base, clientImpl: impl });
    const un = w.watch("jobs:getAllPending", {}, () => {});
    expect(subs.length).toBe(1);
    un();
    expect(subs.length).toBe(0);
  });

  // Without an error callback the real client throws inside the socket's
  // message handler, which is an uncatchable crash for the worker. The
  // wrapper must always pass one.
  it("routes a query error to onError instead of throwing", () => {
    const { impl, subs } = fakeClient();
    const errors: string[] = [];
    const w = createConvexWatcher({
      ...base,
      clientImpl: impl,
      onError: (fn, e) => errors.push(`${fn}: ${e.message}`),
    });
    w.watch("jobs:getAllPending", {}, () => {});
    expect(subs[0].onError).toBeTypeOf("function");
    subs[0].onError?.(new Error("auth required"));
    expect(errors).toEqual(["jobs:getAllPending: auth required"]);
  });

  it("still supplies an error callback when the caller registered no handler", () => {
    const { impl, subs } = fakeClient();
    const w = createConvexWatcher({ ...base, clientImpl: impl });
    w.watch("jobs:getAllPending", {}, () => {});
    expect(subs[0].onError).toBeTypeOf("function");
    expect(() => subs[0].onError?.(new Error("boom"))).not.toThrow();
  });

  // No deployment url means no socket, and the caller has to keep its
  // interval rather than silently discovering nothing.
  it("reports not live and no-ops when no url resolved", () => {
    const w = createConvexWatcher({ url: null });
    expect(w.live).toBe(false);
    let fired = false;
    const un = w.watch("jobs:getAllPending", {}, () => {
      fired = true;
    });
    un();
    expect(fired).toBe(false);
  });

  it("closes the underlying client", async () => {
    const { impl, isClosed } = fakeClient();
    const w = createConvexWatcher({ ...base, clientImpl: impl });
    await w.close();
    expect(isClosed()).toBe(true);
  });
});
