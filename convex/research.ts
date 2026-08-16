import { v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { canTransition, initialState, isValidState, nextStates, RESEARCH_KINDS, statesFor } from "@openworks/domain";
import { canEditProject, getUserId, requireOwner } from "./auth";
import { fanOut } from "./agentTriggers";
import { literals } from "./validators";

const RESEARCH_KIND = literals(RESEARCH_KINDS);

export const listByKind = query({
  args: { kind: RESEARCH_KIND, serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const projects = await ctx.db
      .query("researchProjects")
      .withIndex("by_kind_phase", (q) => q.eq("kind", args.kind))
      .collect();
    return projects.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const upsert = mutation({
  args: {
    slug: v.string(),
    title: v.string(),
    kind: RESEARCH_KIND,
    phase: v.string(),
    venue: v.optional(v.string()),
    deadline: v.optional(v.string()),
    notes: v.optional(v.string()),
    keywords: v.optional(v.array(v.string())),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const { serviceKey: _serviceKey, ...fields } = args;
    const existing = await ctx.db
      .query("researchProjects")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    // Only a phase the caller is actually moving has to be in the vocabulary.
    // The browser's title and keyword edits resend the row's own phase
    // verbatim, and a legacy row can hold a phase the current vocabulary no
    // longer has (researchChecklists:migrateLegacyPhases rewrites phases
    // without looking at kind), so validating unconditionally would throw on an
    // edit that never touched the phase and silently discard it.
    const unchanged = existing?.kind === args.kind && existing?.phase === args.phase;
    if (!unchanged && !isValidState(args.kind, args.phase)) {
      throw new Error(`invalid state '${args.phase}' for kind ${args.kind}`);
    }
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { ...fields, updatedAt: now });
      return existing._id;
    }
    return await ctx.db.insert("researchProjects", { ...fields, updatedAt: now });
  },
});

// The UI's phase-write path: the per-project phase select lands here, so it has
// to leave the same trail `advance` does.
export const updatePhase = mutation({
  args: {
    id: v.id("researchProjects"),
    phase: v.string(),
    note: v.optional(v.string()),
    actor: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const project = await ctx.db.get(args.id);
    if (!project) throw new Error("project not found");
    if (!isValidState(project.kind, args.phase)) {
      throw new Error(`invalid state '${args.phase}' for kind ${project.kind}`);
    }
    // Adjacency is deliberately NOT enforced here, unlike `advance`. The live
    // caller is the per-project phase <select>, which offers every state of the
    // kind, so gating on canTransition would make most of its options throw.
    // Only the kind's vocabulary is enforced.
    const now = Date.now();
    await ctx.db.patch(args.id, { phase: args.phase, updatedAt: now });
    await ctx.db.insert("researchTimeline", {
      researchSlug: project.slug,
      state: args.phase,
      at: now,
      note: args.note,
      actor: args.actor,
    });
    await fanOut(ctx, {
      eventType: "state.transitioned",
      entityType: "research",
      entityKey: project.slug,
      researchSlug: project.slug,
    });
    return { slug: project.slug, phase: args.phase, at: now };
  },
});

export const setVisibility = mutation({
  args: {
    id: v.id("researchProjects"),
    visibility: v.union(v.literal("private"), v.literal("workspace"), v.literal("unlisted"), v.literal("public")),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const project = await ctx.db.get(args.id);
    if (!project) throw new Error("project not found");
    // Only enforce ownership when auth is actually configured. On a self-hosted
    // single-user deployment (no CLERK_ISSUER_URL) there is no signed-in user,
    // so the gate would wrongly forbid every edit. This mirrors remove/register
    // which carry no auth gate.
    const authConfigured = Boolean(process.env.CLERK_ISSUER_URL);
    const userId = await getUserId(ctx);
    if (authConfigured && !(await canEditProject(ctx, project, userId))) {
      throw new Error("forbidden: cannot change visibility");
    }
    await ctx.db.patch(args.id, { visibility: args.visibility, updatedAt: Date.now() });
    return { id: args.id, visibility: args.visibility };
  },
});

// Deleting a project used to delete one row and leave every entity scoped to
// its slug behind, so registering the same slug again silently inherited the
// dead project's timeline and memos.
//
// The cascade is bounded and resumable rather than one big transaction, and the
// bound is the part that matters. Convex rolls a whole transaction back when it
// exceeds the 16MB read cap, and a cascade that always restarts in the same
// order would then read the same set and fail the same way on every retry: the
// project would become permanently undeletable, which is worse than the bug
// being fixed. So each call does a small, guaranteed-affordable slice, and the
// caller loops on `done`.
//
// Byte accounting is UTF-8, not string length. JSON.stringify does not escape
// non-ASCII, so a Hangul syllable is one unit of `.length` and three bytes on
// the wire; on this corpus that undercounts by ~3x.
const encoder = new TextEncoder();

export const READ_CAP = 16_777_216; // Convex's per-transaction read limit
export const MAX_DOC_BYTES = 1_048_576; // Convex's per-document ceiling
export const CASCADE_BYTES = 6_000_000;

// The budget is only re-checked BETWEEN pages, so a whole page always lands on
// top of it: the affordable page size is a function of the cap, not a judgement
// about which tables look small. It was a judgement before, and it was wrong -
// the light tables ran at 50, and three of them (researchTables,
// researchExperiments, comments) carry unbounded csv / markdown / latex / body
// text, so one page could read 50MB against a 16MB cap and brick the project.
//
// Every string column in the schema is unbounded, so no table can be shown to
// be light; one derived size covers all of them. Half the headroom rather than
// all of it, because `bytes` is measured with JSON.stringify and that is not
// exactly what Convex bills.
export const CASCADE_PAGE = Math.floor((READ_CAP - CASCADE_BYTES) / MAX_DOC_BYTES / 2);

// Steps are written out one per table rather than looped over a table-name
// union: Convex types an index name against a single table, so the generic
// version only typechecks behind a cast, and a cast here would hide exactly the
// mistake that matters (a table paired with an index it does not have).
const cascadeSteps = (ctx: MutationCtx, slug: string, id: Id<"researchProjects">) => [
  {
    table: "researchTimeline",
    fetch: (n: number) =>
      ctx.db
        .query("researchTimeline")
        .withIndex("by_research_at", (q) => q.eq("researchSlug", slug))
        .take(n),
  },
  {
    table: "researchChecklists",
    fetch: (n: number) =>
      ctx.db
        .query("researchChecklists")
        .withIndex("by_research_iter", (q) => q.eq("researchSlug", slug))
        .take(n),
  },
  {
    table: "researchFiles",
    fetch: (n: number) =>
      ctx.db
        .query("researchFiles")
        .withIndex("by_research", (q) => q.eq("researchSlug", slug))
        .take(n),
  },
  {
    table: "researchCitations",
    fetch: (n: number) =>
      ctx.db
        .query("researchCitations")
        .withIndex("by_research", (q) => q.eq("researchSlug", slug))
        .take(n),
  },
  {
    table: "researchPhaseRuns",
    fetch: (n: number) =>
      ctx.db
        .query("researchPhaseRuns")
        .withIndex("by_research", (q) => q.eq("researchSlug", slug))
        .take(n),
  },
  {
    table: "researchRefs",
    fetch: (n: number) =>
      ctx.db
        .query("researchRefs")
        .withIndex("by_research", (q) => q.eq("researchSlug", slug))
        .take(n),
  },
  {
    table: "researchExperiments",
    fetch: (n: number) =>
      ctx.db
        .query("researchExperiments")
        .withIndex("by_research", (q) => q.eq("researchSlug", slug))
        .take(n),
  },
  {
    table: "researchTables",
    fetch: (n: number) =>
      ctx.db
        .query("researchTables")
        .withIndex("by_research", (q) => q.eq("researchSlug", slug))
        .take(n),
  },
  {
    table: "researchFigures",
    fetch: (n: number) =>
      ctx.db
        .query("researchFigures")
        .withIndex("by_research", (q) => q.eq("researchSlug", slug))
        .take(n),
  },
  {
    table: "researchVenues",
    fetch: (n: number) =>
      ctx.db
        .query("researchVenues")
        .withIndex("by_research", (q) => q.eq("researchSlug", slug))
        .take(n),
  },
  {
    table: "comments",
    fetch: (n: number) =>
      ctx.db
        .query("comments")
        .withIndex("by_research", (q) => q.eq("researchSlug", slug))
        .take(n),
  },
  {
    table: "researchPapers",
    fetch: (n: number) =>
      ctx.db
        .query("researchPapers")
        .withIndex("by_research", (q) => q.eq("researchSlug", slug))
        .take(n),
  },
  {
    table: "researchSections",
    fetch: (n: number) =>
      ctx.db
        .query("researchSections")
        .withIndex("by_research", (q) => q.eq("researchSlug", slug))
        .take(n),
  },
  {
    table: "researchTex",
    fetch: (n: number) =>
      ctx.db
        .query("researchTex")
        .withIndex("by_research", (q) => q.eq("researchSlug", slug))
        .take(n),
  },
  {
    table: "researchMemos",
    fetch: (n: number) =>
      ctx.db
        .query("researchMemos")
        .withIndex("by_research", (q) => q.eq("researchSlug", slug))
        .take(n),
  },
  {
    table: "citationRequests",
    fetch: (n: number) =>
      ctx.db
        .query("citationRequests")
        .withIndex("by_research", (q) => q.eq("researchSlug", slug))
        .take(n),
  },
  {
    table: "agentRuns",
    fetch: (n: number) =>
      ctx.db
        .query("agentRuns")
        .withIndex("by_research", (q) => q.eq("researchSlug", slug))
        .take(n),
  },
  // Scoped by id rather than by slug.
  {
    table: "paperLinks",
    fetch: (n: number) =>
      ctx.db
        .query("paperLinks")
        .withIndex("by_research", (q) => q.eq("researchId", id))
        .take(n),
  },
  {
    table: "projectMemberships",
    fetch: (n: number) =>
      ctx.db
        .query("projectMemberships")
        .withIndex("by_project", (q) => q.eq("projectId", id))
        .take(n),
  },
];

export const remove = mutation({
  args: { id: v.id("researchProjects"), limit: v.optional(v.number()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const project = await ctx.db.get(args.id);
    // Already gone, or a previous call finished the cascade and the caller's
    // loop is catching up.
    if (!project) return { done: true, deleted: 0, remainingIn: null as string | null };
    const slug = project.slug;

    // Math.floor(NaN) is NaN and Math.max(1, NaN) is NaN, so a NaN limit would
    // otherwise make every guard false and report pending work forever.
    const rowBudget = Number.isFinite(args.limit)
      ? Math.max(1, Math.floor(args.limit as number))
      : Number.POSITIVE_INFINITY;

    let deleted = 0;
    let bytes = 0;
    for (const step of cascadeSteps(ctx, slug, args.id)) {
      for (;;) {
        if (deleted >= rowBudget || bytes >= CASCADE_BYTES) {
          return { done: false, deleted, remainingIn: step.table as string | null };
        }
        const page = await step.fetch(Math.min(CASCADE_PAGE, rowBudget - deleted));
        if (page.length === 0) break;
        for (const row of page) {
          bytes += encoder.encode(JSON.stringify(row)).length;
          // Hard delete, not the soft delete comments use elsewhere: a tombstone
          // stays readable, so this loop would re-read it forever and never
          // terminate, and its target is being deleted anyway.
          await ctx.db.delete(row._id);
          deleted++;
        }
      }
    }

    // Last, so a run that stops early leaves the project still listed and still
    // deletable rather than orphaning children where nothing can reach them.
    await ctx.db.delete(args.id);
    return { done: true, deleted, remainingIn: null as string | null };
  },
});

// ── MCP-facing API: register / advance / timeline ──────────────────────

export const register = mutation({
  args: {
    slug: v.string(),
    title: v.string(),
    kind: RESEARCH_KIND,
    venue: v.optional(v.string()),
    deadline: v.optional(v.string()),
    notes: v.optional(v.string()),
    keywords: v.optional(v.array(v.string())),
    rootPath: v.optional(v.string()),
    actor: v.optional(v.string()),
    visibility: v.optional(
      v.union(v.literal("private"), v.literal("workspace"), v.literal("unlisted"), v.literal("public")),
    ),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const userId = await getUserId(ctx);
    const existing = await ctx.db
      .query("researchProjects")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    const now = Date.now();
    if (existing) {
      // Updating an existing project requires edit permission.
      if (!(await canEditProject(ctx, existing, userId))) {
        throw new Error(`forbidden: cannot edit project ${args.slug}`);
      }
      const { actor: _actor, serviceKey: _serviceKey, ...rest } = args;
      await ctx.db.patch(existing._id, { ...rest, updatedAt: now });
      return { id: existing._id, slug: existing.slug, phase: existing.phase, created: false };
    }
    // Creating a new project: ownerId comes from auth when present (otherwise
    // legacy/single-tenant — leave undefined so canEditProject treats it as
    // open until backfilled).
    const phase = initialState(args.kind);
    const { actor, serviceKey: _serviceKey, ...rest } = args;
    const id = await ctx.db.insert("researchProjects", {
      ...rest,
      phase,
      ownerId: userId ?? undefined,
      visibility: args.visibility ?? (userId ? "private" : undefined),
      updatedAt: now,
    });
    await ctx.db.insert("researchTimeline", {
      researchSlug: args.slug,
      state: phase,
      at: now,
      note: "registered",
      actor: actor ?? userId ?? undefined,
    });
    // Auto-add the creator as project owner membership.
    if (userId) {
      await ctx.db.insert("projectMemberships", {
        projectId: id,
        userId,
        role: "owner",
        joinedAt: now,
      });
    }
    return { id, slug: args.slug, phase, created: true };
  },
});

export const advance = mutation({
  args: {
    slug: v.string(),
    state: v.string(),
    note: v.optional(v.string()),
    artifactRef: v.optional(v.string()),
    actor: v.optional(v.string()),
    force: v.optional(v.boolean()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const project = await ctx.db
      .query("researchProjects")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    if (!project) throw new Error(`unknown project: ${args.slug}`);
    if (!isValidState(project.kind, args.state)) {
      throw new Error(`invalid state '${args.state}' for kind ${project.kind}`);
    }
    if (!args.force && !canTransition(project.kind, project.phase, args.state)) {
      const allowed = nextStates(project.kind, project.phase).join(", ");
      throw new Error(
        `transition ${project.phase} → ${args.state} not allowed. valid: [${allowed}] (pass force:true to override)`,
      );
    }
    const now = Date.now();
    await ctx.db.patch(project._id, { phase: args.state, updatedAt: now });
    await ctx.db.insert("researchTimeline", {
      researchSlug: args.slug,
      state: args.state,
      at: now,
      note: args.note,
      artifactRef: args.artifactRef,
      actor: args.actor,
    });
    await fanOut(ctx, {
      eventType: "state.transitioned",
      entityType: "research",
      entityKey: args.slug,
      researchSlug: args.slug,
    });
    return { slug: args.slug, phase: args.state, at: now };
  },
});

export const logArtifact = mutation({
  args: {
    slug: v.string(),
    artifactRef: v.string(),
    note: v.optional(v.string()),
    actor: v.optional(v.string()),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const project = await ctx.db
      .query("researchProjects")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    if (!project) throw new Error(`unknown project: ${args.slug}`);
    const now = Date.now();
    await ctx.db.insert("researchTimeline", {
      researchSlug: args.slug,
      state: project.phase,
      at: now,
      note: args.note,
      artifactRef: args.artifactRef,
      actor: args.actor,
    });
    return { slug: args.slug, phase: project.phase, at: now };
  },
});

export const getStateInfo = query({
  args: { slug: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const project = await ctx.db
      .query("researchProjects")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    if (!project) return null;
    return {
      slug: project.slug,
      title: project.title,
      kind: project.kind,
      phase: project.phase,
      next: nextStates(project.kind, project.phase),
      allStates: statesFor(project.kind),
      updatedAt: project.updatedAt,
    };
  },
});

export const getTimeline = query({
  args: { slug: v.string(), limit: v.optional(v.number()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const entries = await ctx.db
      .query("researchTimeline")
      .withIndex("by_research_at", (q) => q.eq("researchSlug", args.slug))
      .order("desc")
      .take(args.limit ?? 100);
    return entries;
  },
});

export const listAllProjects = query({
  args: { kind: v.optional(RESEARCH_KIND), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const projects = args.kind
      ? await ctx.db
          .query("researchProjects")
          .withIndex("by_kind_phase", (q) => q.eq("kind", args.kind!))
          .collect()
      : await ctx.db.query("researchProjects").collect();
    return projects
      .map((p) => ({ slug: p.slug, title: p.title, kind: p.kind, phase: p.phase, updatedAt: p.updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

// Token-based relevance: lowercase tokens, IDF-weighted overlap.
//
// Hangul is kept only when the corpus is big enough to weigh it, and the
// history is the reason. Stripping it entirely used to be right: research
// titles here are English, Korean summaries keep their English technical terms,
// and reducing a particle-suffixed "transformer" to "transformer" scored on the words the two
// sides actually share. A first attempt at keeping Hangul was reverted, because
// under unweighted jaccard the extra tokens inflate the denominator: a genuine
// single-term match on a 6-sentence Korean summary fell from 0.50 to 0.0145 and
// dropped under the 0.02 gate below, while unrelated Korean cleared that gate on
// generic vocabulary alone (the Korean for "new", "this time", "improved") and outranked real matches.
//
// That revert named its own precondition - stopwords and IDF, not a wider
// character class - and weigherFor is it. A word in every document now weighs
// zero, so the generic vocabulary that produced the false matches cannot carry
// one, without a maintained stopword list.
//
// Hence `keepHangul` is decided by corpus size, not by taste: frequency can
// only separate generic Korean from meaningful Korean once there are enough
// documents to measure it. Below MIN_CORPUS_FOR_IDF this is byte-for-byte the
// ASCII-only behaviour that shipped before, which cannot regress.
//
// Separate from summaries.ts's tokenize on purpose: that one drops tokens
// shorter than 4 characters, and sharing a helper would change its scoring.
function tokenize(text: string, keepHangul: boolean): Set<string> {
  if (!keepHangul) {
    return new Set(
      text
        .toLowerCase()
        .split(/[\s\-_,/·]+/)
        .map((t) => t.replace(/[^\w]/g, ""))
        .filter((t) => t.length > 2),
    );
  }
  return new Set(
    text
      .toLowerCase()
      // Split Hangul runs off whatever they touch. The corpus writes English
      // technical terms with a grammatical particle glued on, and without
      // this the term is unmatchable.
      .replace(/[\uAC00-\uD7A3]+/g, " $& ")
      .split(/[\s\-_,/·]+/)
      .map((t) => t.replace(/[^\w\uAC00-\uD7A3]/g, ""))
      // Two syllables is a whole Korean word where two ASCII
      // letters are not. Frequency, not length, is what suppresses the noise.
      .filter((t) => (HANGUL.test(t) ? t.length >= 2 : t.length > 2)),
  );
}

const HANGUL = /[\uAC00-\uD7A3]/;

// Rarity weighting, measured against this deployment's own summaries rather
// than a hand-written stopword list.
//
// Plain jaccard could not survive Korean text: every token counts the same, so
// the generic words a Korean summary is mostly made of both
// inflated the denominator until real English-term matches fell under the
// threshold, and let unrelated documents match on that generic vocabulary
// alone. Weighting by inverse document frequency fixes both at once, because a
// word in nearly every summary earns a weight of ~0: that covers the stopwords,
// the grammatical particles left behind by the split above, and the house
// vocabulary without anyone maintaining a list.
// Below this many documents, frequency says nothing: in a corpus of one every
// token is "in every document", and a token the query alone carries would look
// rare and outweigh the real match. Under the threshold the scorer stays
// ASCII-only and unweighted, which is byte-for-byte the behaviour that shipped
// before and cannot regress.
const MIN_CORPUS_FOR_IDF = 25;

// Newest-first cap on the corpus scan. Convex has no projection, so reading a
// summary reads its 384-float embedding too, roughly 3KB a row that this scorer
// never looks at. At ~2.4k summaries the unbounded collect() this replaced had
// already crossed the 16MB transaction limit, so the query did not degrade, it
// threw, and the related panel was dead. Bounded to the recent corpus it stays
// well inside the limit; the vector path in convex/embeddings.ts is what covers
// the whole archive.
export const CORPUS_SCAN = 1200;

function weigherFor(docs: readonly Set<string>[]): (token: string) => number {
  if (docs.length < MIN_CORPUS_FOR_IDF) return () => 1;
  const df = new Map<string, number>();
  for (const doc of docs) for (const token of doc) df.set(token, (df.get(token) ?? 0) + 1);
  const total = docs.length;
  // No floor. A token in every document is worth exactly nothing, which is the
  // whole mechanism: a floor of even 0.05 lets nine shared generic words
  // out-vote one rare technical term and the false matches come straight back.
  // The small-corpus case a floor would protect is already handled above.
  return (token) => Math.max(0, Math.log((total + 1) / ((df.get(token) ?? 0) + 1)));
}

function weightedOverlap(a: Set<string>, b: Set<string>, weight: (t: string) => number): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  let union = 0;
  for (const t of a) {
    const w = weight(t);
    union += w;
    if (b.has(t)) inter += w;
  }
  for (const t of b) if (!a.has(t)) union += weight(t);
  return union === 0 ? 0 : inter / union;
}

export const getRelatedJobs = query({
  args: { researchId: v.id("researchProjects"), limit: v.optional(v.number()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const research = await ctx.db.get(args.researchId);
    if (!research) return [];
    const allSummaries = await ctx.db.query("summaries").order("desc").take(CORPUS_SCAN);
    const weighted = allSummaries.length >= MIN_CORPUS_FOR_IDF;
    const researchTokens = tokenize(
      [research.title, research.notes ?? "", (research.keywords ?? []).join(" ")].join(" "),
      weighted,
    );
    if (researchTokens.size === 0) return [];
    // A newsletter job carries one summary per item, so the job's relevance is
    // its best item's, not its first item's. Keeping the first sighting meant a
    // dead-on match at index 7 never surfaced. Scoring every row instead of one
    // per job costs about 12ms of tokenize time per MB of summary text, so even
    // a scan that fills the 16MB transaction cap stays under 250ms of CPU, on
    // bytes the collect() above already paid to read.
    // Tokenize once, then weigh: the document frequencies come from this same
    // corpus, so no second pass over the text.
    const tokenized = allSummaries.map((s) => ({
      row: s,
      tokens: tokenize([s.title, s.summary, s.keywords.join(" ")].join(" "), weighted),
    }));
    const weight = weigherFor(tokenized.map((t) => t.tokens));
    const bestByJob = new Map<string, { jobId: string; score: number; title: string; keywords: string[] }>();
    for (const { row: s, tokens: sumTokens } of tokenized) {
      const key = s.jobId.toString();
      const score = weightedOverlap(researchTokens, sumTokens, weight);
      if (score <= 0.02) continue;
      const prev = bestByJob.get(key);
      if (!prev || score > prev.score) {
        bestByJob.set(key, { jobId: key, score, title: s.title, keywords: s.keywords });
      }
    }
    const scored = [...bestByJob.values()];
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, args.limit ?? 20);
    // Attach the parent job's `type` (paper/article/newsletter/pr-fix) so the
    // UI can render a type badge — saves an N+1 lookup on the frontend.
    // Built into the object rather than assigned afterwards: declaring `type`
    // on the array but never pushing it left it out of the inferred return
    // type, so callers reading `.type` did not typecheck even though the value
    // was there at runtime.
    const withType = [];
    for (const r of top) {
      const job = await ctx.db.get(r.jobId as Id<"jobs">);
      withType.push({ ...r, type: job?.type ?? null });
    }
    return withType;
  },
});

export const getRelatedResearch = query({
  args: { jobId: v.id("jobs"), limit: v.optional(v.number()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const summaries = await ctx.db
      .query("summaries")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    if (summaries.length === 0) return [];
    const allResearch = await ctx.db.query("researchProjects").collect();
    const weighted = allResearch.length >= MIN_CORPUS_FOR_IDF;
    const jobTokens = tokenize(
      summaries.map((s) => `${s.title} ${s.summary} ${s.keywords.join(" ")}`).join(" "),
      weighted,
    );
    const tokenized = allResearch.map((r) => ({
      row: r,
      tokens: tokenize([r.title, r.notes ?? "", (r.keywords ?? []).join(" ")].join(" "), weighted),
    }));
    const weight = weigherFor(tokenized.map((t) => t.tokens));
    const scored: { researchId: string; score: number; title: string; phase: string; kind: string }[] = [];
    for (const { row: r, tokens: rTokens } of tokenized) {
      const score = weightedOverlap(jobTokens, rTokens, weight);
      if (score > 0.02) {
        scored.push({ researchId: r._id.toString(), score, title: r.title, phase: r.phase, kind: r.kind });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, args.limit ?? 10);
  },
});

export const getRelatedPlanItems = query({
  args: { researchId: v.id("researchProjects"), limit: v.optional(v.number()), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const research = await ctx.db.get(args.researchId);
    if (!research) return [];
    const allItems = await ctx.db.query("planItems").order("desc").take(CORPUS_SCAN);
    const weighted = allItems.length >= MIN_CORPUS_FOR_IDF;
    const researchTokens = tokenize(
      [research.title, research.notes ?? "", (research.keywords ?? []).join(" ")].join(" "),
      weighted,
    );
    if (researchTokens.size === 0) return [];
    const tokenized = allItems.map((item) => ({
      row: item,
      tokens: tokenize([item.title, item.notes ?? "", item.tags.join(" ")].join(" "), weighted),
    }));
    const weight = weigherFor(tokenized.map((t) => t.tokens));
    const scored: { itemId: string; score: number; title: string; date: string; tags: string[] }[] = [];
    for (const { row: item, tokens: itemTokens } of tokenized) {
      const score = weightedOverlap(researchTokens, itemTokens, weight);
      if (score > 0.05) {
        scored.push({ itemId: item._id.toString(), score, title: item.title, date: item.date, tags: item.tags });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, args.limit ?? 20);
  },
});
