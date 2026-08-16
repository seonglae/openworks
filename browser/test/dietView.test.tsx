import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DietView } from "../src/views/DietView";

// The Convex hooks throw without a provider, so the client module is swapped
// for fixtures keyed by the function name the `api` proxy resolves to
// ("diet:listByDate"). Each test sets the fixtures it needs.
const convex = vi.hoisted(() => ({
  queries: new Map<string, unknown>(),
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
      if (args === "skip") return undefined;
      const name = getFunctionName(ref);
      convex.lastArgs.set(name, args);
      return convex.queries.get(name);
    },
    useMutation: (ref: never) => convex.fn(getFunctionName(ref)),
  };
});

const DAY = "2024-03-15";

const entry = (over: Record<string, unknown> = {}) => ({
  _id: "e1",
  _creationTime: 1,
  date: DAY,
  status: "done",
  name: "Bibimbap",
  kcal: 620.4,
  protein: 25.6,
  carbs: 80.2,
  fat: 18.9,
  createdAt: 1,
  ...over,
});

const day = (entries: unknown[], totals = { kcal: 0, protein: 0, carbs: 0, fat: 0 }) =>
  convex.queries.set("diet:listByDate", { entries, totals });

const click = (el: Element) => act(async () => void fireEvent.click(el));

// Every test drives the picker to a fixed day, so nothing here depends on the
// wall clock or the machine's timezone.
const pickDay = (value = DAY) =>
  fireEvent.change(screen.getByDisplayValue(/^\d{4}-\d{2}-\d{2}$/), { target: { value } });

beforeEach(() => {
  convex.queries.clear();
  convex.lastArgs.clear();
  convex.fns.clear();
});

describe("diet day log", () => {
  it("waits for the day's log rather than calling it empty while it loads", () => {
    render(<DietView />);

    expect(screen.queryByText("no food logged for this day.")).not.toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });

  it("waits for the trend rather than calling it empty while it loads", () => {
    day([entry()], { kcal: 620.4, protein: 25.6, carbs: 80.2, fat: 18.9 });
    render(<DietView />);

    expect(screen.queryByText("no history yet.")).not.toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });

  it("says the day is empty when nothing was logged", () => {
    day([]);
    render(<DietView />);

    expect(screen.getByText("no food logged for this day.")).toBeInTheDocument();
  });

  it("renders one row per logged food, with rounded macros", () => {
    day([entry(), entry({ _id: "e2", name: "Miso soup", kcal: 84.2, protein: 6.1, carbs: 7.4, fat: 3.5 })]);
    render(<DietView />);

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Bibimbap")).toBeInTheDocument();
    expect(screen.getByText("620 kcal · P 26g · C 80g · F 19g")).toBeInTheDocument();
    expect(screen.getByText("84 kcal · P 6g · C 7g · F 4g")).toBeInTheDocument();
  });

  it("rounds the day's totals to whole units", () => {
    day([entry()], { kcal: 1234.6, protein: 88.4, carbs: 150.5, fat: 42.2 });
    render(<DietView />);

    expect(screen.getByText("1235")).toBeInTheDocument();
    expect(screen.getByText("88")).toBeInTheDocument();
    expect(screen.getByText("151")).toBeInTheDocument();
  });

  it("marks an entry the worker has not analyzed yet", () => {
    day([
      entry({
        name: undefined,
        status: "analyzing",
        kcal: undefined,
        protein: undefined,
        carbs: undefined,
        fat: undefined,
      }),
    ]);
    render(<DietView />);

    expect(screen.getByText("analyzing")).toBeInTheDocument();
    expect(screen.getByText("analyzing…")).toBeInTheDocument();
  });

  it("names an analyzed entry the model could not identify", () => {
    day([entry({ name: undefined, status: "done" })]);
    render(<DietView />);

    expect(screen.getByText("Unknown food")).toBeInTheDocument();
  });

  it("omits the macros the analyzer did not return", () => {
    day([entry({ protein: undefined, carbs: undefined, fat: undefined })]);
    render(<DietView />);

    expect(screen.getByText("620 kcal")).toBeInTheDocument();
  });

  it("deletes the entry its own delete button belongs to", async () => {
    day([entry(), entry({ _id: "e2", name: "Miso soup" })]);
    render(<DietView />);

    const second = screen.getAllByRole("listitem")[1];
    await click(within(second).getByRole("button", { name: "delete" }));

    expect(convex.fn("diet:remove")).toHaveBeenCalledWith({ entryId: "e2" });
  });

  it("logs a typed food name against the selected day and clears the box", async () => {
    day([]);
    render(<DietView />);
    pickDay();
    const box = screen.getByPlaceholderText("or type a food name…");
    fireEvent.change(box, { target: { value: "  Kimchi jjigae  " } });

    await click(screen.getByRole("button", { name: "+ log" }));

    expect(convex.fn("diet:createEntry")).toHaveBeenCalledWith({ date: DAY, name: "Kimchi jjigae" });
    expect(box).toHaveValue("");
  });

  it("refuses to log a blank food name", () => {
    day([]);
    render(<DietView />);

    expect(screen.getByRole("button", { name: "+ log" })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("or type a food name…"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "+ log" })).toBeDisabled();
  });

  it("reads the selected day and the 14 days ending on it", () => {
    day([]);
    render(<DietView />);

    pickDay();

    expect(convex.lastArgs.get("diet:listByDate")).toEqual({ date: DAY });
    expect(convex.lastArgs.get("diet:dailyTotals")).toEqual({ from: "2024-03-02", to: DAY });
  });

  it("says there is no trend until days have been logged", () => {
    day([]);
    convex.queries.set("diet:dailyTotals", []);
    render(<DietView />);

    expect(screen.getByText("no history yet.")).toBeInTheDocument();
  });

  it("draws one labelled bar per day of the trend", () => {
    day([]);
    convex.queries.set("diet:dailyTotals", [
      { date: "2024-03-14", kcal: 1800.4 },
      { date: "2024-03-15", kcal: 2200 },
    ]);
    render(<DietView />);

    expect(screen.getByTitle("2024-03-14: 1800 kcal")).toBeInTheDocument();
    expect(screen.getByTitle("2024-03-15: 2200 kcal")).toBeInTheDocument();
    expect(screen.getByText("03-14")).toBeInTheDocument();
  });
});
