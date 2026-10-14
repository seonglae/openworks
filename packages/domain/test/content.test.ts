import { describe, expect, it } from "vitest";
import {
  contentInput,
  contentList,
  feedOutput,
  notionOutput,
  paperInput,
  screenshotInput,
  textProcessor,
  type Content,
  type ContentAdapter,
  type ContentList,
  type ContentSource,
} from "../src/index.ts";

const capture = () => contentInput.capture([{ id: "note-1", title: "A note", source: { kind: "text", text: "raw" } }]);

it("narrows every adapter stage without a shared parent class", () => {
  type Input = Parameters<typeof contentInput.capture>[0];
  type Output = ReturnType<ReturnType<typeof feedOutput>["prepare"]>;
  const inputs: Input = [{ id: "note-1", title: "A note", source: { kind: "text", text: "raw" } }];
  const contents = capture();
  function runStage(adapter: ContentAdapter<Input, Output>): ContentList | Output {
    switch (adapter.stage) {
      case "input":
        return adapter.capture(inputs);
      case "processing":
        return adapter.process(contents);
      case "output":
        return adapter.prepare(contents);
      default: {
        // A new stage fails the test-project typecheck until it is handled here.
        const exhaustive: never = adapter;
        return exhaustive;
      }
    }
  }
  expect(runStage(contentInput)).toEqual(contents);
  expect(runStage(textProcessor("local", "keep", (item) => item.text))).toMatchObject([{ id: "note-1", text: "raw" }]);
  expect(runStage(feedOutput("feed"))).toMatchObject({ kind: "feed", items: [{ id: "note-1" }] });
});

describe("runtime canonical-list validation", () => {
  it("copies only canonical fields instead of exporting unknown runtime properties", () => {
    const raw = {
      ...capture()[0],
      privateField: { secret: "must not be exported" },
      source: { kind: "text", text: "raw", privateField: "must not be exported" },
      processing: [{ processor: "local", operation: "keep", privateField: "must not be exported" }],
    } as unknown as Content;
    const expected = {
      ...capture()[0],
      processing: [{ processor: "local", operation: "keep" }],
    };
    expect(contentList([raw])).toEqual([expected]);
    expect(notionOutput("page").prepare([raw]).contents).toEqual([expected]);
    expect(JSON.stringify(feedOutput("feed").prepare([raw]))).not.toContain("must not be exported");
  });

  it("does not echo duplicate identifiers in errors", () => {
    const item = { ...capture()[0], id: "private identifier" };
    expect(() => contentList([item, item])).toThrowError(/^duplicate content id$/);
  });

  it.each([null, {}, "content", [null], new Array(1)])("rejects malformed list containers and entries", (value) => {
    expect(() => contentList(value as unknown as ContentList)).toThrowError(
      /^(contents must be an array|invalid content)$/,
    );
  });

  const invalidFields = [
    { title: null },
    { title: Promise.resolve("title") },
    { text: null },
    { text: 7 },
    { text: Promise.resolve("text") },
    { source: null },
    { source: [] },
    { source: { kind: "unknown", text: "private payload" } },
    { source: { kind: "text", text: " " } },
    { source: { kind: "link", url: "" } },
    { source: { kind: "paper", reference: "" } },
    { source: { kind: "screenshot", imageRef: "" } },
    { source: { kind: "link", url: "example", text: 7 } },
    { source: { kind: "screenshot", imageRef: "image", extractedText: false } },
    { completeness: "unknown" },
    { completeness: "reference-only" },
    { source: { kind: "paper", reference: "unread" } },
    { source: { kind: "paper", reference: "unread" }, completeness: "reference-only" },
    { processing: null },
    { processing: {} },
    { processing: [null] },
    { processing: new Array(1) },
    { processing: [{ processor: "", operation: "op" }] },
    { processing: [{ processor: "local", operation: 7 }] },
  ];

  it.each(invalidFields)("rejects malformed canonical records at direct export boundaries (%#)", (fields) => {
    const malformed = [{ ...capture()[0], ...fields }] as unknown as ContentList;
    for (const prepare of [notionOutput("page").prepare, feedOutput("feed").prepare]) {
      expect(() => prepare(malformed)).toThrowError();
      try {
        prepare(malformed);
      } catch (error) {
        expect(String(error)).not.toContain("private payload");
      }
    }
  });

  it("validates the entire input before running any transformation", () => {
    let calls = 0;
    const malformed = [...capture(), { ...capture()[0], id: "other", text: undefined }] as unknown as ContentList;
    expect(() =>
      textProcessor("local", "inspect", (item) => {
        calls++;
        return item.text;
      }).process(malformed),
    ).toThrow("content text");
    expect(calls).toBe(0);
  });

  it("does not confuse a deliberately empty result with missing source evidence", () => {
    const result = textProcessor("local", "clear", () => "").process(capture());
    expect(feedOutput("feed").prepare(result).items[0]).toMatchObject({
      content_text: "",
      completeness: "text-available",
      source: { kind: "text", text: "raw" },
    });
  });
});

