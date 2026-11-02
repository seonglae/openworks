import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { requireOwner } from "./auth";

// Connected sources and destinations. A row holds what its type needs to reach
// the other side: a Notion workspace's token, a vault's path. The token never
// leaves the backend; `list` is the only read a client gets, and it drops it.

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const STATE_TTL_MS = 10 * 60_000;

export type ConnectorView = Omit<Doc<"connectors">, "secret"> & { hasSecret: boolean };

const view = ({ secret, ...row }: Doc<"connectors">): ConnectorView => ({ ...row, hasSecret: secret !== undefined });

export const list = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ConnectorView[]> => {
    await requireOwner(ctx, args.serviceKey);
    return (await ctx.db.query("connectors").collect()).map(view);
  },
});

// Whether the phone is connected, from what it leaves behind: the devices
// that registered for push after signing in, and the last screenshot it sent.
export const devices = query({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const rows = await ctx.db.query("deviceTokens").collect();
    const recent = await ctx.db.query("jobs").withIndex("by_createdAt").order("desc").take(300);
    const shot = recent.find((j) => j.emailId?.startsWith("screenshot:"));
    return {
      devices: rows.map((d) => ({ label: d.label ?? "iPhone", at: d.createdAt })),
      lastUpload: shot?.createdAt ?? null,
    };
  },
});

const notionRow = (ctx: Pick<QueryCtx, "db">) =>
  ctx.db
    .query("connectors")
    .withIndex("by_type", (q) => q.eq("type", "notion"))
    .first();

// The Notion token every Notion action uses: the connected workspace's, or the
// deployment's NOTION_TOKEN when Notion was set up that way.
export const notionSecret = internalQuery({
  args: {},
  handler: async (ctx): Promise<string | null> => (await notionRow(ctx))?.secret?.accessToken ?? null,
});

export async function notionToken(ctx: ActionCtx): Promise<string> {
  const token = (await ctx.runQuery(internal.connectors.notionSecret, {})) ?? process.env.NOTION_TOKEN;
  if (!token) throw new Error("Notion is not connected: connect it in Settings");
  return token;
}

export const saveNotion = internalMutation({
  args: {
    name: v.string(),
    auth: v.union(v.literal("oauth"), v.literal("token")),
    secret: v.object({
      accessToken: v.string(),
      refreshToken: v.optional(v.string()),
      botId: v.optional(v.string()),
      workspaceId: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const fields = { ...args, status: "connected" as const, error: undefined, checkedAt: now, updatedAt: now };
    const existing = await notionRow(ctx);
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("connectors", { type: "notion", createdAt: now, ...fields });
  },
});

// A deployment that set NOTION_TOKEN before connectors existed reads as a
// connected Notion, so its database and root page have a row to live on.
export const adoptEnvNotion = mutation({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    if (!process.env.NOTION_TOKEN || (await notionRow(ctx))) return null;
    const now = Date.now();
    return await ctx.db.insert("connectors", {
      type: "notion",
      name: "Notion",
      auth: "env",
      status: "connected",
      createdAt: now,
      updatedAt: now,
    });
  },
});

// An internal integration's token, pasted in Settings. Notion is asked who the
// token is before it is kept, so a typo fails here and not at the first edit.
export const connectNotionToken = action({
  args: { token: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ name: string }> => {
    await requireOwner(ctx, args.serviceKey);
    const token = args.token.trim();
    const res = await fetch(`${NOTION_API}/users/me`, {
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION },
    });
    if (!res.ok) throw new Error(`Notion did not accept this token (${res.status})`);
    const me = (await res.json()) as { name?: string; bot?: { workspace_name?: string } };
    const name = me.bot?.workspace_name ?? me.name ?? "Notion";
    await ctx.runMutation(internal.connectors.saveNotion, { name, auth: "token", secret: { accessToken: token } });
    return { name };
  },
});

export const callbackUrl = () => `${process.env.CONVEX_SITE_URL}/oauth/notion/callback`;

