import { describe, expect, it } from "vitest";
import { decodeSnapshot, encodeSnapshot, MAX_SNAPSHOT_BYTES } from "../contentSnapshot";
import { anyApi } from "convex/server";
import { auth, withConvex } from "./harness.setup";
const api = anyApi;
function encodedNode(node: unknown, tail = new Uint8Array()) {
  const metadata = new TextEncoder().encode(JSON.stringify(node));
  const bytes = new Uint8Array(4 + metadata.length + tail.length);
  new DataView(bytes.buffer).setUint32(0, metadata.length, true);
  bytes.set(metadata, 4);
  bytes.set(tail, 4 + metadata.length);
  return bytes;
}
describe("lossless canonical snapshot codec", () => {
  it.each(["", "한글😀", "\ufeffstart", "\ud800", "\udfff", '\u0000\u0001\r\n\t\\"', "a".repeat(900_000)])(
    "round trips strings without normalization %#",
    (text) => {
      expect(decodeSnapshot(encodeSnapshot({ text }))).toEqual({ text });
    },
  );
  it("round trips arrays, nested fields and all Convex float values", () => {
    const original = {
      nil: null,
      yes: true,
      values: [0, -0, 1.25, NaN, Infinity, -Infinity, "한글", null],
      nested: { a: "b" },
    };
    const result = decodeSnapshot(encodeSnapshot(original));
    expect(result).toEqual(original);
    expect(Object.is((result.values as number[])[1], -0)).toBe(true);
  });
  it("preserves numeric object keys under canonical enumeration", () => {
    const data = { nested: { "10": "ten", "2": "two", a: "a" } };
    expect(decodeSnapshot(encodeSnapshot(data))).toEqual(data);
  });
  it("encodes deterministic bytes independent of object insertion order", () => {
    expect(encodeSnapshot({ z: "last", a: { y: 2, x: "first" } })).toEqual(
      encodeSnapshot({ a: { x: "first", y: 2 }, z: "last" }),
    );
  });
  it.each([
    null,
    [],
    "text",
    3,
    { o: null },
    { o: [] },
    { o: {}, extra: 1 },
    { o: { a: { x: 1 } } },
    { o: { a: { s: [1, 0] } } },
    { o: { a: { s: [0, -1] } } },
    { o: { a: { s: [0, 1.5] } } },
    { o: { a: { s: [0, 1] } } },
    { o: { a: { s: [0, 0, 0] } } },
    { o: { a: { n: "bad" } } },
  ])("rejects malformed internal metadata %#", (node) => {
    expect(() => decodeSnapshot(encodedNode(node))).toThrow();
  });
  it("rejects truncation and unconsumed trailing bytes", () => {
    const full = encodeSnapshot({ a: "hello" });
    expect(() => decodeSnapshot(full.subarray(0, full.length - 1))).toThrow();
    expect(() => decodeSnapshot(encodedNode({ o: {} }, new Uint8Array([0, 0])))).toThrow();
    expect(() => decodeSnapshot(new Uint8Array(MAX_SNAPSHOT_BYTES + 1))).toThrow();
  });
  it("uses under two megabytes for a valid 900k control-character document", () => {
    const bytes = encodeSnapshot({ content: "\u0000".repeat(900_000) });
    expect(bytes.length).toBeLessThan(2_000_000);
  });
});
describe("stored revision reconstruction boundaries", () => {
  it.each(["missing", "extra", "wrong-position", "truncated"])(
    "rejects %s chunks rather than returning partial text",
    async (variant) => {
      const t = withConvex();
      const saved = await t.mutation(api.researchMemos.save, {
        ...auth,
        researchSlug: "p",
        memoSlug: "m",
        content: "exact input",
      });
      await t.run(async (ctx) => {
        const chunk = (await ctx.db.query("contentRevisionChunks").first())!;
        if (variant === "missing") await ctx.db.delete(chunk._id);
        if (variant === "extra") {
          const { _id, _creationTime, ...data } = chunk;
          await ctx.db.insert("contentRevisionChunks", { ...data, position: 1 });
        }
        if (variant === "wrong-position") await ctx.db.patch(chunk._id, { position: 1 });
        if (variant === "truncated")
          await ctx.db.patch(chunk._id, { bytes: chunk.bytes.slice(0, chunk.bytes.byteLength - 1) });
      });
      await expect(t.query(api.contentRevisions.get, { ...auth, id: saved.revisionId })).rejects.toThrow(/snapshot/i);
    },
  );
  it.each([NaN, -1, 1.5, Infinity, 0])("rejects malformed snapshot byte counts %s", async (snapshotBytes) => {
    const t = withConvex();
    const saved = await t.mutation(api.researchMemos.save, { ...auth, researchSlug: "p", memoSlug: "m" });
    await t.run((ctx) => ctx.db.patch(saved.revisionId, { snapshotBytes }));
    await expect(t.query(api.contentRevisions.get, { ...auth, id: saved.revisionId })).rejects.toThrow(/snapshot/i);
  });
  it("preserves the owner/service-key gate on history, snapshot and head APIs", async () => {
    const t = withConvex();
    const saved = await t.mutation(api.researchMemos.save, { ...auth, researchSlug: "p", memoSlug: "m" });
    await expect(t.query(api.contentRevisions.get, { id: saved.revisionId })).rejects.toThrow();
    for (const name of ["head", "list"])
      await expect(
        t.query(api.contentRevisions[name], { kind: "memo", researchSlug: "p", key: "m" }),
      ).rejects.toThrow();
  });
});
