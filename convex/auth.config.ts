// Clerk → Convex auth bridge.
//
// CLERK_ISSUER_URL is set on the Convex deployment via:
//   npx convex env set CLERK_ISSUER_URL https://your-app.clerk.accounts.dev
// (Clerk dashboard → JWT Templates → "convex" → Issuer URL.)
//
// When the env var is unset (e.g. local fresh checkout) we fall back to an
// empty providers list so the deployment still builds.

const issuer = process.env.CLERK_ISSUER_URL;

export default {
  providers: issuer ? [{ domain: issuer, applicationID: "convex" }] : [],
};
