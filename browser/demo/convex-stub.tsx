import type { ReactNode } from "react";
import { getFunctionName } from "convex/server";
import { paginated, queries } from "./fixtures";

// The demo build swaps this in for `convex/react`, so the app runs with no
// deployment behind it. Every hook the shell and the views use is answered
// from fixtures keyed by the function name the `api` proxy resolves to, which
// is the same trick the component tests use. Anything not in the fixture map
// returns undefined, which every view already treats as "still loading" and
// renders its own empty state for.

export function useQuery(ref: never, args?: unknown) {
  if (args === "skip") return undefined;
  return queries[getFunctionName(ref)];
}

export function usePaginatedQuery(ref: never, args?: unknown) {
  const results = args === "skip" ? [] : (paginated[getFunctionName(ref)] ?? []);
  return { results, status: "Exhausted", isLoading: false, loadMore: () => {} };
}

const noop = async () => undefined;

export const useMutation = () => noop;
export const useAction = () => noop;
export const useConvex = () => ({ query: noop, mutation: noop, action: noop });
export const useConvexAuth = () => ({ isLoading: false, isAuthenticated: true });

export function ConvexProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export class ConvexReactClient {}
