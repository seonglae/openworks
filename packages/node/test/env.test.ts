import { describe, expect, it } from "vitest";
import { parseEnvFile, resolveConvexUrl } from "../src/env.ts";

describe("parseEnvFile", () => {
  it("reads plain assignments", () => {
    expect(parseEnvFile("A=1\nB=two")).toEqual({ A: "1", B: "two" });
  });

  it("skips comments and blank lines", () => {
    expect(parseEnvFile("# note\n\nA=1\n  # indented\n")).toEqual({ A: "1" });
  });

  it("strips surrounding quotes, which the old regex readers kept", () => {
    expect(parseEnvFile("A=\"quoted\"\nB='single'")).toEqual({ A: "quoted", B: "single" });
  });

  it("strips a trailing comment from an unquoted value but keeps one inside quotes", () => {
    expect(parseEnvFile('A=val # note\nB="val # kept"')).toEqual({ A: "val", B: "val # kept" });
  });

  it("keeps a '#' that is not preceded by a space", () => {
    expect(parseEnvFile("A=frag#ment")).toEqual({ A: "frag#ment" });
  });

  it("keeps '=' inside a value", () => {
    expect(parseEnvFile("URL=https://x.dev/?a=b&c=d")).toEqual({ URL: "https://x.dev/?a=b&c=d" });
  });

  it("tolerates whitespace around the separator", () => {
    expect(parseEnvFile("  A  =  1  ")).toEqual({ A: "1" });
  });

  it("ignores a line with no '=' and one starting with '='", () => {
    expect(parseEnvFile("garbage\n=novalue\nA=1")).toEqual({ A: "1" });
  });
});

describe("resolveConvexUrl", () => {
  const nowhere = "/nonexistent-dir-for-tests";

  it("prefers CONVEX_URL", () => {
    expect(resolveConvexUrl(nowhere, { CONVEX_URL: "https://a.convex.cloud" })).toBe("https://a.convex.cloud");
  });

  it("derives the url from a dev deployment name", () => {
    expect(resolveConvexUrl(nowhere, { CONVEX_DEPLOYMENT: "dev:example-deployment-123" })).toBe(
      "https://example-deployment-123.convex.cloud",
    );
  });

  it("derives it from a prod deployment name too", () => {
    expect(resolveConvexUrl(nowhere, { CONVEX_DEPLOYMENT: "prod:calm-otter-1" })).toBe(
      "https://calm-otter-1.convex.cloud",
    );
  });

  it("returns null rather than a malformed url when nothing resolves", () => {
    expect(resolveConvexUrl(nowhere, {})).toBeNull();
    expect(resolveConvexUrl(nowhere, { CONVEX_DEPLOYMENT: "example-deployment-123" })).toBeNull();
  });
});
