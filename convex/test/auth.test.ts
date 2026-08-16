import { afterEach, describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import { auth, withConvex } from "./harness.setup";

const REAL_KEY = process.env.OPENWORKS_SERVICE_KEY;

afterEach(() => {
  process.env.OPENWORKS_SERVICE_KEY = REAL_KEY;
  delete process.env.OPENWORKS_OWNER_USER_ID;
});

describe("the gate on a deployment with no owner configured", () => {
  // The deployment URL ships inside the browser bundle, so "nobody knows the
  // address yet" was never true once the UI was reachable. This used to return
  // "local" for any caller at all.
  it("refuses a caller with no service key", async () => {
    const t = withConvex();
    await expect(t.query(api.settings.get, {})).rejects.toThrow(/auth required/);
  });

  it("refuses a caller presenting the wrong key", async () => {
    const t = withConvex();
    await expect(t.query(api.settings.get, { serviceKey: "not-the-key" })).rejects.toThrow(/auth required/);
  });

  it("lets the service key through, which is how the workers and the dev UI connect", async () => {
    const t = withConvex();
    await expect(t.query(api.settings.get, { ...auth })).resolves.toBeDefined();
  });

  // Refusing to answer at all beats answering everyone: an operator who never
  // set a key should find out on the first call, not from a stranger's traffic.
  it("refuses everyone when no key is configured either", async () => {
    delete process.env.OPENWORKS_SERVICE_KEY;
    const t = withConvex();
    await expect(t.query(api.settings.get, {})).rejects.toThrow(/unconfigured/);
    await expect(t.query(api.settings.get, { serviceKey: "anything" })).rejects.toThrow(/unconfigured/);
  });
});

describe("the gate once an owner is configured", () => {
  it("still lets the service key through for the workers", async () => {
    process.env.OPENWORKS_OWNER_USER_ID = "user_owner";
    const t = withConvex();
    await expect(t.query(api.settings.get, { ...auth })).resolves.toBeDefined();
  });

  it("rejects an anonymous caller", async () => {
    process.env.OPENWORKS_OWNER_USER_ID = "user_owner";
    const t = withConvex();
    await expect(t.query(api.settings.get, {})).rejects.toThrow(/auth required/);
  });
});