describe("canonical content input", () => {
  it("captures text without modifying evidence", () => {
    expect(capture()[0]).toMatchObject({ text: "raw", completeness: "text-available", processing: [] });
  });
  it("keeps paper-only references explicit", () => {
    expect(paperInput.capture({ id: "p", reference: "doi:example" })[0]).toMatchObject({
      text: "",
      completeness: "reference-only",
    });
  });
  it("captures supplied paper text", () => {
    expect(paperInput.capture({ id: "p", reference: "doi:example", text: "paper text" })[0].text).toBe("paper text");
  });
  it("does not invent screenshot OCR", () => {
    expect(screenshotInput.capture({ id: "s", imageRef: "image.png" })[0].completeness).toBe("reference-only");
  });
  it("retains supplied OCR independently from the image locator", () => {
    const [item] = screenshotInput.capture({ id: "s", imageRef: "image.png", extractedText: "OCR" });
    expect(item).toMatchObject({ text: "OCR", source: { imageRef: "image.png", extractedText: "OCR" } });
  });
  it("captures links without fetching them", () => {
    expect(
      contentInput.capture([{ id: "l", source: { kind: "link", url: "https://example.com" } }])[0].completeness,
    ).toBe("reference-only");
  });
  it("rejects duplicate identities", () =>
    expect(() => contentList([...capture(), ...capture()])).toThrow("duplicate"));
  it("rejects empty identity", () =>
    expect(() => contentInput.capture([{ id: " ", source: { kind: "text", text: "x" } }])).toThrow("id"));
  it.each([
    { kind: "text", text: " " },
    { kind: "link", url: "" },
    { kind: "paper", reference: "" },
    { kind: "screenshot", imageRef: "" },
  ] satisfies ContentSource[])("rejects empty $kind evidence", (source) => {
    expect(() => contentInput.capture([{ id: "x", source }])).toThrow();
  });
  it("rejects unknown runtime discriminants", () => {
    expect(() => contentInput.capture([{ id: "v", source: { kind: "video" } as unknown as ContentSource }])).toThrow(
      "unsupported",
    );
  });
  it("snapshots caller objects and freezes nested evidence", () => {
    const source = { kind: "text" as const, text: "before" };
    const list = contentInput.capture([{ id: "x", source }]);
    source.text = "after";
    expect(list[0].source).toEqual({ kind: "text", text: "before" });
    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(list[0].source)).toBe(true);
  });
});

describe("processing boundaries", () => {
  it("preserves source and identity while recording each transformation", () => {
    const result = textProcessor("local", "uppercase", (item) => item.text.toUpperCase()).process(capture());
    expect(result[0]).toMatchObject({
      id: "note-1",
      text: "RAW",
      source: { text: "raw" },
      processing: [{ processor: "local", operation: "uppercase" }],
    });
  });
  it("never calls transforms for unread references", () => {
    const processor = textProcessor("test", "test", () => {
      throw new Error("must not run");
    });
    expect(processor.process(paperInput.capture({ id: "p", reference: "paper" }))[0].processing).toEqual([]);
  });
  it("leaves prior lists unchanged across repeated processing", () => {
    const input = capture();
    const processor = textProcessor("test", "append", (item) => `${item.text}!`);
    const once = processor.process(input);
    expect(processor.process(once)[0].processing).toHaveLength(2);
    expect(once[0].processing).toHaveLength(1);
    expect(input[0].processing).toHaveLength(0);
  });
  it("propagates a transformation failure without mutating input", () => {
    const input = capture();
    expect(() =>
      textProcessor("test", "fail", () => {
        throw new Error("failed");
      }).process(input),
    ).toThrow("failed");
    expect(input[0].text).toBe("raw");
  });
  it("requires a named processing step", () => expect(() => textProcessor("", "op", (c) => c.text)).toThrow());
  it.each([undefined, null, 7, {}, Promise.resolve("later")])(
    "rejects a non-string processing result without mutating the source",
    (result) => {
      const input = capture();
      const transform = (() => result) as unknown as (content: Content) => string;
      expect(() => textProcessor("runtime", "invalid", transform).process(input)).toThrowError(
        /^processing result must be a string$/,
      );
      expect(input[0].text).toBe("raw");
      expect(input[0].processing).toEqual([]);
    },
  );
  it("passes an isolated frozen snapshot to the processor", () => {
    const mutable = [{ ...capture()[0], source: { kind: "text" as const, text: "raw" }, processing: [] }];
    textProcessor("runtime", "inspect", (item) => {
      expect(item).not.toBe(mutable[0]);
      expect(Object.isFrozen(item)).toBe(true);
      expect(Object.isFrozen(item.source)).toBe(true);
      expect(Object.isFrozen(item.processing)).toBe(true);
      return item.text;
    }).process(mutable);
    expect(Object.isFrozen(mutable[0])).toBe(false);
  });
});

