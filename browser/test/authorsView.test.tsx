import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorsView } from "../src/views/AuthorsView";

// The Convex hooks throw without a provider, so the client module is swapped
// for fixtures keyed by the function name the `api` proxy resolves to
// ("authors:leaderboard"). Each test sets the fixtures it needs.
const convex = vi.hoisted(() => ({
  queries: new Map<string, unknown>(),
  pages: new Map<string, { results: unknown[]; status: string }>(),
  lastArgs: new Map<string, unknown>(),
  fns: new Map<string, ReturnType<typeof vi.fn>>(),
  fn(name: string) {
    const known = this.fns.get(name);
    if (known) return known;
    const created = vi.fn();
    this.fns.set(name, created);
    return created;
  },
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (ref: never, args: unknown) => {
      const name = getFunctionName(ref);
      convex.lastArgs.set(name, args);
      return convex.queries.get(name);
    },
    useMutation: (ref: never) => convex.fn(getFunctionName(ref)),
    usePaginatedQuery: (ref: never, args: unknown) => {
      const name = getFunctionName(ref);
      convex.lastArgs.set(name, args);
      const page = convex.pages.get(name) ?? { results: [], status: "Exhausted" };
      // loadMore identity has to be stable: useInfiniteScroll keys an effect on it.
      return { ...page, isLoading: page.status.startsWith("Loading"), loadMore: convex.fn(`loadMore:${name}`) };
    },
  };
});

const author = (over: Record<string, unknown> = {}) => ({
  authorId: "A1",
  name: "Ada Lovelace",
  institution: "Analytical Engine Lab",
  firstCount: 3,
  lastCount: 2,
  paperCount: 7,
  scoreFirst: 8.25,
  scoreLast: 7.5,
  scoreAll: 6.125,
  scoredFirst: 2,
  scoredLast: 1,
  scoredAll: 4,
  rawFirst: 8.4,
  rawLast: 7.2,
  rawAll: 6.6,
  ...over,
});

const leaderboard = (results: unknown[], status = "Exhausted") =>
  convex.pages.set("authors:leaderboard", { results, status });

const rowOf = (name: string | RegExp) => screen.getByRole("button", { name });

const click = (el: Element) => act(async () => void fireEvent.click(el));

beforeEach(() => {
  convex.queries.clear();
  convex.pages.clear();
  convex.lastArgs.clear();
  convex.fns.clear();
});

