import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VocabView } from "../src/views/VocabView";

// The Convex hooks throw without a provider, so the client module is swapped
// for fixtures keyed by the function name the `api` proxy resolves to
// ("expressions:due"). Each test sets the fixtures it needs.
const convex = vi.hoisted(() => ({
  queries: new Map<string, unknown>(),
  queryArgs: new Map<string, unknown>(),
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
      convex.queryArgs.set(name, args);
      return convex.queries.get(name);
    },
    useMutation: (ref: never) => convex.fn(getFunctionName(ref)),
    useAction: (ref: never) => convex.fn(getFunctionName(ref)),
  };
});

const card = (over: Record<string, unknown> = {}) => ({
  _id: "x1",
  _creationTime: 1,
  en: "break the ice",
  jp: "打ち解ける",
  reading: "uchitokeru",
  meaning: "get past the awkward opening",
  example: "He told a joke to break the ice.",
  due: "2024-03-15",
  intervalDays: 1,
  reps: 2,
  ease: 250,
  createdAt: 1,
  ...over,
});

const due = (cards: unknown[], total = cards.length) =>
  convex.queries.set("expressions:due", { due: cards, dueCount: cards.length, total });

const listAll = (cards: unknown[]) => convex.queries.set("expressions:list", cards);

const click = (el: Element) => act(async () => void fireEvent.click(el));
const type = (el: Element, value: string) => fireEvent.change(el, { target: { value } });

const section = (summary: string) => screen.getByText(summary).closest("details") as HTMLDetailsElement;

beforeEach(() => {
  convex.queries.clear();
  convex.queryArgs.clear();
  convex.fns.clear();
  localStorage.clear();
  due([]);
  listAll([]);
});

afterEach(() => vi.unstubAllGlobals());

describe("vocab review queue", () => {
  it("reports how much of the deck is due", () => {
    due([card(), card({ _id: "x2" })], 12);
    render(<VocabView />);

    expect(screen.getByText("2 due · 12 total")).toBeInTheDocument();
  });

  it("cannot start a review with nothing due", () => {
    render(<VocabView />);

    expect(screen.getByRole("button", { name: "start review" })).toBeDisabled();
  });

  it("shows the Japanese side first and keeps the answer hidden", async () => {
    due([card()]);
    render(<VocabView />);

    await click(screen.getByRole("button", { name: "start review" }));

    expect(screen.getByText("打ち解ける")).toBeInTheDocument();
    expect(screen.queryByText("break the ice")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "good" })).not.toBeInTheDocument();
  });

  it("prompts with the English side for a card that has no Japanese", async () => {
    due([card({ jp: undefined })]);
    render(<VocabView />);

    await click(screen.getByRole("button", { name: "start review" }));

    expect(screen.getByText("break the ice")).toBeInTheDocument();
  });

  it("reveals every filled field of the card on demand", async () => {
    due([card()]);
    render(<VocabView />);
    await click(screen.getByRole("button", { name: "start review" }));

    await click(screen.getByRole("button", { name: "show answer" }));

    expect(screen.getByText("break the ice")).toBeInTheDocument();
    expect(screen.getByText("uchitokeru")).toBeInTheDocument();
    expect(screen.getByText("get past the awkward opening")).toBeInTheDocument();
    expect(screen.getByText("He told a joke to break the ice.")).toBeInTheDocument();
  });

  it("grades the shown card and hides the answer again", async () => {
    due([card()]);
    render(<VocabView />);
    await click(screen.getByRole("button", { name: "start review" }));
    await click(screen.getByRole("button", { name: "show answer" }));

    await click(screen.getByRole("button", { name: "good" }));

    expect(convex.fn("expressions:review")).toHaveBeenCalledWith({
      id: "x1",
      grade: "good",
      today: expect.any(String),
    });
    expect(screen.getByRole("button", { name: "show answer" })).toBeInTheDocument();
  });

  it("says the queue is clear once the last due card is graded", async () => {
    due([card()]);
    const { rerender } = render(<VocabView />);
    await click(screen.getByRole("button", { name: "start review" }));

    due([]);
    rerender(<VocabView />);

    expect(screen.getByText("All caught up. Nothing due.")).toBeInTheDocument();
  });
});

