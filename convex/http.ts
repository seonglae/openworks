import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";

// Single ingest endpoint for mobile clients: a share sheet, a photo-roll sync,
// anything that can POST bytes with a bearer token. No such client ships here,
// which is the point of it being an HTTP endpoint rather than a Convex
// function. The client POSTs the raw screenshot bytes and gets back a jobId.
// The image lands as an "article" job so the existing worker pipeline
// (maybeFetchJobImage -> agent identifies source -> fetches full text ->
// article summary) processes it unchanged.
//
// Auth: a shared bearer token in the SCREENSHOT_INGEST_SECRET deployment env.
//   npx convex env set SCREENSHOT_INGEST_SECRET <token>
// When the env var is unset the endpoint is disabled (returns 503) so a fresh
// deployment never exposes an open ingest by accident.
const ingestScreenshot = httpAction(async (ctx, request) => {
  const secret = process.env.SCREENSHOT_INGEST_SECRET;
  if (!secret) {
    return new Response("ingest disabled", { status: 503 });
  }
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const contentType = request.headers.get("content-type") ?? "application/octet-stream";
  const blob = await request.blob();
  if (blob.size === 0) {
    return new Response("empty body", { status: 400 });
  }

  const storageId = await ctx.storage.store(new Blob([blob], { type: contentType }));

  // Optional client-supplied dedup key (e.g. the iOS PHAsset localIdentifier)
  // so the on-open sync can replay without creating duplicate jobs.
  const dedupId = request.headers.get("x-screenshot-id") ?? undefined;

  // This httpAction authed via the bearer secret, not a Clerk session, so the
  // inner mutation gets no owner identity — pass the service key through.
  const jobId = await ctx.runMutation(api.jobs.create, {
    url: "",
    type: "article",
    imageId: storageId,
    serviceKey: process.env.OPENWORKS_SERVICE_KEY,
    ...(dedupId ? { emailId: `screenshot:${dedupId}` } : {}),
  });

  return Response.json({ jobId });
});

const http = httpRouter();
http.route({ path: "/screenshot", method: "POST", handler: ingestScreenshot });
export default http;