describe("authors leaderboard", () => {
  it("renders one row per author, numbered by rank", () => {
    leaderboard([author(), author({ authorId: "A2", name: "Grace Hopper" })]);
    render(<AuthorsView />);

    expect(within(rowOf(/Ada Lovelace/)).getByText("1")).toBeInTheDocument();
    expect(within(rowOf(/Grace Hopper/)).getByText("2")).toBeInTheDocument();
  });

  it("explains the empty corpus once the first page has loaded", () => {
    leaderboard([], "Exhausted");
    render(<AuthorsView />);

    expect(screen.getByText(/No authors yet/)).toBeInTheDocument();
    expect(screen.queryByText(/shown/)).not.toBeInTheDocument();
  });

  it("waits for the first page instead of claiming the corpus is empty", () => {
    leaderboard([], "LoadingFirstPage");
    render(<AuthorsView />);

    expect(screen.queryByText(/No authors yet/)).not.toBeInTheDocument();
    expect(screen.getByText("loading…")).toBeInTheDocument();
  });

  it("counts the loaded rows once the list is exhausted", () => {
    leaderboard([author(), author({ authorId: "A2", name: "Grace Hopper" })], "Exhausted");
    render(<AuthorsView />);

    expect(screen.getByText("2 shown")).toBeInTheDocument();
  });

  it("holds back the row count while more pages can load", () => {
    leaderboard([author()], "CanLoadMore");
    render(<AuthorsView />);

    expect(screen.queryByText(/shown/)).not.toBeInTheDocument();
  });

  it("shows the shrunk score of the ranked position by default", () => {
    leaderboard([author()]);
    render(<AuthorsView />);

    expect(within(rowOf(/Ada Lovelace/)).getByText("8.25")).toBeInTheDocument();
  });

  it("swaps the displayed number for the paper count when ranking by count", async () => {
    leaderboard([author()]);
    render(<AuthorsView />);

    await click(screen.getByRole("button", { name: "count" }));

    expect(within(rowOf(/Ada Lovelace/)).getByText("3")).toBeInTheDocument();
    expect(convex.lastArgs.get("authors:leaderboard")).toEqual({ position: "first", metric: "count" });
  });

  it("re-ranks by last authorship when corresponding is picked", async () => {
    leaderboard([author()]);
    render(<AuthorsView />);

    await click(screen.getByRole("button", { name: "corresponding" }));

    expect(convex.lastArgs.get("authors:leaderboard")).toEqual({ position: "last", metric: "score" });
    expect(within(rowOf(/Ada Lovelace/)).getByText("7.50")).toBeInTheDocument();
  });

  // The rule the view's own footnote states: identities are OpenAlex entities,
  // so a shared display name must never collapse two researchers into one row.
  it("keeps authors who share a display name as separate rows tagged by entity id", () => {
    leaderboard([
      author({ authorId: "A5023" }),
      author({ authorId: "A9917" }),
      author({ authorId: "A3", name: "Grace Hopper" }),
    ]);
    render(<AuthorsView />);

    expect(screen.getAllByText("Ada Lovelace")).toHaveLength(2);
    expect(screen.getByText("A5023")).toBeInTheDocument();
    expect(screen.getByText("A9917")).toBeInTheDocument();
    expect(screen.queryByText("A3")).not.toBeInTheDocument();
  });

  it("loads the author's papers only once the row is unfolded", async () => {
    leaderboard([author()]);
    convex.pages.set("authors:papersByAuthor", {
      results: [{ jobId: "j1", title: "On the Analytical Engine", position: "first", overall: 9 }],
      status: "Exhausted",
    });
    render(<AuthorsView />);
    expect(screen.queryByText("On the Analytical Engine")).not.toBeInTheDocument();

    await click(rowOf(/Ada Lovelace/));

    expect(screen.getByText("On the Analytical Engine")).toBeInTheDocument();
    expect(convex.lastArgs.get("authors:papersByAuthor")).toEqual({ authorId: "A1" });
    expect(screen.getByText("1st 3")).toBeInTheDocument();

    await click(rowOf(/Ada Lovelace/));
    expect(screen.queryByText("On the Analytical Engine")).not.toBeInTheDocument();
  });

  it("folds the open row away when the ranking axis changes under it", async () => {
    leaderboard([author()]);
    convex.pages.set("authors:papersByAuthor", {
      results: [{ jobId: "j1", title: "On the Analytical Engine", position: "first" }],
      status: "Exhausted",
    });
    render(<AuthorsView />);
    await click(rowOf(/Ada Lovelace/));

    await click(screen.getByRole("button", { name: "any author" }));

    expect(screen.queryByText("On the Analytical Engine")).not.toBeInTheDocument();
  });

  it("offers the resolve sweep only while authors are still unresolved", async () => {
    leaderboard([author()]);
    convex.queries.set("authors:resolveProgress", { total: 10, resolved: 6, pending: 4 });
    render(<AuthorsView />);

    await click(screen.getByRole("button", { name: "resolve 4 pending" }));

    expect(convex.fn("authors:startResolveSweep")).toHaveBeenCalledWith({});
  });

  it("hides the resolve sweep when nothing is pending", () => {
    leaderboard([author()]);
    convex.queries.set("authors:resolveProgress", { total: 10, resolved: 10, pending: 0 });
    render(<AuthorsView />);

    expect(screen.queryByRole("button", { name: /resolve/ })).not.toBeInTheDocument();
  });
});
