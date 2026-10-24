import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureSheet } from "../src/shared/shell/CaptureSheet";
import { CommandPalette } from "../src/shared/shell/CommandPalette";
import { Rail } from "../src/shared/shell/Rail";
import { TabBar } from "../src/shared/shell/TabBar";
import { MODES } from "../src/shared/modes";
import { captureKindFor, guessKind } from "../src/shared/shell/capture";

const convex = vi.hoisted(() => ({
  calls: new Map<string, ReturnType<typeof vi.fn>>(),
  search: vi.fn(),
}));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (ref: never, args: unknown) => (args === "skip" ? undefined : convex.search(getFunctionName(ref), args)),
    useMutation: (ref: never) => {
      const name = getFunctionName(ref);
      if (!convex.calls.has(name)) convex.calls.set(name, vi.fn().mockResolvedValue(undefined));
      return convex.calls.get(name);
    },
  };
});

beforeEach(() => {
  convex.calls.clear();
  convex.search.mockReset().mockReturnValue([]);
  vi.restoreAllMocks();
});
const hrefFor = (mode: string) => `https://example.test/?tab=${mode}`;
const palette = (props = {}) => {
  const handlers = {
    onClose: vi.fn(),
    onMode: vi.fn(),
    onCapture: vi.fn(),
    onSettings: vi.fn(),
    onDraw: vi.fn(),
    onOpen: vi.fn(),
  };
  const view = render(<CommandPalette modes={MODES} hrefFor={hrefFor} {...handlers} {...props} />);
  return { ...handlers, ...view };
};

