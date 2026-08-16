import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  AGENT_EVENT_TYPES,
  AUTHOR_TYPES,
  ENTITY_TYPES,
  EXPERIMENT_STATUSES,
  JOB_STATUSES,
  JOB_TYPES,
  PAPER_SOURCES,
  RESEARCH_KINDS,
  SUBSCRIPTION_SCOPES,
} from "@openworks/domain";
import { literals } from "./validators";

// The table definitions are what Convex enforces on every write, so they read
// from the same vocabularies the mutation validators do. Spelled out here
// separately, a vocabulary added to @openworks/domain would be accepted as an
// argument and then rejected at the write.
const ENTITY_TYPE = literals(ENTITY_TYPES);

export default defineSchema({
  // Deployment-level UI/feature settings. Singleton — only one row, looked
  // up by a fixed slug ("default"). No auth: self-hosted plug-n-play OSS,
  // one Convex deployment = one user.
  appSettings: defineTable({
    slug: v.string(),
    // ISO 639-1 language code for agent output (summary, tldr, chat).
    // Defaults to "ko" to preserve current deployments' behavior.
    language: v.optional(v.string()),
    // Ordered list of mode tabs. UI renders MODES filtered + reordered by
    // this. Unknown keys are ignored (forward-compat). Tabs added by future
    // versions but missing from this row are appended at the end disabled.
    tabs: v.array(
      v.object({
        key: v.string(),
        enabled: v.boolean(),
      }),
    ),
    // Setup status / form values per integration. All optional and free-form
    // at this stage — Phase 2+ fills these in.
    github: v.optional(
      v.object({
        username: v.optional(v.string()),
        // Comma-separated org/user list for the PR tab's search scope
        // (e.g. "octocat,my-org"). Distinct from `username`,
        // which the gh-verify setup flow overwrites with the gh CLI's
        // logged-in account.
        orgs: v.optional(v.string()),
        loggedIn: v.optional(v.boolean()),
        lastVerifiedAt: v.optional(v.number()),
      }),
    ),
    google: v.optional(
      v.object({
        account: v.optional(v.string()),
        loggedIn: v.optional(v.boolean()),
        lastVerifiedAt: v.optional(v.number()),
      }),
    ),
    notion: v.optional(
      v.object({
        workspace: v.optional(v.string()),
        rootPageId: v.optional(v.string()),
        // Target Notion database for tab exports (e.g. vocab sync).
        databaseId: v.optional(v.string()),
        configured: v.optional(v.boolean()),
      }),
    ),
    updatedAt: v.number(),
  }).index("by_slug", ["slug"]),

  // Setup queue — UI enqueues install/verify requests, worker.mts polls and
  // shell-execs them. Mirrors mailboxRequests: pending → running → done|error.
  setupRequests: defineTable({
    kind: v.union(
      v.literal("install_gh"),
      v.literal("verify_gh"),
      v.literal("oauth_gh"),
      v.literal("install_gws"),
      v.literal("verify_gws"),
    ),
    // JSON-encoded args (e.g. {"username":"octocat"}).
    params: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("running"), v.literal("done"), v.literal("error")),
    // Short structured result the UI reads (JSON).
    result: v.optional(v.string()),
    // Raw stdout for transparency, capped on the worker side.
    stdout: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_kind_status", ["kind", "status"]),

  jobs: defineTable({
    url: v.string(),
    title: v.optional(v.string()),
    content: v.optional(v.string()),
    // Origin label for auto-registered items (e.g. the RSS feed title). Null for
    // manually-pasted jobs.
    source: v.optional(v.string()),
    type: v.optional(literals(JOB_TYPES)),
    status: literals(JOB_STATUSES),
    error: v.optional(v.string()),
    // Clipboard-pasted screenshot (paper title page / article capture).
    // Worker downloads it to ./tmp and the agent identifies the source
    // from the image, finds the canonical URL, and pulls the full text.
    imageId: v.optional(v.id("_storage")),
    // Multi-image paste: all attached screenshots. `imageId` stays the first one
    // for backward compatibility (older rows + the single-image worker path).
    imageIds: v.optional(v.array(v.id("_storage"))),
    archived: v.optional(v.boolean()),
    // Timestamp set on archive, cleared on unarchive. Used to sort archived
    // list by most-recently-archived, not by original createdAt.
    archivedAt: v.optional(v.number()),
    emailId: v.optional(v.string()),
    provider: v.optional(v.string()),
    createdAt: v.number(),
    // 3-line hover tldr written by the summarization agent after writing the
    // detailed summary. Newsletter: 3 lines of research-relevant news only
    // (drop ads / consumer launches / business deals). Paper: 3 lines as
    // motivation / method+result / takeaway.
    tldr: v.optional(v.array(v.string())),
    // True while the backfill script is actively generating tldr for this
    // job. Cleared as soon as tldr is written (or on explicit fail). UI shows
    // a spinner while this is true.
    tldrPending: v.optional(v.boolean()),
    // Set once pollInsightHarvest has scanned this done job for core insights,
    // so a given newsletter/paper job is harvested for insights exactly once.
    insightsHarvestedAt: v.optional(v.number()),
    // Set when the stored full content was stripped because it is re-fetchable
    // from the job's arXiv URL (cleanup.stripArxivContent). The content field
    // then holds only a short marker pointing at the source.
    contentStrippedAt: v.optional(v.number()),
    // Rescore-only flag: when true, the worker reads the EXISTING summary
    // and full content, then patches only the structured fields (scores,
    // researchLevel, priorWork, reasoning, takeaway tldr) on the existing
    // summary row — no re-summarization, no new summaries row. Cleared
    // after the patch lands.
    scoresOnly: v.optional(v.boolean()),
    // TLDR-only backfill flag (mirror of scoresOnly for jobs that finished
    // before the tldr step existed). Worker reads the existing summaries,
    // generates the 3-line job-level tldr ONLY, and clears the flag. No
    // resummarization, no new suggestions.
    tldrOnly: v.optional(v.boolean()),
    // Telemetry: when this job first transitioned pending → summarizing
    // (kept across reruns — measures wall-clock since first attempt).
    summarizingStartedAt: v.optional(v.number()),
    // When the job reached a terminal status (suggested/done/error). Computed
    // duration = summarizingCompletedAt - summarizingStartedAt.
    summarizingCompletedAt: v.optional(v.number()),
    // Total spawn attempts across all providers in the fallback chain plus
    // any retries triggered by unstick. Lets the UI surface "tried N times"
    // and lets the worker cap retries before forcing error.
    processAttempts: v.optional(v.number()),
    // Cumulative token usage across every agent attempt for this job
    // (input = prompt tokens fed in, output = completion tokens emitted).
    // Filled by the worker after each child closes when the agent reports
    // its usage; remains undefined when the provider doesn't expose tokens.
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    // Set when a "recommended" push notification has already been sent for this
    // job, so re-scoring it doesn't fire a duplicate notification.
    recommendedNotifiedAt: v.optional(v.number()),
    // Author resolution (paper jobs): stamped once OpenAlex has been consulted,
    // whether or not it produced a match, so the sweep never retries forever.
    authorsResolvedAt: v.optional(v.number()),
    openAlexId: v.optional(v.string()),
    // Denormalized rollups of this job's `summaries` rows. The distribution
    // charts used to walk every job and run a per-job summaries query; that
    // N+1 cost ~7.5s on every cache miss and, because Convex ships a
    // consistent snapshot, held the row list behind it. Reading these off the
    // jobs index instead makes the same aggregate a single scan (~0.2s).
    // `summaryScores` holds the overall score of each scored summary (paper
    // `scores.overall` / article `articleScores.overall`); empty for
    // newsletters. Recomputed from truth by syncSummaryAggregates.
    summaryCount: v.optional(v.number()),
    summaryScores: v.optional(v.array(v.number())),
  })
    .index("by_status", ["status"])
    .index("by_createdAt", ["createdAt"])
    .index("by_type_createdAt", ["type", "createdAt"])
    .index("by_type_archived_createdAt", ["type", "archived", "createdAt"])
    .index("by_type_archived_archivedAt", ["type", "archived", "archivedAt"])
    // Insight harvest queue (insights.listHarvestable). Every column of the
    // predicate is in the key, including `insightsHarvestedAt: undefined`, so
    // the worker reads only jobs it can actually harvest instead of scanning a
    // recent window that older unharvested jobs fall out of forever. `archived`
    // stays in the key even though the query walks both of its values, because
    // it comes before `status` in the field order the other job indexes use.
    .index("by_type_archived_status_harvested", ["type", "archived", "status", "insightsHarvestedAt", "createdAt"])
    .index("by_emailId", ["emailId"])
    .index("by_url", ["url"])
    .searchIndex("by_title", {
      searchField: "title",
      filterFields: ["type", "archived"],
    })
    // Opt-in content search — only consulted when the UI toggles "include
    // content". Content blobs (papers especially) can be 100k+ chars, so we
    // keep it off the default search to bound write-amplification cost on
    // the inverted index for cases the user doesn't care about.
    .searchIndex("by_content_text", {
      searchField: "content",
      filterFields: ["type", "archived"],
    }),

  summaries: defineTable({
    jobId: v.id("jobs"),
    index: v.number(),
    title: v.string(),
    category: v.string(),
    summary: v.string(),
    keywords: v.array(v.string()),
    url: v.string(),
    embedding: v.optional(v.array(v.float64())),
    // Structured peer-review fields populated by paper-job agent. Each
    // optional so non-paper jobs and legacy rows stay valid.
    researchLevel: v.optional(v.string()),
    scores: v.optional(
      v.object({
        soundness: v.number(),
        originality: v.number(),
        experiments: v.number(),
        clarity: v.number(),
        impact: v.number(),
        significance: v.number(),
        overall: v.number(),
        confidence: v.optional(v.number()),
      }),
    ),
    priorWork: v.optional(
      v.array(
        v.object({
          citation: v.string(),
          relation: v.string(),
        }),
      ),
    ),
    reasoning: v.optional(v.string()),
    // Structured critique fields for article jobs — the article analogue of
    // `scores`. Six criteria + overall on the same 1-10 scale, plus the
    // verdict string the prose summary already states in section 4
    // ('Very convincing' / 'Mostly convincing' / 'Mixed' / 'Weak' /
    // 'Misleading'). Optional so paper/newsletter rows stay valid.
    articleScores: v.optional(
      v.object({
        evidence: v.number(),
        logic: v.number(),
        objectivity: v.number(),
        novelty: v.number(),
        clarity: v.number(),
        impact: v.number(),
        overall: v.number(),
        verdict: v.optional(v.string()),
      }),
    ),
    // Per-item 3-line tldr (newsletter item or paper). Newsletter: 3 short
    // Korean sentences capturing the core of THIS item. Paper: motivation /
    // method+result / takeaway (same as job-level tldr for single-summary
    // paper jobs).
    tldr: v.optional(v.array(v.string())),
    // Provider that wrote this summary row. Newsletters can fall back per
    // item (gemini → codex → claude), so per-row is more accurate than the
    // job-level provider field.
    provider: v.optional(v.string()),
    // Set once the worker has run paper->research link generation for this
    // summary (even when it produced zero links) so it is not reprocessed.
    paperLinksAt: v.optional(v.number()),
    // Set when the embedding is written. The by_embedded index lets the worker
    // find rows still to embed (embeddedAt undefined) without ever reading the
    // ~3KB vectors of already-embedded rows.
    embeddedAt: v.optional(v.number()),
  })
    .index("by_jobId", ["jobId"])
    .index("by_embedded", ["embeddedAt"])
    .vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 384 })
    .searchIndex("by_summary_text", { searchField: "summary" }),

  chats: defineTable({
    jobId: v.id("jobs"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    createdAt: v.number(),
    needsReply: v.optional(v.boolean()),
    // Provider that authored this assistant reply.
    provider: v.optional(v.string()),
  })
    .index("by_jobId", ["jobId"])
    .index("by_needsReply", ["needsReply"])
    .searchIndex("by_content", { searchField: "content" }),

  suggestions: defineTable({
    jobId: v.id("jobs"),
    summaryIndex: v.number(),
    topic: v.string(),
    pageName: v.string(),
    pageId: v.string(),
    pageUrl: v.string(),
    action: v.string(),
    content: v.string(),
    contextBefore: v.optional(v.string()),
    contextAfter: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("approved"), v.literal("rejected"), v.literal("executed")),
  })
    .index("by_jobId", ["jobId"])
    .index("by_status", ["status"]),

  plans: defineTable({
    slug: v.string(),
    title: v.string(),
    timezone: v.optional(v.string()),
    location: v.optional(v.string()),
    theme: v.optional(v.string()),
    strategy: v.optional(v.string()),
    rawMarkdown: v.string(),
    syncedAt: v.number(),
  }).index("by_slug", ["slug"]),

  planDays: defineTable({
    planSlug: v.string(),
    date: v.string(),
    dayLabel: v.optional(v.string()),
    summary: v.optional(v.string()),
    order: v.number(),
  }).index("by_plan_order", ["planSlug", "order"]),

  planItems: defineTable({
    planSlug: v.string(),
    date: v.string(),
    kind: v.union(v.literal("event"), v.literal("todo")),
    order: v.number(),
    title: v.string(),
    notes: v.optional(v.string()),
    time: v.optional(v.string()),
    timeStart: v.optional(v.string()),
    timeEnd: v.optional(v.string()),
    tier: v.optional(v.number()),
    location: v.optional(v.string()),
    tags: v.array(v.string()),
    done: v.boolean(),
    calendarEventId: v.optional(v.string()),
    embedding: v.optional(v.array(v.float64())),
    embeddedAt: v.optional(v.number()),
  })
    .index("by_plan_date_order", ["planSlug", "date", "order"])
    .index("by_plan_kind", ["planSlug", "kind"])
    .index("by_embedded", ["embeddedAt"])
    .vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 384 }),

  researchProjects: defineTable({
    slug: v.string(),
    title: v.string(),
    kind: literals(RESEARCH_KINDS),
    phase: v.string(),
    venue: v.optional(v.string()),
    deadline: v.optional(v.string()),
    notes: v.optional(v.string()),
    keywords: v.optional(v.array(v.string())),
    rootPath: v.optional(v.string()),
    lastSyncedAt: v.optional(v.number()),
    embedding: v.optional(v.array(v.float64())),
    embeddedAt: v.optional(v.number()),
    // Per-machine project root and references.bib location. machineId is the
    // value of OPENWORKS_MACHINE_ID env var (falls back to os.hostname()).
    // bibRelPath is relative to rootPath, e.g. "paper/references.bib".
    hosts: v.optional(
      v.array(
        v.object({
          machineId: v.string(),
          rootPath: v.string(),
          bibRelPath: v.optional(v.string()),
        }),
      ),
    ),
    // Multi-tenant fields. Legacy rows have ownerId/visibility undefined and are
    // treated as private to the deployment owner until backfilled.
    ownerId: v.optional(v.string()),
    workspaceId: v.optional(v.id("workspaces")),
    visibility: v.optional(
      v.union(v.literal("private"), v.literal("workspace"), v.literal("unlisted"), v.literal("public")),
    ),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_kind_phase", ["kind", "phase"])
    .index("by_owner", ["ownerId"])
    .index("by_workspace", ["workspaceId"])
    .index("by_embedded", ["embeddedAt"])
    .vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 384 }),

  // Workspaces — optional org/team grouping for projects.
  workspaces: defineTable({
    slug: v.string(),
    name: v.string(),
    ownerId: v.string(),
    description: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_owner", ["ownerId"]),

  // Project-level memberships — who can read/comment/edit a specific project.
  projectMemberships: defineTable({
    projectId: v.id("researchProjects"),
    userId: v.string(),
    role: v.union(v.literal("owner"), v.literal("editor"), v.literal("commenter"), v.literal("viewer")),
    invitedBy: v.optional(v.string()),
    joinedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_user", ["userId"])
    .index("by_project_user", ["projectId", "userId"]),

  // Workspace-level memberships — who belongs to a workspace.
  workspaceMemberships: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.string(),
    role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member")),
    invitedBy: v.optional(v.string()),
    joinedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_user", ["userId"])
    .index("by_workspace_user", ["workspaceId", "userId"]),

  // Per-iteration checklist for the pre_submit_check FSM state. iterationN
  // is the number of distinct times the project's phase has entered
  // pre_submit_check (counted from researchTimeline). Each pass tracks its
  // own pass/fail per item.
  researchChecklists: defineTable({
    researchSlug: v.string(),
    iterationN: v.number(),
    itemKey: v.string(),
    checked: v.boolean(),
    checkedAt: v.optional(v.number()),
    note: v.optional(v.string()),
  })
    .index("by_research_iter", ["researchSlug", "iterationN"])
    .index("by_research_iter_item", ["researchSlug", "iterationN", "itemKey"]),

  researchTimeline: defineTable({
    researchSlug: v.string(),
    state: v.string(),
    at: v.number(),
    note: v.optional(v.string()),
    artifactRef: v.optional(v.string()),
    actor: v.optional(v.string()),
  })
    .index("by_research_at", ["researchSlug", "at"])
    .index("by_research_state", ["researchSlug", "state"]),

  researchFiles: defineTable({
    researchSlug: v.string(),
    relPath: v.string(),
    fileType: v.union(
      v.literal("code"),
      v.literal("doc"),
      v.literal("paper"),
      v.literal("config"),
      v.literal("data"),
      v.literal("other"),
    ),
    language: v.optional(v.string()),
    size: v.number(),
    excerpt: v.string(),
    hash: v.string(),
    syncedAt: v.number(),
  })
    .index("by_research", ["researchSlug"])
    .index("by_hash", ["hash"]),

  researchPapers: defineTable({
    researchSlug: v.string(),
    arxivId: v.optional(v.string()),
    title: v.string(),
    authors: v.array(v.string()),
    abstract: v.optional(v.string()),
    url: v.string(),
    source: literals(PAPER_SOURCES),
    // Local PDF path (relative to that host's rootPath) and extracted full
    // text, both populated when the user promotes a citation that has an
    // associated PDF file on disk.
    pdfRelPath: v.optional(v.string()),
    fullText: v.optional(v.string()),
    addedAt: v.number(),
  })
    .index("by_research", ["researchSlug"])
    .index("by_arxivId", ["arxivId"]),

  // Citations extracted from each research project's references.bib (or other
  // bib file located via host.bibRelPath). The user can promote a citation
  // into researchPapers row-by-row from the UI; the worker handles PDF text
  // extraction when a `file` field is present in the bib entry.
  researchCitations: defineTable({
    researchSlug: v.string(),
    key: v.string(),
    title: v.optional(v.string()),
    authors: v.optional(v.array(v.string())),
    year: v.optional(v.string()),
    arxivId: v.optional(v.string()),
    doi: v.optional(v.string()),
    url: v.optional(v.string()),
    pdfRelPath: v.optional(v.string()),
    raw: v.optional(v.string()),
    syncedAt: v.number(),
  })
    .index("by_research", ["researchSlug"])
    .index("by_research_key", ["researchSlug", "key"]),

  // Per-research subagent runs that analyse the project folder (ls,
  // git log, paper/references.bib presence) and infer (a) the project's
  // current phase and (b) the visited timeline with reasons + timestamps.
  researchPhaseRuns: defineTable({
    researchSlug: v.string(),
    rootPath: v.optional(v.string()),
    machineId: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("running"), v.literal("done"), v.literal("error")),
    inferredPhase: v.optional(v.string()),
    inferredHistory: v.optional(v.string()),
    rawOutput: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
  })
    .index("by_status_createdAt", ["status", "createdAt"])
    .index("by_research", ["researchSlug"]),

  // Worker queue for bib syncing + per-row citation→paper promotion (the
  // latter needs PDF read access from a host machine).
  citationRequests: defineTable({
    kind: v.union(v.literal("sync"), v.literal("promote")),
    status: v.union(v.literal("pending"), v.literal("done"), v.literal("error")),
    researchSlug: v.string(),
    citationKey: v.optional(v.string()),
    machineId: v.optional(v.string()),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_status_createdAt", ["status", "createdAt"])
    .index("by_research", ["researchSlug"]),

  // Experiments — venue-independent, owned by project.
  researchExperiments: defineTable({
    researchSlug: v.string(),
    expSlug: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    status: literals(EXPERIMENT_STATUSES),
    params: v.optional(v.string()),
    metrics: v.optional(v.string()),
    artifactRef: v.optional(v.string()),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_research", ["researchSlug"])
    .index("by_research_slug", ["researchSlug", "expSlug"]),

  // Tables — venue-independent results data; rendering can vary per venue.
  researchTables: defineTable({
    researchSlug: v.string(),
    tableSlug: v.string(),
    caption: v.string(),
    csv: v.optional(v.string()),
    markdown: v.optional(v.string()),
    latex: v.optional(v.string()),
    expSlug: v.optional(v.string()),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_research", ["researchSlug"])
    .index("by_research_slug", ["researchSlug", "tableSlug"])
    .index("by_research_exp", ["researchSlug", "expSlug"]),

  // Figures — venue-independent visual artifacts.
  researchFigures: defineTable({
    researchSlug: v.string(),
    figureSlug: v.string(),
    caption: v.string(),
    path: v.optional(v.string()),
    url: v.optional(v.string()),
    format: v.optional(v.string()),
    expSlug: v.optional(v.string()),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_research", ["researchSlug"])
    .index("by_research_slug", ["researchSlug", "figureSlug"])
    .index("by_research_exp", ["researchSlug", "expSlug"]),

  // Venues — paper submission targets (NeurIPS, ICML, workshops). One project → many venues.
  researchVenues: defineTable({
    researchSlug: v.string(),
    venueSlug: v.string(),
    name: v.string(),
    pageLimit: v.optional(v.number()),
    template: v.optional(v.string()),
    deadline: v.optional(v.string()),
    status: v.union(
      v.literal("drafting"),
      v.literal("submitted"),
      v.literal("accepted"),
      v.literal("rejected"),
      v.literal("withdrawn"),
    ),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_research", ["researchSlug"])
    .index("by_research_venue", ["researchSlug", "venueSlug"]),

  // Sections — venue-dependent prose. venueSlug undefined = standalone/canonical.
  researchSections: defineTable({
    researchSlug: v.string(),
    sectionSlug: v.string(),
    venueSlug: v.optional(v.string()),
    title: v.string(),
    content: v.string(),
    format: v.union(v.literal("markdown"), v.literal("latex")),
    order: v.optional(v.number()),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_research", ["researchSlug"])
    .index("by_research_venue", ["researchSlug", "venueSlug"])
    .index("by_research_venue_section", ["researchSlug", "venueSlug", "sectionSlug"]),

  // Tex files — venue-dependent LaTeX sources. venueSlug undefined = standalone.
  researchTex: defineTable({
    researchSlug: v.string(),
    texPath: v.string(),
    venueSlug: v.optional(v.string()),
    content: v.string(),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_research", ["researchSlug"])
    .index("by_research_venue", ["researchSlug", "venueSlug"])
    .index("by_research_venue_path", ["researchSlug", "venueSlug", "texPath"]),

  // Mailbox refresh + markRead requests — frontend triggers, worker fulfills
  // via gws CLI (browser can't call Gmail directly).
  mailboxRequests: defineTable({
    kind: v.union(v.literal("list"), v.literal("markRead")),
    status: v.union(v.literal("pending"), v.literal("running"), v.literal("done"), v.literal("error")),
    emailId: v.optional(v.string()),
    query: v.optional(v.string()),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_status_createdAt", ["status", "createdAt"])
    .index("by_kind_createdAt", ["kind", "createdAt"]),

  // Calendar sync requests — frontend asks worker to pull outlook events for a
  // single plan day via mgc, then planner agent (gemini→codex→claude) folds
  // them into planItems. Worker is the only writer to outlook; we never push.
  calendarRequests: defineTable({
    kind: v.union(v.literal("syncDay")),
    status: v.union(v.literal("pending"), v.literal("done"), v.literal("error")),
    planSlug: v.string(),
    date: v.string(),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_status_createdAt", ["status", "createdAt"])
    .index("by_plan_date", ["planSlug", "date"]),

  // Memos — free-form markdown notes scoped to a project.
  researchMemos: defineTable({
    researchSlug: v.string(),
    memoSlug: v.string(),
    title: v.string(),
    content: v.string(),
    tags: v.optional(v.array(v.string())),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_research", ["researchSlug"])
    .index("by_research_slug", ["researchSlug", "memoSlug"]),

  // What an agent did on a project on one day. Distinct from a timeline note,
  // which only exists when a phase actually moved: most days nothing advances,
  // and those are exactly the days a standup still has something to say. One
  // row per project per author per day, so a second call the same day corrects
  // the report rather than appending a duplicate.
  //
  // `day` is supplied by the caller rather than derived from Date.now(), for
  // the same reason the vocabulary scheduler takes one: the server's UTC day is
  // still yesterday through the first nine hours of every KST day, so a report
  // written in the morning would file itself under the previous date.
  researchReports: defineTable({
    researchSlug: v.string(),
    day: v.string(), // YYYY-MM-DD in the author's local day
    author: v.string(), // codex / gemini / claude, or an agent id
    body: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_day", ["day"])
    .index("by_research_day", ["researchSlug", "day"])
    .index("by_research_day_author", ["researchSlug", "day", "author"]),

  // Agent subscriptions — declarative bindings: "agent X reacts to event Y on
  // entity type Z within scope S". Trigger fan-out checks this table on every
  // significant entity mutation and inserts agentRuns rows for matches.
  agentSubscriptions: defineTable({
    agentId: v.string(),
    eventType: literals(AGENT_EVENT_TYPES),
    targetType: v.optional(ENTITY_TYPE),
    scope: literals(SUBSCRIPTION_SCOPES),
    scopeId: v.optional(v.string()),
    config: v.optional(v.string()),
    enabled: v.boolean(),
    createdBy: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_event", ["eventType", "enabled"])
    .index("by_agent", ["agentId"])
    .index("by_scope", ["scope", "scopeId"]),

  // Agent runs — pending/running/done log of triggered agent calls. Worker
  // polls status="pending" and dispatches via the same gemini→codex→claude
  // chain used for newsletters.
  agentRuns: defineTable({
    subscriptionId: v.id("agentSubscriptions"),
    agentId: v.string(),
    triggerType: v.string(),
    triggerEntityType: v.string(),
    triggerEntityKey: v.string(),
    triggerEntityVenueSlug: v.optional(v.string()),
    researchSlug: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("running"), v.literal("done"), v.literal("error")),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
  })
    .index("by_status_createdAt", ["status", "createdAt"])
    .index("by_subscription", ["subscriptionId"])
    .index("by_research", ["researchSlug"])
    .index("by_agent_status", ["agentId", "status"]),

  // Comments — polymorphic, threaded, soft-deletable. Attaches to any research entity.
  // For section/tex targets, targetVenueSlug disambiguates which venue copy.
  comments: defineTable({
    researchSlug: v.string(),
    targetType: ENTITY_TYPE,
    targetKey: v.string(),
    targetVenueSlug: v.optional(v.string()),
    parentId: v.optional(v.id("comments")),
    authorType: literals(AUTHOR_TYPES),
    authorId: v.string(),
    authorName: v.optional(v.string()),
    body: v.string(),
    deleted: v.optional(v.boolean()),
    editedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_research", ["researchSlug"])
    .index("by_target", ["researchSlug", "targetType", "targetKey", "createdAt"])
    .index("by_parent", ["parentId", "createdAt"])
    .index("by_author", ["authorType", "authorId", "createdAt"]),

  // References — directed edges between entities. Scoped to a project.
  // fromVenueSlug/toVenueSlug only meaningful when corresponding type ∈ {section,tex}.
  researchRefs: defineTable({
    researchSlug: v.string(),
    fromType: ENTITY_TYPE,
    fromKey: v.string(),
    fromVenueSlug: v.optional(v.string()),
    toType: ENTITY_TYPE,
    toKey: v.string(),
    toVenueSlug: v.optional(v.string()),
    context: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_research", ["researchSlug"])
    .index("by_from", ["researchSlug", "fromType", "fromKey"])
    .index("by_to", ["researchSlug", "toType", "toKey"]),

  links: defineTable({
    fromType: v.string(),
    fromId: v.string(),
    toType: v.string(),
    toId: v.string(),
    linkType: v.union(v.literal("auto"), v.literal("manual")),
    score: v.number(),
    reason: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_from", ["fromType", "fromId"])
    .index("by_to", ["toType", "toId"]),

  machineConfig: defineTable({
    machineId: v.string(),
    projectRoots: v.array(v.object({ slug: v.string(), path: v.string() })),
    prRoot: v.optional(v.string()),
    reviewRoot: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_machine", ["machineId"]),

  emailDigests: defineTable({
    emailId: v.string(),
    threadId: v.string(),
    from: v.string(),
    subject: v.string(),
    snippet: v.string(),
    labels: v.array(v.string()),
    scores: v.object({
      surprise: v.number(),
      urgency: v.number(),
      positivity: v.number(),
      relevance: v.number(),
    }),
    category: v.string(),
    oneLiner: v.string(),
    digestDate: v.string(),
    createdAt: v.number(),
  })
    .index("by_digestDate", ["digestDate"])
    .index("by_emailId", ["emailId"]),

  // One row per digest the worker has sent. The worker is the only thing that
  // can send one (gws is a local CLI), and it restarts often, so the period is
  // the identity: claiming a periodKey is what stops a restart from mailing
  // the same morning twice, and the row surviving is what stops a machine that
  // was asleep at 08:00 from skipping the day entirely.
  digestSends: defineTable({
    kind: v.union(v.literal("daily"), v.literal("weekly")),
    // Local calendar day (YYYY-MM-DD) for daily, ISO week (YYYY-Www) for weekly.
    periodKey: v.string(),
    claimedAt: v.number(),
    sentAt: v.optional(v.number()),
    subject: v.optional(v.string()),
    error: v.optional(v.string()),
  }).index("by_kind_period", ["kind", "periodKey"]),

  drawings: defineTable({
    title: v.string(),
    // Canvas body lives in `drawingContents`. Listing the gallery reads every
    // row, and `elements` was three quarters of those bytes while never being
    // part of the response — only the editor, one drawing at a time, needs it.
    // Optional here purely so pre-split rows stay valid until migrateContents
    // has drained them.
    elements: v.optional(v.string()),
    appState: v.optional(v.string()),
    thumbnail: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_updatedAt", ["updatedAt"]),

  drawingContents: defineTable({
    drawingId: v.id("drawings"),
    elements: v.string(),
    appState: v.optional(v.string()),
  }).index("by_drawingId", ["drawingId"]),

  // Diet tab: one row per logged food. The user uploads a photo; the worker
  // agent identifies the dish and deep-researches calories + macros, then
  // patches the row. Mirrors the jobs pipeline (pending -> analyzing -> done).
  foodEntries: defineTable({
    imageId: v.optional(v.id("_storage")),
    date: v.string(), // YYYY-MM-DD, user's local day
    status: v.union(v.literal("pending"), v.literal("analyzing"), v.literal("done"), v.literal("error")),
    name: v.optional(v.string()),
    kcal: v.optional(v.number()),
    protein: v.optional(v.number()),
    carbs: v.optional(v.number()),
    fat: v.optional(v.number()),
    notes: v.optional(v.string()),
    provider: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_date", ["date"])
    .index("by_status", ["status"]),

  // EN/JP expression study with spaced repetition (SM-2-ish). One row per
  // phrase; `due` is the next review day, advanced by the review grade.
  expressions: defineTable({
    en: v.string(),
    jp: v.optional(v.string()),
    reading: v.optional(v.string()), // furigana / romaji
    meaning: v.optional(v.string()),
    example: v.optional(v.string()),
    // Pronunciation of the English headword, for the study list the digest
    // mails out: `ipa` is the phonetic notation, `ko` the Hangul
    // approximation. Both describe `en`; the Japanese side already has
    // `reading`. Filled by the same worker enrichment as the fields above, so
    // rows created before this stay valid and simply carry neither.
    ipa: v.optional(v.string()),
    ko: v.optional(v.string()),
    due: v.string(), // YYYY-MM-DD next review
    intervalDays: v.number(),
    reps: v.number(),
    ease: v.number(), // ease factor x100 (e.g. 250)
    // True while the worker agent is filling jp/reading/meaning/example from
    // the English phrase. Cleared once enriched.
    pendingEnrich: v.optional(v.boolean()),
    createdAt: v.number(),
  })
    .index("by_due", ["due"])
    .index("by_pending", ["pendingEnrich"])
    .index("by_createdAt", ["createdAt"]),

  // RSS / Atom feed subscriptions. A daily Convex cron polls each enabled feed
  // and auto-registers new items as `article` jobs (then the normal worker
  // summarizes them). seenLinks holds the most-recent item links (capped) so
  // re-polls don't re-create jobs.
  feeds: defineTable({
    url: v.string(),
    title: v.string(),
    enabled: v.boolean(),
    // When true, the first poll registers ALL current items (backfill) instead
    // of only seeding the seen-set; cleared after that first poll.
    pendingBackfill: v.optional(v.boolean()),
    lastPolledAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    seenLinks: v.optional(v.array(v.string())),
    itemCount: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_enabled", ["enabled"]),

  // Web Push (VAPID) subscriptions. One row per browser/PWA install that opted
  // in to notifications. `endpoint` is the unique push service URL; `keys` holds
  // the client's p256dh + auth secrets needed to encrypt payloads.
  pushSubscriptions: defineTable({
    endpoint: v.string(),
    keys: v.object({ p256dh: v.string(), auth: v.string() }),
    userId: v.optional(v.string()),
    label: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_endpoint", ["endpoint"]),

  // Agent-judged "this paper is worth referencing in this research project"
  // links, surfaced in the paper tab's suggestion step. A loose 384-dim vector
  // prefilter recalls candidate projects; the worker CLI agent then decides
  // which are genuine (no forced matches) and writes a row per accepted one.
  // status: suggested (awaiting user) -> linked (user kept it) / rejected.
  paperLinks: defineTable({
    jobId: v.id("jobs"),
    summaryId: v.id("summaries"),
    researchId: v.id("researchProjects"),
    researchSlug: v.string(),
    researchTitle: v.string(),
    score: v.number(),
    reason: v.string(),
    status: v.union(v.literal("suggested"), v.literal("linked"), v.literal("rejected")),
    createdAt: v.number(),
  })
    .index("by_job", ["jobId"])
    .index("by_summary", ["summaryId"])
    .index("by_research", ["researchId"]),

  // Insights tab: short quotes / core ideas the user collects (a few sentences,
  // at most one paragraph). Each row is enriched by the worker (interpretation,
  // evaluation, source, tags) and assigned the single best Notion page
  // for placement as a quote block. Entry is manual paste (text), a pasted
  // screenshot (worker extracts the quote from the image), or high-bar
  // auto-harvest from done newsletter/paper jobs.
  insights: defineTable({
    text: v.string(), // original insight, verbatim; may start empty for image-only rows
    imageId: v.optional(v.id("_storage")), // pasted screenshot; worker extracts text from it
    source: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
    origin: v.union(v.literal("manual"), v.literal("newsletter"), v.literal("paper"), v.literal("notion")),
    originJobId: v.optional(v.id("jobs")),
    interpretation: v.optional(v.string()),
    evaluation: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    provider: v.optional(v.string()),
    notionPageId: v.optional(v.string()),
    notionPageName: v.optional(v.string()),
    notionPageUrl: v.optional(v.string()),
    notionContent: v.optional(v.string()),
    notionContextBefore: v.optional(v.string()),
    notionContextAfter: v.optional(v.string()),
    notionReason: v.optional(v.string()),
    status: v.union(
      v.literal("new"),
      v.literal("suggested"),
      v.literal("placed"),
      v.literal("dismissed"),
      v.literal("error"),
    ),
    error: v.optional(v.string()),
    placedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_status_createdAt", ["status", "createdAt"])
    .index("by_createdAt", ["createdAt"]),

  // One row per (paper, author). `authorId` is OpenAlex's disambiguated author
  // entity, so two different researchers who share a name stay separate and one
  // researcher publishing under name variants stays merged. When OpenAlex has
  // no entity for an author the row falls back to a name-derived key and is
  // marked unresolved, so the UI can be honest about which rows are guesses.
  paperAuthors: defineTable({
    jobId: v.id("jobs"),
    authorId: v.string(),
    name: v.string(),
    orcid: v.optional(v.string()),
    institution: v.optional(v.string()),
    // OpenAlex author_position: first | middle | last.
    position: v.string(),
    seq: v.number(),
    resolved: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_job", ["jobId"])
    .index("by_author", ["authorId"])
    .index("by_author_position", ["authorId", "position"]),

  // Per-author rollup, rebuilt by authors:recomputeStats. Leaderboards sort on
  // stored fields so ranking is a paginated index scan instead of an aggregate
  // over every paper on each page view.
  authorStats: defineTable({
    authorId: v.string(),
    name: v.string(),
    orcid: v.optional(v.string()),
    institution: v.optional(v.string()),
    // Author position and metric are independent axes, so every count has a
    // matching score over the same subset of papers: ranking by score as first
    // author must not be swayed by papers the researcher merely co-authored.
    paperCount: v.number(),
    firstCount: v.number(),
    lastCount: v.number(),
    // Shrunk mean: (C*globalMean + sum) / (C + n). Papers without a score are
    // excluded from the mean but still counted in the matching *Count.
    scoreAll: v.number(),
    scoreFirst: v.number(),
    scoreLast: v.number(),
    rawAll: v.number(),
    rawFirst: v.number(),
    rawLast: v.number(),
    scoredAll: v.number(),
    scoredFirst: v.number(),
    scoredLast: v.number(),
    lastPaperAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_authorId", ["authorId"])
    .index("by_paperCount", ["paperCount"])
    .index("by_firstCount", ["firstCount"])
    .index("by_lastCount", ["lastCount"])
    .index("by_scoreAll", ["scoreAll"])
    .index("by_scoreFirst", ["scoreFirst"])
    .index("by_scoreLast", ["scoreLast"]),

  // Vectors live beside their subject rather than inside it, for two reasons.
  //
  // Convex reads whole documents, so while a 384-float vector sat on a summary
  // every listing that touched summaries paid for it: one weekly digest read
  // 58KB of vectors it never looked at, roughly twice the weight of the text it
  // was actually assembling. Moving them out makes those reads text-only, and
  // makes the vector's width stop mattering to anything except vector search.
  //
  // It also makes the embedding model data instead of schema. Two models can
  // hold vectors for the same row at once, filtered apart at search time, so a
  // new model is evaluated against the live corpus and the old one is still
  // there to fall back to. `dimensions` is fixed per index, so models of a
  // different width need their own field and index alongside this one.
  // ── Usage ───────────────────────────────────────────────────────────────
  // One row per (browser tab × view) visit, plus the ordered event stream
  // behind it. The rollup exists because "how long was I in Research this
  // week" is the question actually asked, and answering it by replaying the
  // stream reads every event in the window to produce one number.
  //
  // The event envelope stays generic on purpose: `type`/`target`/`value` means
  // a new kind of event is a string, not a migration.
  usageSessions: defineTable({
    // One browser tab's lifetime. Reused across views inside that tab, so it
    // is not a key on its own.
    sessionId: v.string(),
    // Survives tab close, so a week's work is one person rather than forty.
    visitorId: v.string(),
    // Which view: the same keys as MODE_KEYS.
    tab: v.string(),
    startedAt: v.number(),
    lastAt: v.number(),
    // Engaged time, not wall clock: a tab left open overnight earns none of
    // it. Accumulated client-side and sent as a total, so a session whose last
    // flush never lands still keeps the time it had already reported.
    activeMs: v.number(),
    eventCount: v.number(),
    device: v.optional(v.string()),
    viewport: v.optional(v.string()),
    // Where the app was served from. A localhost session is usually the
    // developer building the tool rather than anyone using it, and the
    // dashboard filters on this when reading rather than dropping it on
    // write, so changing your mind re-scores history.
    host: v.optional(v.string()),
  })
    .index("by_session_tab", ["sessionId", "tab"])
    .index("by_startedAt", ["startedAt"])
    .index("by_tab_startedAt", ["tab", "startedAt"]),

  usageEvents: defineTable({
    sessionId: v.string(),
    tab: v.string(),
    // Assigned server-side, so a batch that arrives out of order still
    // reconstructs one ordered journey.
    seq: v.number(),
    ts: v.number(),
    type: v.string(),
    target: v.optional(v.string()),
    value: v.optional(v.union(v.number(), v.string())),
    meta: v.optional(v.any()),
  })
    .index("by_session_seq", ["sessionId", "seq"])
    .index("by_ts", ["ts"])
    // Tab-to-tab movement needs every pageview in a window regardless of which
    // view it landed on, which no tab-scoped index can answer.
    .index("by_type_ts", ["type", "ts"]),

  embeddings: defineTable({
    // The model id exactly as the embedder loads it, e.g.
    // "Xenova/all-MiniLM-L6-v2". Comparing two models means writing both and
    // filtering on this.
    model: v.string(),
    targetTable: v.union(v.literal("summaries"), v.literal("researchProjects"), v.literal("planItems")),
    // Not v.id(): one table addresses three, and Convex ids are typed per table.
    targetId: v.string(),
    // `model::targetTable`, pre-joined because a vector search narrows on a
    // single filter field. Convex's vector filter builder has eq and or and no
    // and, so "this model, on this kind of row" cannot be expressed as two
    // conditions and has to arrive as one value. Derived by embedScope; never
    // set it by hand.
    scope: v.string(),
    // One field per width, because a vector index fixes its dimensions and a
    // model cannot be swapped for a wider one inside the same index. A row
    // fills exactly the field matching the model that wrote it, which is what
    // lets a 384-dim model keep answering while a 640-dim one backfills beside
    // it. Adding a model of a new width means adding a field and an index here,
    // not migrating the ones already stored.
    vec: v.optional(v.array(v.float64())),
    vec640: v.optional(v.array(v.float64())),
    createdAt: v.number(),
  })
    // Reading or replacing one subject's vector for one model.
    .index("by_target_model", ["targetTable", "targetId", "model"])
    // Sweeping everything a given model wrote, for eviction or a count.
    .index("by_model_target", ["model", "targetTable"])
    .vectorIndex("by_vec", {
      vectorField: "vec",
      dimensions: 384,
      filterFields: ["scope"],
    })
    .vectorIndex("by_vec640", {
      vectorField: "vec640",
      dimensions: 640,
      filterFields: ["scope"],
    }),
});