// The authorize URL for Notion's public-integration sign-in, or null when this
// deployment has no NOTION_OAUTH_CLIENT_ID, in which case Settings offers the
// token route instead. The state is drawn here because an action, unlike a
// mutation, has real randomness.
export const beginNotionOAuth = action({
  args: { returnTo: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ url: string } | null> => {
    await requireOwner(ctx, args.serviceKey);
    const clientId = process.env.NOTION_OAUTH_CLIENT_ID;
    if (!clientId || !process.env.NOTION_OAUTH_CLIENT_SECRET) return null;
    const back = new URL(args.returnTo);
    if (back.protocol !== "https:" && back.protocol !== "http:") throw new Error("returnTo must be a web address");
    const state = crypto.randomUUID();
    await ctx.runMutation(internal.connectors.saveState, { provider: "notion", state, returnTo: back.toString() });
    const url = new URL(`${NOTION_API}/oauth/authorize`);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("owner", "user");
    url.searchParams.set("redirect_uri", callbackUrl());
    url.searchParams.set("state", state);
    return { url: url.toString() };
  },
});

export const saveState = internalMutation({
  args: { provider: v.string(), state: v.string(), returnTo: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert("oauthStates", { ...args, createdAt: Date.now() });
  },
});

// The return address the sign-in started from, once: the row is deleted
// whether or not it is still fresh.
export const consumeState = internalMutation({
  args: { provider: v.string(), state: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const row = await ctx.db
      .query("oauthStates")
      .withIndex("by_state", (q) => q.eq("state", args.state))
      .first();
    if (!row) return null;
    await ctx.db.delete(row._id);
    if (row.provider !== args.provider || Date.now() - row.createdAt > STATE_TTL_MS) return null;
    return row.returnTo;
  },
});

// Swaps the code Notion sent back for the workspace's tokens.
export async function exchangeNotionCode(code: string): Promise<{
  name: string;
  secret: { accessToken: string; refreshToken?: string; botId?: string; workspaceId?: string };
}> {
  const basic = btoa(`${process.env.NOTION_OAUTH_CLIENT_ID}:${process.env.NOTION_OAUTH_CLIENT_SECRET}`);
  const res = await fetch(`${NOTION_API}/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: callbackUrl() }),
  });
  if (!res.ok) throw new Error(`Notion token exchange failed (${res.status})`);
  const body = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    bot_id?: string;
    workspace_id?: string;
    workspace_name?: string;
  };
  return {
    name: body.workspace_name ?? "Notion",
    secret: {
      accessToken: body.access_token,
      ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
      ...(body.bot_id ? { botId: body.bot_id } : {}),
      ...(body.workspace_id ? { workspaceId: body.workspace_id } : {}),
    },
  };
}

export const setNotionConfig = mutation({
  args: {
    rootPageId: v.optional(v.string()),
    databaseId: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const row = await notionRow(ctx);
    if (!row) throw new Error("Connect Notion first");
    const { serviceKey: _serviceKey, ...fields } = args;
    await ctx.db.patch(row._id, { config: { ...row.config, ...fields }, updatedAt: Date.now() });
  },
});

// A vault is a folder on the owner's machine, which only the worker can see,
// so adding one queues the worker's check and the row reads "checking" until
// it answers (setup:complete).
export const addObsidian = mutation({
  args: { vaultPath: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const vaultPath = args.vaultPath.trim();
    if (!vaultPath) throw new Error("Give the vault's folder");
    const now = Date.now();
    const name = vaultPath.replace(/\/+$/, "").split("/").pop() || vaultPath;
    const existing = (
      await ctx.db
        .query("connectors")
        .withIndex("by_type", (q) => q.eq("type", "obsidian"))
        .collect()
    ).find((r) => r.config?.vaultPath === vaultPath);
    const fields = { name, status: "checking" as const, error: undefined, updatedAt: now };
    let id = existing?._id;
    if (id) await ctx.db.patch(id, fields);
    else
      id = await ctx.db.insert("connectors", {
        type: "obsidian",
        auth: "path",
        config: { vaultPath },
        createdAt: now,
        ...fields,
      });
    await ctx.db.insert("setupRequests", {
      kind: "verify_obsidian",
      params: JSON.stringify({ connectorId: id, vaultPath }),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    return id;
  },
});

export const remove = mutation({
  args: { id: v.id("connectors"), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    await ctx.db.delete(args.id);
  },
});
