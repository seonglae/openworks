import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobRow } from "../src/views/JobsView";

// Same shape as dietView.test.tsx: the Convex hooks need a provider, so the
// client module is swapped for fixtures keyed by the resolved function name.
const convex = vi.hoisted(() => ({
  queries: new Map<string, unknown>(),
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
    useQuery: (ref: never, args: unknown) => (args === "skip" ? undefined : convex.queries.get(getFunctionName(ref))),
    useMutation: (ref: never) => convex.fn(getFunctionName(ref)),
    useAction: (ref: never) => convex.fn(getFunctionName(ref)),
  };
});

const job = (over: Record<string, unknown> = {}) =>
  ({
    _id: "j1",
    _creationTime: 1,
    url: "",
    type: "newsletter",
    status: "pending",
    createdAt: 1,
    ...over,
  }) as never;

const row = (over: Record<string, unknown> = {}) => render(<JobRow job={job(over)} onContentClick={() => {}} />);

beforeEach(() => {
  convex.queries.clear();
  convex.fns.clear();
});

describe("job row label", () => {
  it("shows short pasted content whole, with no elision mark", () => {
    row({ content: "hi" });

    expect(screen.getByText("hi")).toBeInTheDocument();
    expect(screen.queryByText("hi…")).not.toBeInTheDocument();
  });

  it("marks the label elided once the content is longer than the window", () => {
    row({ content: "a".repeat(61) });

    expect(screen.getByText("a".repeat(60) + "…")).toBeInTheDocument();
  });

  it("never cuts an emoji in half at the window boundary", () => {
    // The emoji straddles code units 59-60, so a raw slice(0, 60) would leave
    // its lone high surrogate in the label.
    row({ content: "a".repeat(59) + "😀" + "tail" });

    expect(screen.getByText("a".repeat(59) + "…")).toBeInTheDocument();
    expect(screen.getByText(/…$/).textContent).not.toMatch(/[\uD800-\uDBFF]/);
  });

  it("flattens newlines so the preview stays on one line", () => {
    row({ content: "first\nsecond" });

    expect(screen.getByText("first second")).toBeInTheDocument();
  });

  it("falls back to a fixed label for an image-only job", () => {
    row({ imageId: "s1" });

    expect(screen.getByText("pasted image")).toBeInTheDocument();
  });
});