describe("capture", () => {
  it("recognizes paper hosts without matching lookalikes", () => {
    expect(guessKind(" https://arxiv.org/abs/1", "article")).toBe("paper");
    expect(guessKind("https://doi.org/10.1/x", "newsletter")).toBe("paper");
    expect(guessKind("https://arxiv.org.example.com/abs/1", "article")).toBe("article");
    expect(captureKindFor("authors")).toBe("article");
    expect(captureKindFor("insights")).toBe("insight");
  });

  it("seeds pasted text, detects paper type, and routes to the existing create mutation", async () => {
    const done = vi.fn();
    render(
      <CaptureSheet
        seed={{ text: "https://arxiv.org/abs/123" }}
        defaultKind="article"
        onClose={() => {}}
        onDone={done}
      />,
    );
    expect(screen.getByRole("button", { name: "Paper" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Process" }));
    await waitFor(() => expect(done).toHaveBeenCalledWith("paper"));
    expect(convex.calls.get("jobs:create")).toHaveBeenCalledWith({ url: "https://arxiv.org/abs/123", type: "paper" });
  });

  it("creates one job per pasted URL and waits for all of them", async () => {
    const done = vi.fn();
    render(
      <CaptureSheet
        seed={{ text: "https://one.test, https://two.test" }}
        defaultKind="newsletter"
        onClose={() => {}}
        onDone={done}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Process" }));
    await waitFor(() => expect(done).toHaveBeenCalledWith("newsletter"));
    expect(convex.calls.get("jobs:create")?.mock.calls).toEqual([
      [{ url: "https://one.test", type: "newsletter" }],
      [{ url: "https://two.test", type: "newsletter" }],
    ]);
  });

  it("keeps insight input on the insights API", async () => {
    const done = vi.fn();
    render(
      <CaptureSheet
        seed={{ text: "A quote\n\nAnother quote" }}
        defaultKind="insight"
        onClose={() => {}}
        onDone={done}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Process" }));
    await waitFor(() => expect(done).toHaveBeenCalledWith("insight"));
    expect(convex.calls.get("insights:add")).toHaveBeenCalledWith({ raw: "A quote\n\nAnother quote" });
    expect(convex.calls.get("jobs:create")).not.toHaveBeenCalled();
  });

  it("keeps the sheet and input when a mutation fails, then allows retry", async () => {
    const done = vi.fn();
    render(<CaptureSheet seed={{ text: "My article" }} defaultKind="article" onClose={() => {}} onDone={done} />);
    convex.calls.get("jobs:create")!.mockRejectedValueOnce(new Error("Unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Process" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unavailable");
    expect(screen.getByRole("textbox")).toHaveValue("My article");
    expect(done).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Process" }));
    await waitFor(() => expect(done).toHaveBeenCalledWith("article"));
  });

  it("uploads pasted screenshots to the selected destination", async () => {
    const file = new File(["image"], "shot.png", { type: "image/png" });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:shot");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const upload = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ storageId: "s1" })));
    const done = vi.fn();
    render(<CaptureSheet seed={{ files: [file] }} defaultKind="article" onClose={() => {}} onDone={done} />);
    convex.calls.get("jobs:generateUploadUrl")!.mockResolvedValue("https://upload.test");
    fireEvent.click(screen.getByRole("button", { name: "Process" }));
    await waitFor(() => expect(done).toHaveBeenCalledWith("article"));
    expect(upload).toHaveBeenCalledWith("https://upload.test", expect.objectContaining({ method: "POST", body: file }));
    expect(convex.calls.get("jobs:create")).toHaveBeenCalledWith({ url: "", type: "article", imageIds: ["s1"] });
  });

  it("restores focus and scrolling after Escape", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const close = vi.fn();
    const view = render(<CaptureSheet seed={{}} defaultKind="article" onClose={close} onDone={() => {}} />);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
    view.unmount();
    expect(trigger).toHaveFocus();
    expect(document.body.style.overflow).toBe("");
    trigger.remove();
  });
});

describe("command palette", () => {
  it("navigates by keyboard using the visible OpenWorks sections", () => {
    const handlers = palette({ modes: MODES.filter((m) => m.key === "research") });
    const input = screen.getByRole("combobox");
    expect(input).toHaveFocus();
    expect(screen.queryByRole("option", { name: "Diet" })).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(handlers.onMode).toHaveBeenCalledWith("research");
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it("runs an action after filtering with the keyboard", () => {
    const handlers = palette();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Settings" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(handlers.onSettings).toHaveBeenCalledOnce();
  });

  it("searches existing job indexes, previews the result and opens its deep link", async () => {
    convex.search.mockImplementation((name, args) =>
      name === "jobs:searchWithContent" && args.type === "paper"
        ? [{ _id: "j1", type: "paper", title: "Attention paper", tldr: ["A short preview"] }]
        : [],
    );
    const handlers = palette();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Attention" } });
    const result = await screen.findByRole("option", { name: "Attention paper Paper" });
    fireEvent.mouseEnter(result);
    expect(screen.getByText("A short preview")).toBeInTheDocument();
    expect(result).toHaveAttribute("href", "https://example.test/?tab=paper&item=j1");
    fireEvent.click(result);
    expect(handlers.onOpen).toHaveBeenCalledWith("j1", "paper");
    expect(convex.search).toHaveBeenCalledWith("jobs:searchWithContent", {
      type: "paper",
      query: "Attention",
      limit: 8,
    });
  });
});

describe("navigation", () => {
  it("renders enabled sections as links and preserves modifier clicks", () => {
    const select = vi.fn();
    render(
      <Rail
        modes={MODES}
        active="paper"
        tabHref={hrefFor}
        onSelect={select}
        onCapture={() => {}}
        onSearch={() => {}}
        onHome={() => {}}
        open={false}
        onClose={() => {}}
        footer={null}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Sections" });
    const paper = within(nav).getByText("Paper").closest("a")!;
    expect(paper).toHaveAttribute("aria-current", "page");
    expect(paper).toHaveAttribute("href", hrefFor("paper"));
    fireEvent.click(paper, { ctrlKey: true });
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(paper);
    expect(select).toHaveBeenCalledWith("paper");
    for (const section of MODES) expect(within(nav).getByText(section.label)).toBeInTheDocument();
    expect(screen.queryByText("Friends")).not.toBeInTheDocument();
  });

  it("keeps phone navigation available while drawing", () => {
    const home = vi.fn();
    const menu = vi.fn();
    render(
      <TabBar onHome={home} onMenu={menu} onSearch={() => {}} onCapture={() => {}} onDraw={() => {}} active="draw" />,
    );
    expect(screen.getByRole("button", { name: "Draw" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(home).toHaveBeenCalledOnce();
    expect(menu).toHaveBeenCalledOnce();
  });
});