describe("vocab deck", () => {
  it("lists every expression with its next review day", () => {
    listAll([card(), card({ _id: "x2", en: "call it a day", jp: undefined, due: "2024-04-02" })]);
    render(<VocabView />);

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("due 03-15")).toBeInTheDocument();
    expect(screen.getByText("due 04-02")).toBeInTheDocument();
  });

  // `jp` is written by the worker from `en`, so a row led by the Japanese put a
  // generated field above the entry it came from, and an English deck read as
  // a Japanese one.
  it("leads each row with the English entry, not the translation of it", () => {
    listAll([card()]);
    render(<VocabView />);

    const row = screen.getAllByRole("listitem")[0].textContent ?? "";
    expect(row.indexOf("break the ice")).toBeLessThan(row.indexOf("打ち解ける"));
  });

  it("marks only the expressions the worker is still enriching", () => {
    listAll([card({ pendingEnrich: true }), card({ _id: "x2", en: "call it a day" })]);
    render(<VocabView />);

    expect(screen.getAllByText("enriching…")).toHaveLength(1);
  });

  it("deletes the expression its own del button belongs to", async () => {
    listAll([card(), card({ _id: "x2", en: "call it a day" })]);
    render(<VocabView />);

    await click(within(screen.getAllByRole("listitem")[1]).getByRole("button", { name: "del" }));

    expect(convex.fn("expressions:remove")).toHaveBeenCalledWith({ id: "x2" });
  });

  it("adds an expression with only the fields that were filled in", async () => {
    render(<VocabView />);
    type(screen.getByPlaceholderText("English"), "  call it a day  ");
    type(screen.getByPlaceholderText("meaning / note"), "stop working for today");

    await click(screen.getByRole("button", { name: "+ add expression" }));

    expect(convex.fn("expressions:add")).toHaveBeenCalledWith({
      en: "call it a day",
      jp: undefined,
      reading: undefined,
      meaning: "stop working for today",
      example: undefined,
      today: expect.any(String),
    });
    expect(screen.getByPlaceholderText("English")).toHaveValue("");
  });

  it("refuses to add an expression with no English side", () => {
    render(<VocabView />);

    expect(screen.getByRole("button", { name: "+ add expression" })).toBeDisabled();
    type(screen.getByPlaceholderText("English"), "   ");
    expect(screen.getByRole("button", { name: "+ add expression" })).toBeDisabled();
  });

  it("bulk imports one expression per line, skipping blank lines", async () => {
    render(<VocabView />);
    const bulk = section("bulk import");
    type(
      within(bulk).getByPlaceholderText(/one per line/),
      "call it a day\n\nbreak the ice | 打ち解ける | get past it\n",
    );

    await click(within(bulk).getByRole("button", { name: "import" }));

    const add = convex.fn("expressions:add");
    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenNthCalledWith(1, {
      en: "call it a day",
      jp: undefined,
      meaning: undefined,
      today: expect.any(String),
    });
    expect(add).toHaveBeenNthCalledWith(2, {
      en: "break the ice",
      jp: "打ち解ける",
      meaning: "get past it",
      today: expect.any(String),
    });
    expect(await within(bulk).findByText("imported 2")).toBeInTheDocument();
  });

  it("reports a line it dropped for having no English side as skipped", async () => {
    render(<VocabView />);
    const bulk = section("bulk import");
    type(within(bulk).getByPlaceholderText(/one per line/), "| 打ち解ける | get past it");

    await click(within(bulk).getByRole("button", { name: "import" }));

    expect(convex.fn("expressions:add")).not.toHaveBeenCalled();
    expect(await within(bulk).findByText("imported 0, skipped 1 with no English side")).toBeInTheDocument();
  });

  it("counts only the lines that landed when some are dropped", async () => {
    render(<VocabView />);
    const bulk = section("bulk import");
    type(within(bulk).getByPlaceholderText(/one per line/), "call it a day\n| 打ち解ける | get past it");

    await click(within(bulk).getByRole("button", { name: "import" }));

    expect(convex.fn("expressions:add")).toHaveBeenCalledTimes(1);
    expect(await within(bulk).findByText("imported 1, skipped 1 with no English side")).toBeInTheDocument();
  });
});

