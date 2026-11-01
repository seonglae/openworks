import { afterEach, describe, expect, it, vi } from "vitest";
import { STORED_CONNECTOR_KEYS, CONNECTOR_TYPES } from "@openworks/domain";
import { api, internal } from "../_generated/api";
import { auth, withConvex } from "./harness.setup";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NOTION_OAUTH_CLIENT_ID;
  delete process.env.NOTION_OAUTH_CLIENT_SECRET;
  delete process.env.NOTION_TOKEN;
});

const secret = { accessToken: "workspace-token", refreshToken: "refresh", botId: "bot" };

describe("connectors", () => {
  it("names as stored exactly the types the registry stores", () => {
    expect([...STORED_CONNECTOR_KEYS].sort()).toEqual(
      CONNECTOR_TYPES.filter((t) => t.stored)
        .map((t) => t.key)
        .sort(),
    );
  });

  it("never hands a Notion token to a client", async () => {
    const t = withConvex();
    await t.mutation(internal.connectors.saveNotion, { name: "Lab", auth: "oauth", secret });
    const [row] = await t.query(api.connectors.list, { ...auth });
    expect(row).toMatchObject({ type: "notion", name: "Lab", status: "connected", hasSecret: true });
    expect(JSON.stringify(row)).not.toContain("workspace-token");
    expect(row).not.toHaveProperty("secret");
  });

  it("prefers the connected workspace's token to the deployment's", async () => {
    process.env.NOTION_TOKEN = "env-token";
    const t = withConvex();
    await expect(t.query(internal.connectors.notionSecret, {})).resolves.toBeNull();
    await t.mutation(internal.connectors.saveNotion, { name: "Lab", auth: "token", secret });
    await expect(t.query(internal.connectors.notionSecret, {})).resolves.toBe("workspace-token");
  });

  it("keeps one Notion row when it is connected again", async () => {
    const t = withConvex();
    await t.mutation(internal.connectors.saveNotion, { name: "Old", auth: "token", secret });
    await t.mutation(internal.connectors.saveNotion, { name: "New", auth: "oauth", secret });
    const rows = await t.query(api.connectors.list, { ...auth });
    expect(rows.map((r) => r.name)).toEqual(["New"]);
  });

  it("checks a pasted token with Notion before keeping it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );
    const t = withConvex();
    await expect(t.action(api.connectors.connectNotionToken, { token: "typo", ...auth })).rejects.toThrow(/401/);
    await expect(t.query(api.connectors.list, { ...auth })).resolves.toEqual([]);
  });

  it("offers no sign-in when the deployment has no OAuth client", async () => {
    const t = withConvex();
    await expect(
      t.action(api.connectors.beginNotionOAuth, { returnTo: "https://quire.test/", ...auth }),
    ).resolves.toBeNull();
  });

  it("queues the worker's vault check and answers the row from it", async () => {
    const t = withConvex();
    const id = await t.mutation(api.connectors.addObsidian, { vaultPath: "~/Vault/", ...auth });
    const [req] = await t.query(api.setup.listByStatus, { status: "pending", ...auth });
    expect(req.kind).toBe("verify_obsidian");
    expect(JSON.parse(req.params!)).toEqual({ connectorId: id, vaultPath: "~/Vault/" });
    await t.mutation(api.setup.complete, {
      id: req._id,
      status: "done",
      result: JSON.stringify({ isVault: false, reason: "no .obsidian folder" }),
      ...auth,
    });
    const [row] = await t.query(api.connectors.list, { ...auth });
    expect(row).toMatchObject({ name: "Vault", status: "error", error: "no .obsidian folder" });
  });
});

describe("the Notion sign-in callback", () => {
  const start = async () => {
    process.env.NOTION_OAUTH_CLIENT_ID = "client";
    process.env.NOTION_OAUTH_CLIENT_SECRET = "shh";
    const t = withConvex();
    const begun = await t.action(api.connectors.beginNotionOAuth, { returnTo: "https://quire.test/?a=1", ...auth });
    const state = new URL(begun!.url).searchParams.get("state")!;
    return { t, state };
  };

  it("refuses a state this deployment never issued", async () => {
    const t = withConvex();
    const res = await t.fetch("/oauth/notion/callback?state=forged&code=c", { method: "GET" });
    expect(res.status).toBe(400);
  });

  it("swaps the code for the workspace's token, once", async () => {
    const { t, state } = await start();
    const exchange = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: "oauth-token", bot_id: "b", workspace_name: "Lab" }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", exchange);
    const res = await t.fetch(`/oauth/notion/callback?state=${state}&code=c`, { method: "GET" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://quire.test/?a=1&connector=notion");
    const [, init] = exchange.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa("client:shh")}`);
    expect(JSON.parse(init.body as string)).toMatchObject({ grant_type: "authorization_code", code: "c" });
    await expect(t.query(internal.connectors.notionSecret, {})).resolves.toBe("oauth-token");

    const again = await t.fetch(`/oauth/notion/callback?state=${state}&code=c`, { method: "GET" });
    expect(again.status).toBe(400);
  });

  it("returns to the app, not an error page, when Notion refuses the code", async () => {
    const { t, state } = await start();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad code", { status: 400 })),
    );
    const res = await t.fetch(`/oauth/notion/callback?state=${state}&code=c`, { method: "GET" });
    expect(res.headers.get("Location")).toBe("https://quire.test/?a=1&connector=notion-error");
    await expect(t.query(api.connectors.list, { ...auth })).resolves.toEqual([]);
  });
});
