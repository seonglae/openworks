"use node";

import http2 from "node:http2";
import { v } from "convex/values";
import webpush from "web-push";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { providerToken } from "./apnsToken";

// --- APNs ------------------------------------------------------------------
//
// Token-based auth, which is one .p8 signing key for the whole team rather than
// a per-app certificate that expires every year. The provider token is a JWT
// this signs itself: no dependency, because ES256 is exactly what
// `crypto.sign` does when told to emit the raw r||s pair JOSE wants instead of
// the DER wrapper OpenSSL defaults to.
//
// APNs is HTTP/2 only, and there is no HTTP/1.1 fallback to degrade to, so this
// opens a session per broadcast. One session carries every device.
const APNS_HOST = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
} as const;

type ApnsResult = { token: string; status: number; reason?: string };

// One HTTP/2 session, one request per device, resolved together. The session is
// closed in a finally so a throw mid-flight cannot leak it into the runtime.
async function sendApns(
  host: string,
  jwt: string,
  topic: string,
  devices: { token: string }[],
  payload: unknown,
): Promise<ApnsResult[]> {
  const client = http2.connect(host);
  try {
    return await Promise.all(
      devices.map(
        (d) =>
          new Promise<ApnsResult>((resolve) => {
            const req = client.request({
              ":method": "POST",
              ":path": `/3/device/${d.token}`,
              authorization: `bearer ${jwt}`,
              "apns-topic": topic,
              "apns-push-type": "alert",
              "apns-priority": "10",
            });
            let status = 0;
            let raw = "";
            req.on("response", (headers) => {
              status = Number(headers[":status"] ?? 0);
            });
            req.setEncoding("utf8");
            req.on("data", (chunk: string) => (raw += chunk));
            req.on("error", (e) => resolve({ token: d.token, status: 0, reason: String(e?.message ?? e) }));
            req.on("end", () => {
              let reason: string | undefined;
              try {
                reason = raw ? JSON.parse(raw).reason : undefined;
              } catch {
                reason = raw.slice(0, 120) || undefined;
              }
              resolve({ token: d.token, status, reason });
            });
            req.end(JSON.stringify(payload));
          }),
      ),
    );
  } finally {
    client.close();
  }
}

// Encrypt + deliver one Web Push payload to every stored subscription. Runs in
// the Node runtime because web-push uses Node crypto/https. Dead subscriptions
// (404/410 from the push service) are pruned so the list stays clean.
export const broadcast = internalAction({
  args: { title: v.string(), body: v.string(), url: v.string() },
  handler: async (ctx, args): Promise<{ sent: number; failed: number; apns: string[] }> => {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    // The subject is the contact a push service complains to, so it has to be
    // this deployment's own address. There is no sensible default to fall back
    // on: anything hardcoded here would point complaints at a stranger.
    const subject = process.env.VAPID_SUBJECT;
    if (!publicKey || !privateKey || !subject)
      throw new Error("push not configured: set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT");
    webpush.setVapidDetails(subject, publicKey, privateKey);

    const subs = await ctx.runQuery(internal.push.listSubscriptions, {});
    const payload = JSON.stringify({ title: args.title, body: args.body, url: args.url });
    let sent = 0;
    let failed = 0;
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload);
        sent++;
      } catch (e: any) {
        failed++;
        const code = e?.statusCode;
        if (code === 404 || code === 410) {
          await ctx.runMutation(internal.push.removeByEndpoint, { endpoint: s.endpoint });
        }
      }
    }
    const apns = await deliverApns(ctx, args);
    return { sent: sent + apns.sent, failed: failed + apns.failed, apns: apns.reasons };
  },
});

// The phones, delivered from the same broadcast so every existing caller
// reaches them with no new call site: a summary landing already schedules this,
// and the settings test button already runs it.
//
// Unconfigured is not a failure. A deployment with no APNs key is the normal
// state for anyone who has not built the iOS app, and throwing here would take
// the Web Push half down with it.
async function deliverApns(
  ctx: { runQuery: (ref: any, args: any) => Promise<any>; runMutation: (ref: any, args: any) => Promise<any> },
  args: { title: string; body: string; url: string },
): Promise<{ sent: number; failed: number; reasons: string[] }> {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const p8 = process.env.APNS_AUTH_KEY;
  if (!keyId || !teamId || !p8) return { sent: 0, failed: 0, reasons: [] };

  const devices: { token: string; environment: "sandbox" | "production"; bundleId: string }[] = await ctx.runQuery(
    internal.push.listDeviceTokens,
    {},
  );
  if (devices.length === 0) return { sent: 0, failed: 0, reasons: [] };

  const jwt = providerToken(keyId, teamId, p8);
  const payload = {
    aps: { alert: { title: args.title, body: args.body }, sound: "default" },
    url: args.url,
  };

  let sent = 0;
  let failed = 0;
  // What APNs actually said, returned rather than only logged: "failed: 1"
  // does not tell you whether the key is wrong or the token is stale, and that
  // is the whole question when this is being set up.
  const reasons: string[] = [];
  // Grouped by host and topic: one session cannot serve both APNs environments,
  // and the topic is the bundle id the token was issued for.
  const groups = new Map<string, typeof devices>();
  for (const d of devices) {
    const key = `${d.environment}\u0000${d.bundleId}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }

  for (const [key, group] of groups) {
    const [environment, bundleId] = key.split("\u0000");
    const host = APNS_HOST[environment as keyof typeof APNS_HOST];
    let results: ApnsResult[];
    try {
      results = await sendApns(host, jwt, bundleId, group, payload);
    } catch (e) {
      console.warn(`[apns] ${environment} session failed: ${String(e)}`);
      reasons.push(`session: ${String(e)}`);
      failed += group.length;
      continue;
    }
    for (const r of results) {
      if (r.status === 200) {
        sent++;
        continue;
      }
      failed++;
      // 410 is APNs saying the app is gone from that device, which is the one
      // answer that means the row is dead rather than the config being wrong.
      if (r.status === 410 || r.reason === "Unregistered") {
        await ctx.runMutation(internal.push.removeDeviceToken, { token: r.token });
      } else {
        console.warn(`[apns] ${r.status} ${r.reason ?? ""} for ${r.token.slice(0, 8)}…`);
        reasons.push(`${r.status} ${r.reason ?? ""}`.trim());
      }
    }
  }
  return { sent, failed, reasons };
}
