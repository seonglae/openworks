import type { Doc } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx, ActionCtx } from "./_generated/server";

// `requireOwner` / `getUserId` only read `ctx.auth`, which all three context
// kinds expose — actions (notion / github / embeddings vector search) call
// the gate too, so ActionCtx must be assignable here. The project-level
// helpers below take QueryCtx | MutationCtx only (they touch ctx.db); callers
// narrow to that subset.
export type AuthCtx = QueryCtx | MutationCtx | ActionCtx;
export type Ctx = QueryCtx | MutationCtx;

// Returns the Clerk-issued user id (Clerk JWT subject) when the request is
// authenticated, or null otherwise. Workers calling Convex via the CLI run
// without auth and will see null here.
export async function getUserId(ctx: AuthCtx): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  return identity?.subject ?? null;
}

export async function requireUserId(ctx: AuthCtx): Promise<string> {
  const userId = await getUserId(ctx);
  if (!userId) throw new Error("auth required");
  return userId;
}

// Single-owner lockdown gate for every public function.
//
// - Neither OPENWORKS_OWNER_EMAIL nor OPENWORKS_OWNER_USER_ID set (local dev /
//   fresh checkout / pre-deploy): the OPENWORKS_SERVICE_KEY is the only way in.
//   Unset that too and every call fails with "unconfigured", which is the one
//   state a deployment should never be silently usable in.
// - Set (production): only the owner's Clerk identity (matched by email when
//   OPENWORKS_OWNER_EMAIL is set, else by Clerk subject), or a caller presenting
//   the matching OPENWORKS_SERVICE_KEY (the CLI workers / MCP), may run the
//   function. Everyone else is rejected.
//
// Email matching is preferred: it survives Clerk instance / user-id changes and
// is what the human owner actually knows. It requires the Clerk JWT to carry an
// `email` claim (Convex exposes it on the identity). Use `settings:whoami` to
// confirm what the signed-in identity carries.
//
// Flip to locked ONLY after every worker/MCP callsite passes `serviceKey`,
// otherwise the newsletter / research automation loses backend access.
export async function requireOwner(ctx: AuthCtx, serviceKey?: string): Promise<string> {
  const ownerEmail = process.env.OPENWORKS_OWNER_EMAIL;
  const ownerId = process.env.OPENWORKS_OWNER_USER_ID;
  const key = process.env.OPENWORKS_SERVICE_KEY;
  // An unconfigured deployment used to let every caller through, on the theory
  // that a fresh checkout is a local one. It is not: the deployment URL ships
  // inside the browser bundle, so the first time the UI is reachable the
  // backend is reachable too, by anyone who loads the page. Closed by default
  // instead, and the service key is what opens it. Setup generates one.
  if (!ownerEmail && !ownerId) {
    if (!key) throw new Error("unconfigured: set OPENWORKS_SERVICE_KEY (see README) before calling the backend");
    if (serviceKey && serviceKey === key) return "local";
    throw new Error("auth required");
  }
  if (serviceKey && key && serviceKey === key) return ownerId || ownerEmail!;
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("auth required");
  if (ownerEmail && identity.email === ownerEmail) return identity.subject;
  if (ownerId && identity.subject === ownerId) return identity.subject;
  throw new Error("forbidden");
}

// Project-level read check. Public/unlisted projects are readable by anyone
// (including unauthenticated callers). Private/workspace projects require
// owner or membership. Legacy rows (no ownerId / no visibility) are
// considered owner-of-deployment-only and readable when auth is disabled.
export async function canReadProject(
  ctx: Ctx,
  project: Doc<"researchProjects">,
  userId: string | null,
): Promise<boolean> {
  if (!project.visibility || !project.ownerId) return true; // legacy/single-tenant
  if (project.visibility === "public" || project.visibility === "unlisted") return true;
  if (!userId) return false;
  if (project.ownerId === userId) return true;
  const member = await ctx.db
    .query("projectMemberships")
    .withIndex("by_project_user", (q) => q.eq("projectId", project._id).eq("userId", userId))
    .first();
  return Boolean(member);
}

// Project-level write check. Owner or editor membership required. Legacy
// rows without ownerId pass through (single-tenant compatibility).
export async function canEditProject(
  ctx: Ctx,
  project: Doc<"researchProjects">,
  userId: string | null,
): Promise<boolean> {
  if (!project.ownerId) return true; // legacy
  if (!userId) return false;
  if (project.ownerId === userId) return true;
  const member = await ctx.db
    .query("projectMemberships")
    .withIndex("by_project_user", (q) => q.eq("projectId", project._id).eq("userId", userId))
    .first();
  return Boolean(member && (member.role === "owner" || member.role === "editor"));
}

// Comment-level write check (post/edit/delete). visibility=public/unlisted
// projects allow any authenticated user to comment; private projects require
// at least commenter membership.
export async function canCommentProject(
  ctx: Ctx,
  project: Doc<"researchProjects">,
  userId: string | null,
): Promise<boolean> {
  if (!project.ownerId) return true; // legacy
  if (!userId) return false;
  if (project.visibility === "public") return true;
  if (project.ownerId === userId) return true;
  const member = await ctx.db
    .query("projectMemberships")
    .withIndex("by_project_user", (q) => q.eq("projectId", project._id).eq("userId", userId))
    .first();
  return Boolean(member); // any membership level grants comment
}

// Helper to fetch a project by slug for permission checks.
export async function projectBySlug(ctx: Ctx, slug: string) {
  return await ctx.db
    .query("researchProjects")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .first();
}