describe("vocab notion sync", () => {
  it("prefills the saved database id and exports to it", async () => {
    convex.queries.set("settings:get", { notion: { databaseId: "db-1" } });
    convex.fn("notion:exportVocab").mockResolvedValue({ count: 7 });
    render(<VocabView />);
    expect(screen.getByPlaceholderText("Notion database id")).toHaveValue("db-1");

    await click(screen.getByRole("button", { name: "export to Notion" }));

    expect(convex.fn("settings:setNotion")).toHaveBeenCalledWith({ databaseId: "db-1" });
    expect(convex.fn("notion:exportVocab")).toHaveBeenCalledWith({ databaseId: "db-1" });
    expect(await screen.findByText("exported 7 to Notion")).toBeInTheDocument();
  });

  it("keeps the database count singular when one database was imported", async () => {
    convex.fn("notion:importVocabFromNotion").mockResolvedValue({
      imported: 3,
      databases: 1,
      found: 5,
      truncated: false,
    });
    render(<VocabView />);
    const panel = section("import from notion");
    type(within(panel).getByPlaceholderText(/Notion page or database/), "page-1");

    await click(within(panel).getByRole("button", { name: "import" }));

    expect(convex.fn("notion:importVocabFromNotion")).toHaveBeenCalledWith({ pageId: "page-1" });
    expect(await within(panel).findByText("imported 3 new from 1 db (5 found)")).toBeInTheDocument();
  });

  it("surfaces a failed Notion import instead of staying silent", async () => {
    convex.fn("notion:importVocabFromNotion").mockRejectedValue(new Error("unauthorized"));
    render(<VocabView />);
    const panel = section("import from notion");
    type(within(panel).getByPlaceholderText(/Notion page or database/), "page-1");

    await click(within(panel).getByRole("button", { name: "import" }));

    expect(await within(panel).findByText("error: unauthorized")).toBeInTheDocument();
  });
});

describe("vocab due reminders", () => {
  const stubNotification = (permission: string, asked: string) => {
    const fired = vi.fn();
    class NotificationStub {
      static permission = permission;
      static requestPermission = async () => asked;
      constructor(title: string, opts: { body: string }) {
        fired(title, opts.body);
      }
    }
    vi.stubGlobal("Notification", NotificationStub);
    return fired;
  };

  it("stays off when the browser refuses notification permission", async () => {
    stubNotification("default", "denied");
    due([card()]);
    render(<VocabView />);

    await click(screen.getByRole("button", { name: "remind me" }));

    expect(screen.getByRole("button", { name: "remind me" })).toBeInTheDocument();
    expect(localStorage.getItem("vocab:remind")).toBeNull();
  });

  it("announces the due count and remembers the choice once permitted", async () => {
    const fired = stubNotification("granted", "granted");
    due([card(), card({ _id: "x2" })]);
    render(<VocabView />);

    await click(screen.getByRole("button", { name: "remind me" }));

    expect(screen.getByRole("button", { name: /reminders on/ })).toBeInTheDocument();
    expect(localStorage.getItem("vocab:remind")).toBe("1");
    expect(fired).toHaveBeenCalledWith("Openworks vocab", "2 expressions due for review");
  });
});

describe("vocab day boundary", () => {
  // 20:00Z is 05:00 the next morning in Seoul: the nine hours a day where the
  // server's UTC day and the user's day name different dates. Only Date is
  // faked so testing-library's waitFor keeps its real timers.
  const EVENING_IN_UTC = "2026-03-08T20:00:00Z";
  const SEOUL_DAY = "2026-03-09";
  const originalTz = process.env.TZ;

  beforeEach(() => {
    process.env.TZ = "Asia/Seoul";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(EVENING_IN_UTC));
    // Guards the frozen clock and that tzdata is loaded: without a real
    // Asia/Seoul node answers in UTC and these cases would pass for the wrong
    // reason.
    expect([new Date().toISOString().slice(0, 10), new Date().getHours()]).toEqual(["2026-03-08", 5]);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("asks for the cards due on the user's day, not the server's UTC day", () => {
    render(<VocabView />);

    expect(convex.queryArgs.get("expressions:due")).toEqual({ today: SEOUL_DAY });
  });

  it("schedules the next review from the user's day", async () => {
    due([card()]);
    render(<VocabView />);
    await click(screen.getByRole("button", { name: "start review" }));
    await click(screen.getByRole("button", { name: "show answer" }));

    await click(screen.getByRole("button", { name: "good" }));

    expect(convex.fn("expressions:review")).toHaveBeenCalledWith({ id: "x1", grade: "good", today: SEOUL_DAY });
  });

  it("captures a new expression on the user's day", async () => {
    render(<VocabView />);
    type(screen.getByPlaceholderText("English"), "call it a day");

    await click(screen.getByRole("button", { name: "+ add expression" }));

    expect(convex.fn("expressions:add")).toHaveBeenCalledWith(expect.objectContaining({ today: SEOUL_DAY }));
  });
});
