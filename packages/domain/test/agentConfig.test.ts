import { describe, expect, it } from "vitest";
import {
  AgentConfigError,
  MAX_AGENT_CONFIG_BYTES,
  MAX_AGENT_CONFIG_NODES,
  normalizeAgentConfig,
  readStoredAgentConfig,
} from "../src/agentConfig.ts";

describe("queued agent configuration", () => {
  it.each([undefined, "", " \n\t"])("uses defaults for absent or blank optional config", (value) => {
    expect(normalizeAgentConfig(value)).toBeUndefined();
  });

  it("preserves arbitrary JSON keys while canonicalizing object order", () => {
    const raw = ' {"z":[true,null,{"b":2,"a":1}],"a":{"custom":"value"}} ';
    const normalized = '{"a":{"custom":"value"},"z":[true,null,{"a":1,"b":2}]}';
    expect(normalizeAgentConfig(raw)).toBe(normalized);
    expect(normalizeAgentConfig(normalized)).toBe(normalized);
    expect(JSON.parse(normalized)).toEqual(JSON.parse(raw));
  });

  it("retains legacy templates and validated optional instruction fields", () => {
    const raw = {
      promptTemplate: "Review {{entity}}",
      version: 1,
      instructions: "Check sources",
      language: "ko",
      maxCommentChars: 1000,
    };
    expect(JSON.parse(normalizeAgentConfig(JSON.stringify(raw))!)).toEqual(raw);
    expect(normalizeAgentConfig("{}")).toBe("{}");
  });

  it("keeps prototype-shaped keys as data without polluting any object", () => {
    const raw = '{"__proto__":{"injected":true},"constructor":{"prototype":{"injected":true}}}';
    const result = normalizeAgentConfig(raw)!;
    expect(Object.hasOwn(JSON.parse(result), "__proto__")).toBe(true);
    expect(({} as { injected?: boolean }).injected).toBeUndefined();
  });

  it.each(["null", "[]", "3", "true", '"text"'])("rejects non-object configuration", (raw) => {
    expect(() => normalizeAgentConfig(raw)).toThrowError("must contain a JSON object");
  });

  it.each(["{", '{"private":"do not echo",}', "NaN"])("rejects invalid JSON without leaking input", (raw) => {
    try {
      normalizeAgentConfig(raw);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentConfigError);
      expect((error as AgentConfigError).code).toBe("invalid_json");
      expect(String(error)).not.toContain("do not echo");
    }
  });

  it.each([0, null, {}, []])("rejects non-string runtime values", (raw) => {
    expect(() => normalizeAgentConfig(raw as unknown as string)).toThrowError("must be a JSON string");
  });

  it.each(['{"a":1e999}', '{"nested":[-1e999]}'])("rejects JSON numbers that parse to infinity", (raw) => {
    expect(() => normalizeAgentConfig(raw)).toThrowError("non-finite number");
  });

  it.each([{ version: 2 }, { version: "1" }, { version: null }])(
    "rejects unsupported configuration versions",
    (value) => {
      expect(() => normalizeAgentConfig(JSON.stringify(value))).toThrowError("version is not supported");
    },
  );

  it.each([
    { instructions: 7 },
    { language: " " },
    { language: 4 },
    { language: "x".repeat(81) },
    { maxCommentChars: 0 },
    { maxCommentChars: 16001 },
    { maxCommentChars: 3.5 },
    { maxCommentChars: "100" },
  ])("validates known fields without discarding other keys", (value) => {
    expect(() => normalizeAgentConfig(JSON.stringify(value))).toThrowError("invalid known field");
  });

  it("accepts the exact ASCII byte budget and rejects the next byte", () => {
    const exact = JSON.stringify({ x: "x".repeat(MAX_AGENT_CONFIG_BYTES - 8) });
    expect(Buffer.byteLength(exact, "utf8")).toBe(MAX_AGENT_CONFIG_BYTES);
    expect(normalizeAgentConfig(exact)).toBe(exact);
    expect(() => normalizeAgentConfig(exact + " ")).toThrowError("UTF-8 size limit");
  });

  it.each(["한", "😀"])("counts non-ASCII UTF-8 bytes rather than UTF-16 units", (unit) => {
    const count = Math.floor((MAX_AGENT_CONFIG_BYTES - 8) / Buffer.byteLength(unit, "utf8"));
    const exact = JSON.stringify({ x: unit.repeat(count) });
    expect(Buffer.byteLength(exact, "utf8")).toBeLessThanOrEqual(MAX_AGENT_CONFIG_BYTES);
    expect(normalizeAgentConfig(exact)).toBe(exact);
    expect(() => normalizeAgentConfig(JSON.stringify({ x: unit.repeat(count + 1) }))).toThrowError("UTF-8 size limit");
  });

  it("rejects surrogate escapes whose canonical bytes exceed the budget", () => {
    const raw = '{"x":"' + "\ud800".repeat(6000) + '"}';
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThan(MAX_AGENT_CONFIG_BYTES);
    expect(() => normalizeAgentConfig(raw)).toThrowError("UTF-8 size limit");
  });

  it("bounds nesting before recursive serialization exhausts the stack", () => {
    const raw = '{"x":' + "[".repeat(30) + "0" + "]".repeat(30) + "}";
    expect(() => normalizeAgentConfig(raw)).toThrowError("nesting limit");
  });

  it("bounds the number of values even below the byte limit", () => {
    const raw = JSON.stringify({ x: new Array(MAX_AGENT_CONFIG_NODES).fill(0) });
    expect(Buffer.byteLength(raw)).toBeLessThan(MAX_AGENT_CONFIG_BYTES);
    expect(() => normalizeAgentConfig(raw)).toThrowError("value-count limit");
  });

  it("legacy invalid values return an explicit content-free diagnostic and defaults", () => {
    const result = readStoredAgentConfig("private legacy text");
    expect(result).toEqual({ configSnapshot: undefined, issue: "invalid_json" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private legacy text");
  });

  it("legacy valid values retain exactly their canonical content", () => {
    expect(readStoredAgentConfig('{"z":2,"a":1}')).toEqual({ configSnapshot: '{"a":1,"z":2}', issue: undefined });
    expect(readStoredAgentConfig(undefined)).toEqual({ configSnapshot: undefined, issue: undefined });
  });
});
