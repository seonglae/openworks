import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import { auth, withConvex } from "./harness.setup";

// The action refuses to run without a token, and this test is about what it
// does with the scope, so give it one that is never spent.
const PRIOR_TOKEN = process.env.GITHUB_TOKEN;

beforeEach(() => {
  process.env.GITHUB_TOKEN = "test-token-never-sent";
});

afterEach(() => {
  if (PRIOR_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = PRIOR_TOKEN;
  vi.unstubAllGlobals();
});

describe("listing open pull requests", () => {
  it("asks GitHub nothing when no user or org is configured", async () => {
    const t = withConvex();
    // Nothing in settings, so the scope is empty. Unscoped, `is:pr is:open`
    // matches every open pull request on GitHub: 1000 results from 346
    // unrelated repos, 41s, past the caller's timeout. A fetch here at all is
    // the bug, whatever it would have returned.
    const fetchSpy = vi.fn(() => {
      throw new Error("listOpenPRs searched GitHub with no scope");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await t.action(api.github.listOpenPRs, { ...auth });

    expect(result).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
