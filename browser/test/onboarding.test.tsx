import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const convex = vi.hoisted(() => ({
  calls: [] as [string, unknown][],
  settings: {} as Record<string, unknown>,
}));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  const name = (ref: unknown) => getFunctionName(ref as never);
  return {
    useQuery: (ref: unknown) =>
      name(ref) === "settings:get" ? convex.settings : name(ref) === "connectors:list" ? [] : null,
    useMutation: (ref: unknown) => async (args: unknown) => void convex.calls.push([name(ref), args]),
    useAction: () => async () => null,
  };
});

import { Onboarding } from "../src/Onboarding";

const fresh = () => ({
  _id: null,
  tabs: [
    { key: "article", enabled: true },
    { key: "vocab", enabled: false },
  ],
  onboarding: undefined,
});

const click = async (text: string) => {
  await act(async () => {
    fireEvent.click(screen.getByText(text));
  });
};

afterEach(() => {
  convex.calls = [];
  window.history.replaceState(null, "", "/");
});

describe("the first-run onboarding", () => {
  it("asks the language first, then what comes in and goes out, connects those, then which tabs to keep", async () => {
    convex.settings = fresh();
    render(<Onboarding />);
    expect(screen.getByText("Language")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getAllByText("한국어")[0]);
    });
    expect(convex.calls.at(-1)).toEqual(["settings:setUiLanguage", { uiLanguage: "ko" }]);
    await act(async () => {
      fireEvent.click(screen.getAllByText("日本語")[0]);
    });
    expect(convex.calls.at(-1)).toEqual(["settings:setLanguage", { language: "ja" }]);
    await click("Next");

    expect(screen.getByText("What comes in?")).toBeTruthy();
    await click("Gmail");
    await click("Next");
    expect(convex.calls.at(-1)).toEqual(["settings:saveOnboarding", { inputs: ["links", "gmail"], outputs: [] }]);

    expect(screen.getByText("Where does it go?")).toBeTruthy();
    await click("Notion");
    await click("Next");
    expect(screen.getByText("Sign in with Notion")).toBeTruthy();
    expect(screen.getByText("gws auth login")).toBeTruthy();

    await click("Next");
    await click("Vocab");
    expect(convex.calls.at(-1)).toEqual([
      "settings:setTabs",
      {
        tabs: [
          { key: "article", enabled: true },
          { key: "vocab", enabled: true },
        ],
      },
    ]);
    await click("Start");
    expect(convex.calls.at(-1)).toEqual([
      "settings:saveOnboarding",
      { inputs: ["links", "gmail"], outputs: ["notion"], done: true },
    ]);
  });

  it("speaks the language the deployment is set to", () => {
    convex.settings = { ...fresh(), uiLanguage: "ko" };
    render(<Onboarding />);
    expect(screen.getByText("언어")).toBeTruthy();
    expect(screen.getByText("다음")).toBeTruthy();
  });

  it("resumes at the connect step when a Notion sign-in returns", async () => {
    convex.settings = { ...fresh(), onboarding: { inputs: ["links"], outputs: ["notion"] } };
    window.history.replaceState(null, "", "/?connector=notion");
    render(<Onboarding />);
    expect(screen.getByRole("heading", { name: "Connect" })).toBeTruthy();
    expect(window.location.search).toBe("");
  });
});