describe("output boundaries", () => {
  it("prepares a Notion export plan retaining all source evidence", () => {
    const output = notionOutput("page-1").prepare(capture());
    expect(output).toMatchObject({
      kind: "notion",
      pageId: "page-1",
      contents: [{ id: "note-1", source: { text: "raw" } }],
    });
  });
  it("prepares portable feed records in canonical order", () => {
    const items = contentInput.capture(["b", "a"].map((id) => ({ id, source: { kind: "text" as const, text: id } })));
    expect(
      feedOutput("My feed")
        .prepare(items)
        .items.map((i) => i.id),
    ).toEqual(["b", "a"]);
  });
  it("retains untrusted text literally rather than rendering HTML", () => {
    const input = contentInput.capture([{ id: "x", source: { kind: "text", text: "<script>unsafe</script>" } }]);
    expect(feedOutput("x").prepare(input).items[0].content_text).toBe("<script>unsafe</script>");
  });
  it("supports empty lists at every boundary", () => {
    expect(notionOutput("p").prepare(contentInput.capture([])).contents).toEqual([]);
    expect(feedOutput("f").prepare([]).items).toEqual([]);
  });
  it("requires an explicit destination", () => expect(() => notionOutput(" ")).toThrow());
  it("requires a feed title", () => expect(() => feedOutput("")).toThrow());
  it("rejects duplicate content at both export boundaries", () => {
    const duplicated = [...capture(), ...capture()];
    expect(() => notionOutput("page").prepare(duplicated)).toThrow("duplicate");
    expect(() => feedOutput("feed").prepare(duplicated)).toThrow("duplicate");
  });
  it("freezes output plans and nested processing evidence", () => {
    const input = textProcessor("local", "trim", (item) => item.text.trim()).process(capture());
    const notion = notionOutput("page").prepare(input);
    const feed = feedOutput("feed").prepare(input);
    for (const output of [notion, feed]) expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(notion.contents)).toBe(true);
    expect(Object.isFrozen(feed.items)).toBe(true);
    expect(Object.isFrozen(feed.items[0])).toBe(true);
    expect(Object.isFrozen(feed.items[0].source)).toBe(true);
    expect(Object.isFrozen(feed.items[0].processing[0])).toBe(true);
    expect(feed.items[0].processing).not.toBe(input[0].processing);
  });
});

it("never echoes malformed source payloads in errors", () => {
  const secret = "private input that must never appear in errors";
  expect(() =>
    contentInput.capture([{ id: "x", source: { kind: secret, text: secret } as unknown as ContentSource }]),
  ).toThrowError(/^unsupported content source$/);
});
it.each([
  null,
  7,
  { kind: "text", text: 7 },
  { kind: "link", url: "u", text: 7 },
  { kind: "screenshot", imageRef: "i", extractedText: false },
])("rejects malformed runtime source with a controlled error", (source) => {
  expect(() => contentInput.capture([{ id: "x", source: source as unknown as ContentSource }])).toThrowError(
    /^(invalid content source|unsupported content source|text must be a nonempty string|source text must be a string)$/,
  );
});
it("preserves source completeness and processing history in feed plans", () => {
  const read = textProcessor("p", "op", (item) => item.text.toUpperCase()).process(capture());
  const unread = paperInput.capture({ id: "unread", reference: "doi:example" });
  const feed = feedOutput("Reading").prepare([...read, ...unread]);
  expect(feed.items[0]).toMatchObject({
    completeness: "text-available",
    processing: [{ processor: "p", operation: "op" }],
  });
  expect(feed.items[1]).toMatchObject({ completeness: "reference-only", processing: [] });
});
