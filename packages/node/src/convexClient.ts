// The Convex HTTP API needs to know whether a function is a query, a mutation
// or an action, but callers only have its path. Both workers solved that the
// same way and kept separate copies: try the kind that worked last time, and on
// a "defined as X" error walk the other two. Anything else is a real function
// error. The copies had already drifted on their timeout, so that stays a
// parameter rather than being unified into one number.

export type ConvexResult = { status: string; value?: unknown; errorMessage?: string };

export type ConvexClientOptions = {
  // null when no deployment URL could be resolved, which sends every call
  // through cliFallback instead.
  url: string | null;
  serviceKey?: string;
  timeoutMs: number;
  // Used when url is null. Each worker spawns the convex CLI differently, so
  // the caller supplies it.
  cliFallback: (fn: string, args: unknown) => Promise<unknown>;
  // Shared with a caller's other transport so one path's discovery primes the
  // other's, saving a probe request per function.
  kindCache?: Map<string, string>;
  fetchImpl?: typeof fetch;
};

const KINDS = ["query", "mutation", "action"];

// The server says this when the path exists but was called on the wrong
// endpoint. It is the only error that means "try another kind".
const WRONG_KIND = /defined as (Query|Mutation|Action)/i;

export function createConvexClient(opts: ConvexClientOptions) {
  const kindOf = opts.kindCache ?? new Map<string, string>();
  const doFetch = opts.fetchImpl ?? fetch;

  return async function convex(fn: string, args: Record<string, unknown> = {}): Promise<unknown> {
    // Callers reach the anonymous HTTP API, never a Clerk session, so the
    // single-owner key is what clears requireOwner. An explicit key wins.
    const withKey =
      opts.serviceKey && args && typeof args === "object" && args.serviceKey == null
        ? { ...args, serviceKey: opts.serviceKey }
        : args;

    if (!opts.url) return await opts.cliFallback(fn, withKey);

    const first = kindOf.get(fn) ?? "query";
    let lastError = "";
    for (const kind of [first, ...KINDS.filter((k) => k !== first)]) {
      const res = await doFetch(`${opts.url}/api/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: fn, args: withKey, format: "json" }),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      const body = (await res.json()) as ConvexResult;
      if (body.status === "success") {
        kindOf.set(fn, kind);
        return body.value ?? null;
      }
      lastError = body.errorMessage ?? "unknown convex error";
      if (!WRONG_KIND.test(lastError)) throw new Error(`${fn}: ${lastError}`);
    }
    throw new Error(`${fn}: ${lastError}`);
  };
}
