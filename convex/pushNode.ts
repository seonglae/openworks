"use node";

import { v } from "convex/values";
import webpush from "web-push";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

// Encrypt + deliver one Web Push payload to every stored subscription. Runs in
// the Node runtime because web-push uses Node crypto/https. Dead subscriptions
// (404/410 from the push service) are pruned so the list stays clean.
export const broadcast = internalAction({
  args: { title: v.string(), body: v.string(), url: v.string() },
  handler: async (ctx, args): Promise<{ sent: number; failed: number }> => {
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
    return { sent, failed };
  },
});
