import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";

const convex = vi.hoisted(() => ({
  queries: new Map<string, unknown>(),
  mutate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (ref: never, args: unknown) => (args === "skip" ? undefined : convex.queries.get(getFunctionName(ref))),
    useMutation: () => convex.mutate,
    useAction: () => convex.mutate,
    usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: () => {} }),
  };
});
vi.mock("../src/shared/usage", () => ({ useUsageTracker: () => {} }));
vi.mock("@excalidraw/excalidraw", () => ({ Excalidraw: () => <div>Drawing canvas</div>, exportToBlob: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  convex.queries.clear();
  convex.queries.set("drawings:list", []);
  convex.queries.set("jobs:count", 0);
  convex.queries.set("jobs:newsletterStats", { count: 0, done: 0, elements: 0, byDate: [], bySource: {} });
});

describe("app shell", () => {
  it("opens capture with c, closes with Escape and does not steal input keystrokes", () => {
    render(<App />);
    fireEvent.keyDown(document.body, { key: "c" });
    expect(screen.getByRole("dialog", { name: "Add" })).toBeInTheDocument();
    const input = within(screen.getByRole("dialog", { name: "Add" })).getByRole("textbox");
    fireEvent.keyDown(input, { key: "c" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const filter = screen.getByPlaceholderText("Filter... (/)");
    fireEvent.keyDown(filter, { key: "c" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens with Cmd-K or Ctrl-K and returns to the list after Escape", () => {
    render(<App />);
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog", { name: "Search" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "Search" })).toBeInTheDocument();
  });

  it("captures a paste outside a field and leaves field pastes alone", () => {
    render(<App />);
    const clipboardData = { items: [], getData: () => "https://arxiv.org/abs/123" };
    fireEvent.paste(screen.getByPlaceholderText("Filter... (/)"), { clipboardData });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.paste(document.body, { clipboardData });
    expect(within(screen.getByRole("dialog", { name: "Add" })).getByRole("textbox")).toHaveValue(
      "https://arxiv.org/abs/123",
    );
    expect(screen.getByRole("button", { name: "Paper" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps phone navigation mounted for a deep-linked drawing and leaves Escape to its dialog", () => {
    window.history.replaceState(null, "", "/?d=d1");
    convex.queries.set("drawings:getById", { _id: "d1", title: "Sketch", elements: "[]" });
    render(<App />);
    expect(screen.getByText("Drawing canvas")).toBeInTheDocument();
    const tabs = screen.getByRole("navigation", { name: "Tabs" });
    fireEvent.click(within(tabs).getByRole("button", { name: "Search" }));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.getByText("Drawing canvas")).toBeInTheDocument();
    fireEvent.click(within(tabs).getByRole("button", { name: "Home" }));
    expect(screen.queryByText("Drawing canvas")).not.toBeInTheDocument();
    expect(window.location.search).not.toContain("d=");
  });

  it("folds stats by default and restores a date filter with stats expanded", () => {
    const first = render(<App />);
    expect(screen.getByRole("button", { name: "Stats" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "Stats" }));
    expect(screen.getByRole("button", { name: "Stats" })).toHaveAttribute("aria-expanded", "true");
    first.unmount();
    localStorage.clear();
    window.history.replaceState(null, "", "/?tab=paper&date=2026-10-14");
    render(<App />);
    expect(screen.getByRole("button", { name: /Stats/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps enabled section navigation and deep links intact", () => {
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Sections" });
    fireEvent.click(within(nav).getByText("Research"));
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("research");
    expect(within(nav).getByText("Research").closest("a")).toHaveAttribute("aria-current", "page");
  });
});
