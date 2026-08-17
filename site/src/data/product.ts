// The homepage's meta description and the JSON-LD app node both describe the
// product, at two lengths: a search snippet is cut near 160 characters and
// structured data is not. Sharing the opening sentence keeps the divergence to
// the part that is meant to differ.
export const PRODUCT_LEDE =
  "Self-hosted open-source workspace where humans and AI agents work the same research material while it is still moving.";

// The one-click deploy target, defined once here and pasted into README.md and
// docs/deploy.md, which cannot import it. A test asserts all three agree rather
// than trusting them to.
//
// `products` is what makes this one click instead of two: Convex is a Vercel
// Marketplace integration, so the import flow can provision the backend rather
// than sending you off to create one first. `env` asks for the Clerk key up
// front because a deployment with no identity provider has no way to let its
// owner in, and learning that after the build is worse than being asked before.
const DEPLOY_PARAMS: Record<string, string> = {
  "repository-url": "https://github.com/seonglae/openworks",
  "project-name": "openworks",
  "repository-name": "openworks",
  "demo-title": "Openworks",
  "demo-description":
    "A self-hosted workspace where humans and AI agents work the same material while it is still moving.",
  "demo-url": "https://openworksai.app",
  products: JSON.stringify([
    { type: "integration", integrationSlug: "convex", productSlug: "convex", protocol: "storage" },
  ]),
  env: "VITE_CLERK_PUBLISHABLE_KEY",
  envDescription:
    "Clerk publishable key. The deployment is owner-only, so it needs an identity provider to know who you are.",
  envLink: "https://openworksai.app/docs/deploy/",
};

// URLSearchParams writes a space as `+`, which is right for a form body and only
// tolerated in a query string. Vercel's own examples use %20, and this string is
// pasted into two markdown files where a `+` reads as a typo.
export const DEPLOY_URL = `https://vercel.com/new/clone?${new URLSearchParams(DEPLOY_PARAMS)
  .toString()
  .replace(/\+/g, "%20")}`;
