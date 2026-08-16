#!/usr/bin/env node
// research-mcp — stdio MCP server that lets agent CLIs (codex / gemini /
// claude) self-manage research project state in Convex.
//
// Tools: register, get_state, advance, log_artifact, timeline, list_projects
//
// Run directly:  node mcp/research-server.mjs
// Reads the Convex deployment from CONVEX_DEPLOYMENT, or from .env.local when
// the CLI is run without one exported.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile } from "child_process";
import { promisify } from "util";
import { resolve } from "path";
import { z } from "zod";

const execFileP = promisify(execFile);

const PROJECT_ROOT = resolve(new URL("..", import.meta.url).pathname);
const CONVEX_BIN = resolve(PROJECT_ROOT, "node_modules/.bin/convex");
// No fallback on purpose: a wrong deployment name fails with a confusing
// "function not found" from someone else's backend, so an unset one should
// stop here instead.
const DEPLOYMENT = process.env.CONVEX_DEPLOYMENT;

// Single-owner service key, injected into every backend call so the MCP server
// (admin CLI, no Clerk session) clears the requireOwner gate once it is set.
const OPENWORKS_SERVICE_KEY = process.env.OPENWORKS_SERVICE_KEY;

async function convex(fn, args = {}) {
  if (OPENWORKS_SERVICE_KEY && args && typeof args === "object" && args.serviceKey == null) {
    args = { ...args, serviceKey: OPENWORKS_SERVICE_KEY };
  }
  const argJson = JSON.stringify(args);
  const { stdout } = await execFileP(CONVEX_BIN, ["run", fn, argJson], {
    cwd: PROJECT_ROOT,
    // Only override when we actually have one. Passing an undefined value
    // through would reach the CLI as the string "undefined" and beat the
    // .env.local it would otherwise have read for itself.
    env: DEPLOYMENT ? { ...process.env, CONVEX_DEPLOYMENT: DEPLOYMENT } : process.env,
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function asContent(value) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

function asError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: msg }] };
}

const server = new McpServer({ name: "research-mcp", version: "0.1.0" });

server.registerTool(
  "register",
  {
    title: "Register research project",
    description: "Create or update a research project. Initial state defaults to 'ideation' (own) or 'setup' (review).",
    inputSchema: {
      slug: z.string().describe("unique identifier, e.g. 'vect-2026'"),
      title: z.string(),
      kind: z.enum(["own", "review"]).default("own"),
      venue: z.string().optional(),
      deadline: z.string().optional(),
      notes: z.string().optional(),
      keywords: z.array(z.string()).optional(),
      rootPath: z.string().optional().describe("absolute path to project on disk"),
      actor: z.string().optional().describe("agent identifier, e.g. 'codex'"),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("research:register", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "get_state",
  {
    title: "Get research state",
    description: "Return current phase + valid next states for a project.",
    inputSchema: { slug: z.string() },
  },
  async (args) => {
    try {
      const result = await convex("research:getStateInfo", args);
      if (!result) return asError(`unknown project: ${args.slug}`);
      return asContent(result);
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "advance",
  {
    title: "Advance research state",
    description:
      "Transition the project to a new state. Validated against the FSM; pass force:true to override (logs the override but skips edge validation).",
    inputSchema: {
      slug: z.string(),
      state: z.string(),
      note: z.string().optional(),
      artifactRef: z.string().optional().describe("path or URL of artifact produced in this state"),
      actor: z.string().optional(),
      force: z.boolean().optional(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("research:advance", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "log_artifact",
  {
    title: "Log artifact",
    description: "Record an artifact (file path, URL) at the project's current state without changing state.",
    inputSchema: {
      slug: z.string(),
      artifactRef: z.string(),
      note: z.string().optional(),
      actor: z.string().optional(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("research:logArtifact", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "timeline",
  {
    title: "Get project timeline",
    description: "Return state-transition history for a project, newest first.",
    inputSchema: { slug: z.string(), limit: z.number().int().positive().optional() },
  },
  async (args) => {
    try {
      return asContent(await convex("research:getTimeline", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "list_projects",
  {
    title: "List projects",
    description: "List all registered research projects, optionally filtered by kind.",
    inputSchema: { kind: z.enum(["own", "review"]).optional() },
  },
  async (args) => {
    try {
      return asContent(await convex("research:listAllProjects", args));
    } catch (e) {
      return asError(e);
    }
  },
);

// ── Experiments ──────────────────────────────────────────────────────────

server.registerTool(
  "save_experiment",
  {
    title: "Save experiment",
    description:
      "Create or update an experiment record (upsert by researchSlug+expSlug). Venue-independent. Use to track planned/running/done/failed experiments with their params and metrics.",
    inputSchema: {
      researchSlug: z.string(),
      expSlug: z.string().describe("unique within project, e.g. 'ablation-lr-3e4'"),
      name: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(["planned", "running", "done", "failed"]).optional(),
      params: z.string().optional().describe("JSON-encoded hyperparameters"),
      metrics: z.string().optional().describe("JSON-encoded result metrics"),
      artifactRef: z.string().optional().describe("path to logs/checkpoint"),
      notes: z.string().optional(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("researchExperiments:save", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "get_experiment",
  {
    title: "Get experiment",
    description: "Fetch a single experiment by researchSlug+expSlug.",
    inputSchema: { researchSlug: z.string(), expSlug: z.string() },
  },
  async (args) => {
    try {
      const result = await convex("researchExperiments:get", args);
      if (!result) return asError(`experiment not found: ${args.expSlug}`);
      return asContent(result);
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "list_experiments",
  {
    title: "List experiments",
    description: "List all experiments for a project, optionally filtered by status.",
    inputSchema: {
      researchSlug: z.string(),
      status: z.enum(["planned", "running", "done", "failed"]).optional(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("researchExperiments:list", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "delete_experiment",
  {
    title: "Delete experiment",
    description: "Remove an experiment record by researchSlug+expSlug.",
    inputSchema: { researchSlug: z.string(), expSlug: z.string() },
  },
  async (args) => {
    try {
      return asContent(await convex("researchExperiments:remove", args));
    } catch (e) {
      return asError(e);
    }
  },
);

// ── Tables ───────────────────────────────────────────────────────────────

server.registerTool(
  "save_table",
  {
    title: "Save table",
    description:
      "Create or update a result table (upsert by researchSlug+tableSlug). Venue-independent. Store csv/markdown/latex variants as needed; link to source experiment via expSlug.",
    inputSchema: {
      researchSlug: z.string(),
      tableSlug: z.string(),
      caption: z.string().optional(),
      csv: z.string().optional(),
      markdown: z.string().optional(),
      latex: z.string().optional(),
      expSlug: z.string().optional().describe("source experiment slug"),
      notes: z.string().optional(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("researchTables:save", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "get_table",
  {
    title: "Get table",
    description: "Fetch a single table by researchSlug+tableSlug.",
    inputSchema: { researchSlug: z.string(), tableSlug: z.string() },
  },
  async (args) => {
    try {
      const result = await convex("researchTables:get", args);
      if (!result) return asError(`table not found: ${args.tableSlug}`);
      return asContent(result);
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "list_tables",
  {
    title: "List tables",
    description: "List all tables for a project, optionally filtered by source experiment.",
    inputSchema: { researchSlug: z.string(), expSlug: z.string().optional() },
  },
  async (args) => {
    try {
      return asContent(await convex("researchTables:list", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "delete_table",
  {
    title: "Delete table",
    description: "Remove a table by researchSlug+tableSlug.",
    inputSchema: { researchSlug: z.string(), tableSlug: z.string() },
  },
  async (args) => {
    try {
      return asContent(await convex("researchTables:remove", args));
    } catch (e) {
      return asError(e);
    }
  },
);

// ── Figures ──────────────────────────────────────────────────────────────

server.registerTool(
  "save_figure",
  {
    title: "Save figure",
    description:
      "Create or update a figure record (upsert by researchSlug+figureSlug). Venue-independent. Store path or URL plus caption; link to source experiment via expSlug.",
    inputSchema: {
      researchSlug: z.string(),
      figureSlug: z.string(),
      caption: z.string().optional(),
      path: z.string().optional().describe("file path on disk"),
      url: z.string().optional(),
      format: z.string().optional().describe("png/pdf/svg/..."),
      expSlug: z.string().optional(),
      notes: z.string().optional(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("researchFigures:save", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "get_figure",
  {
    title: "Get figure",
    description: "Fetch a single figure by researchSlug+figureSlug.",
    inputSchema: { researchSlug: z.string(), figureSlug: z.string() },
  },
  async (args) => {
    try {
      const result = await convex("researchFigures:get", args);
      if (!result) return asError(`figure not found: ${args.figureSlug}`);
      return asContent(result);
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "list_figures",
  {
    title: "List figures",
    description: "List all figures for a project, optionally filtered by source experiment.",
    inputSchema: { researchSlug: z.string(), expSlug: z.string().optional() },
  },
  async (args) => {
    try {
      return asContent(await convex("researchFigures:list", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "delete_figure",
  {
    title: "Delete figure",
    description: "Remove a figure by researchSlug+figureSlug.",
    inputSchema: { researchSlug: z.string(), figureSlug: z.string() },
  },
  async (args) => {
    try {
      return asContent(await convex("researchFigures:remove", args));
    } catch (e) {
      return asError(e);
    }
  },
);

// ── Venues ───────────────────────────────────────────────────────────────

server.registerTool(
  "save_venue",
  {
    title: "Save venue",
    description:
      "Register or update a paper-submission venue (upsert by researchSlug+venueSlug). Sections and tex files reference venueSlug to scope their content; venue is optional for canonical/standalone artifacts.",
    inputSchema: {
      researchSlug: z.string(),
      venueSlug: z.string().describe("e.g. 'neurips2026', 'icml2026-workshop'"),
      name: z.string().optional(),
      pageLimit: z.number().int().positive().optional(),
      template: z.string().optional(),
      deadline: z.string().optional(),
      status: z.enum(["drafting", "submitted", "accepted", "rejected", "withdrawn"]).optional(),
      notes: z.string().optional(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("researchVenues:save", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "get_venue",
  {
    title: "Get venue",
    description: "Fetch a single venue by researchSlug+venueSlug.",
    inputSchema: { researchSlug: z.string(), venueSlug: z.string() },
  },
  async (args) => {
    try {
      const result = await convex("researchVenues:get", args);
      if (!result) return asError(`venue not found: ${args.venueSlug}`);
      return asContent(result);
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "list_venues",
  {
    title: "List venues",
    description: "List all venues registered for a project.",
    inputSchema: { researchSlug: z.string() },
  },
  async (args) => {
    try {
      return asContent(await convex("researchVenues:list", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "delete_venue",
  {
    title: "Delete venue",
    description: "Remove a venue by researchSlug+venueSlug. Does not cascade to sections/tex.",
    inputSchema: { researchSlug: z.string(), venueSlug: z.string() },
  },
  async (args) => {
    try {
      return asContent(await convex("researchVenues:remove", args));
    } catch (e) {
      return asError(e);
    }
  },
);

// ── Sections (venue-scoped) ──────────────────────────────────────────────

server.registerTool(
  "save_section",
  {
    title: "Save section",
    description:
      "Create or update a paper section (upsert by researchSlug+venueSlug+sectionSlug). Omit venueSlug for the canonical/standalone version. Use 'fork_section' to copy across venues.",
    inputSchema: {
      researchSlug: z.string(),
      sectionSlug: z.string().describe("e.g. 'abstract', 'intro', 'method', 'experiments'"),
      venueSlug: z.string().optional().describe("omit for canonical/standalone"),
      title: z.string().optional(),
      content: z.string().optional(),
      format: z.enum(["markdown", "latex"]).optional(),
      order: z.number().int().optional(),
      notes: z.string().optional(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("researchSections:save", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "get_section",
  {
    title: "Get section",
    description: "Fetch a single section. Omit venueSlug for the canonical/standalone version.",
    inputSchema: {
      researchSlug: z.string(),
      sectionSlug: z.string(),
      venueSlug: z.string().optional(),
    },
  },
  async (args) => {
    try {
      const result = await convex("researchSections:get", args);
      if (!result) return asError(`section not found: ${args.sectionSlug}`);
      return asContent(result);
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "list_sections",
  {
    title: "List sections",
    description:
      "List sections for a project. Default: only sections of the given venueSlug (or canonical if omitted). Set includeAllVenues=true to return every section across all venues.",
    inputSchema: {
      researchSlug: z.string(),
      venueSlug: z.string().optional(),
      includeAllVenues: z.boolean().optional(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("researchSections:list", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "fork_section",
  {
    title: "Fork section across venues",
    description:
      "Copy a section from one venue (or standalone) into another venue. Source must exist; destination is upserted. Use to adapt a canonical section for a specific venue.",
    inputSchema: {
      researchSlug: z.string(),
      sectionSlug: z.string(),
      fromVenueSlug: z.string().optional().describe("omit to fork from canonical"),
      toVenueSlug: z.string().optional().describe("omit to fork to canonical"),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("researchSections:fork", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "delete_section",
  {
    title: "Delete section",
    description: "Remove a section. Omit venueSlug to remove the canonical/standalone version.",
    inputSchema: {
      researchSlug: z.string(),
      sectionSlug: z.string(),
      venueSlug: z.string().optional(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("researchSections:remove", args));
    } catch (e) {
      return asError(e);
    }
  },
);

// ── Tex files (venue-scoped) ─────────────────────────────────────────────

server.registerTool(
  "save_tex",
  {
    title: "Save tex file",
    description:
      "Create or update a LaTeX source file (upsert by researchSlug+venueSlug+texPath). Omit venueSlug for canonical/standalone. Path is relative, e.g. 'main.tex' or 'sections/intro.tex'.",
    inputSchema: {
      researchSlug: z.string(),
      texPath: z.string().describe("e.g. 'main.tex' or 'sections/intro.tex'"),
      venueSlug: z.string().optional(),
      content: z.string().optional(),
      notes: z.string().optional(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("researchTex:save", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "get_tex",
  {
    title: "Get tex file",
    description: "Fetch a single tex file. Omit venueSlug for canonical/standalone.",
    inputSchema: {
      researchSlug: z.string(),
      texPath: z.string(),
      venueSlug: z.string().optional(),
    },
  },
  async (args) => {
    try {
      const result = await convex("researchTex:get", args);
      if (!result) return asError(`tex not found: ${args.texPath}`);
      return asContent(result);
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "list_tex",
  {
    title: "List tex files",
    description:
      "List tex files for a project. Default: only files of the given venueSlug (or canonical if omitted). Set includeAllVenues=true to span all venues.",
    inputSchema: {
      researchSlug: z.string(),
      venueSlug: z.string().optional(),
      includeAllVenues: z.boolean().optional(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("researchTex:list", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "fork_tex",
  {
    title: "Fork tex across venues",
    description:
      "Copy a tex file from one venue (or standalone) into another. Source must exist; destination is upserted.",
    inputSchema: {
      researchSlug: z.string(),
      texPath: z.string(),
      fromVenueSlug: z.string().optional(),
      toVenueSlug: z.string().optional(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("researchTex:fork", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "delete_tex",
  {
    title: "Delete tex file",
    description: "Remove a tex file. Omit venueSlug for canonical/standalone.",
    inputSchema: {
      researchSlug: z.string(),
      texPath: z.string(),
      venueSlug: z.string().optional(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("researchTex:remove", args));
    } catch (e) {
      return asError(e);
    }
  },
);

const ENTITY_TYPES = z.enum(["research", "memo", "experiment", "table", "figure", "venue", "section", "tex"]);

// ── Daily reports ────────────────────────────────────────────────────────

// The day in the caller's own timezone. The server's UTC day is still
// yesterday through the first nine hours of a KST day, so a report filed in
// the morning would otherwise land on the previous date.
const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

server.registerTool(
  "save_report",
  {
    title: "Save daily report",
    description:
      "File today's work report for a project (upsert by researchSlug+day+author, so calling twice in a day corrects it rather than filing twice). Write what you actually did, what you found, and what is blocked, in a few sentences. Use this every day you touch a project, including days where the phase did not advance: advance() notes only cover transitions, and this is the record of everything else. These are collected into the user's weekly mail.",
    inputSchema: {
      researchSlug: z.string(),
      body: z.string().describe("markdown; what was done, what was found, what is blocked"),
      author: z.string().describe("your CLI name, e.g. 'codex' / 'gemini' / 'claude'"),
      day: z.string().optional().describe("YYYY-MM-DD, defaults to today in the caller's timezone"),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("researchReports:save", { ...args, day: args.day ?? localDay() }));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "list_reports",
  {
    title: "List daily reports",
    description:
      "Recent daily reports for a project, newest first. Read this before writing today's report so you continue from where the last one left off instead of repeating it.",
    inputSchema: { researchSlug: z.string(), limit: z.number().optional() },
  },
  async (args) => {
    try {
      return asContent(await convex("researchReports:listByResearch", args));
    } catch (e) {
      return asError(e);
    }
  },
);

// ── Memos ────────────────────────────────────────────────────────────────

server.registerTool(
  "save_memo",
  {
    title: "Save memo",
    description:
      "Create or update a free-form markdown memo (upsert by researchSlug+memoSlug). Use for ideas, design notes, journal entries, decision logs. Reference other entities with add_reference.",
    inputSchema: {
      researchSlug: z.string(),
      memoSlug: z.string().describe("unique within project, e.g. 'mar-15-design'"),
      title: z.string().optional(),
      content: z.string().optional().describe("markdown body"),
      tags: z.array(z.string()).optional(),
      notes: z.string().optional(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("researchMemos:save", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "get_memo",
  {
    title: "Get memo",
    description: "Fetch a single memo by researchSlug+memoSlug.",
    inputSchema: { researchSlug: z.string(), memoSlug: z.string() },
  },
  async (args) => {
    try {
      const result = await convex("researchMemos:get", args);
      if (!result) return asError(`memo not found: ${args.memoSlug}`);
      return asContent(result);
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "list_memos",
  {
    title: "List memos",
    description: "List all memos for a project, optionally filtered by tag.",
    inputSchema: { researchSlug: z.string(), tag: z.string().optional() },
  },
  async (args) => {
    try {
      return asContent(await convex("researchMemos:list", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "delete_memo",
  {
    title: "Delete memo",
    description: "Remove a memo by researchSlug+memoSlug. References pointing to/from it are NOT auto-deleted.",
    inputSchema: { researchSlug: z.string(), memoSlug: z.string() },
  },
  async (args) => {
    try {
      return asContent(await convex("researchMemos:remove", args));
    } catch (e) {
      return asError(e);
    }
  },
);

// ── References (cross-entity links) ──────────────────────────────────────

server.registerTool(
  "add_reference",
  {
    title: "Add reference",
    description:
      "Create or update a directed reference between two entities in the same project. " +
      "Entity types: research/memo/experiment/table/figure/venue/section/tex. " +
      "Use fromVenueSlug/toVenueSlug only when the corresponding type is section or tex (omit for canonical). " +
      "Examples: memo → experiment ('see ablation results'), section → table ('Table 2 derived from'), memo → memo ('follow-up').",
    inputSchema: {
      researchSlug: z.string(),
      fromType: ENTITY_TYPES,
      fromKey: z.string().describe("primary slug of the source entity"),
      fromVenueSlug: z.string().optional(),
      toType: ENTITY_TYPES,
      toKey: z.string().describe("primary slug of the target entity"),
      toVenueSlug: z.string().optional(),
      context: z.string().optional().describe("short note on why these are linked"),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("researchRefs:add", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "list_references",
  {
    title: "List outgoing references",
    description: "List references originating from a given entity.",
    inputSchema: {
      researchSlug: z.string(),
      fromType: ENTITY_TYPES,
      fromKey: z.string(),
      fromVenueSlug: z.string().optional(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("researchRefs:listOutgoing", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "list_backlinks",
  {
    title: "List incoming references (backlinks)",
    description:
      "List references pointing to a given entity. Useful to find what cites this memo / table / experiment.",
    inputSchema: {
      researchSlug: z.string(),
      toType: ENTITY_TYPES,
      toKey: z.string(),
      toVenueSlug: z.string().optional(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("researchRefs:listIncoming", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "delete_reference",
  {
    title: "Delete reference",
    description: "Remove a directed reference identified by its full from/to tuple.",
    inputSchema: {
      researchSlug: z.string(),
      fromType: ENTITY_TYPES,
      fromKey: z.string(),
      fromVenueSlug: z.string().optional(),
      toType: ENTITY_TYPES,
      toKey: z.string(),
      toVenueSlug: z.string().optional(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("researchRefs:remove", args));
    } catch (e) {
      return asError(e);
    }
  },
);

// ── Comments (threaded, polymorphic, supports human + agent authors) ─────

server.registerTool(
  "post_comment",
  {
    title: "Post comment",
    description:
      "Post a comment on any research entity (research/memo/experiment/table/figure/venue/section/tex). " +
      "Set authorType='agent' and authorId to your CLI/agent identifier when commenting as an AI. " +
      "For section/tex targets, pass targetVenueSlug to disambiguate between canonical and per-venue copies. " +
      "Threading: pass parentId to reply to an existing comment.",
    inputSchema: {
      researchSlug: z.string(),
      targetType: ENTITY_TYPES,
      targetKey: z.string(),
      targetVenueSlug: z.string().optional(),
      parentId: z.string().optional().describe("comment _id to reply to"),
      authorType: z.enum(["user", "agent"]),
      authorId: z
        .string()
        .describe("Clerk userId for humans, agent name for AI (e.g. 'codex', 'gemini-method-checker')"),
      authorName: z.string().optional().describe("display name cache (avoids extra lookup in UI)"),
      body: z.string().describe("markdown body"),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("comments:post", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "edit_comment",
  {
    title: "Edit comment",
    description: "Edit a comment's body. Only the original author can edit.",
    inputSchema: {
      commentId: z.string(),
      body: z.string(),
      authorType: z.enum(["user", "agent"]),
      authorId: z.string(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("comments:edit", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "delete_comment",
  {
    title: "Delete comment",
    description: "Soft-delete a comment (preserves thread shape). Only the original author can delete.",
    inputSchema: {
      commentId: z.string(),
      authorType: z.enum(["user", "agent"]),
      authorId: z.string(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("comments:remove", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "list_comments",
  {
    title: "List comments on target",
    description:
      "List all comments on a single entity (full flat list ordered by createdAt; build thread tree client-side using parentId).",
    inputSchema: {
      researchSlug: z.string(),
      targetType: ENTITY_TYPES,
      targetKey: z.string(),
      targetVenueSlug: z.string().optional(),
      includeDeleted: z.boolean().optional(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("comments:listForTarget", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "list_my_comments",
  {
    title: "List comments by author",
    description: "List comments authored by a given user/agent across all targets.",
    inputSchema: {
      authorType: z.enum(["user", "agent"]),
      authorId: z.string(),
      limit: z.number().int().positive().optional(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("comments:listByAuthor", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "count_comments",
  {
    title: "Count comments on target",
    description: "Return per-target count split by authorType (user vs agent). Useful for UI badges.",
    inputSchema: {
      researchSlug: z.string(),
      targetType: ENTITY_TYPES,
      targetKey: z.string(),
      targetVenueSlug: z.string().optional(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("comments:countForTarget", args));
    } catch (e) {
      return asError(e);
    }
  },
);

// ── Agent subscriptions / runs (auto-react to entity events) ────────────

server.registerTool(
  "subscribe_agent",
  {
    title: "Subscribe agent to events",
    description:
      "Register an agent to react automatically when a matching entity event happens. " +
      "scope='global' subscribes everywhere; scope='project' requires scopeId=researchSlug. " +
      "targetType limits which entity type triggers (omit for any). config is a free-form JSON string the worker can read for prompt templates etc.",
    inputSchema: {
      agentId: z.string().describe("e.g. 'gemini-method-checker', 'codex-baseline-auditor'"),
      eventType: z.enum(["entity.created", "entity.updated", "state.transitioned", "comment.posted"]),
      targetType: ENTITY_TYPES.optional(),
      scope: z.enum(["global", "project", "workspace"]),
      scopeId: z.string().optional(),
      config: z.string().optional(),
      enabled: z.boolean().optional(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("agentSubscriptions:subscribe", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "set_subscription_enabled",
  {
    title: "Enable / disable subscription",
    description: "Toggle a subscription without deleting it.",
    inputSchema: { id: z.string(), enabled: z.boolean() },
  },
  async (args) => {
    try {
      return asContent(await convex("agentSubscriptions:setEnabled", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "unsubscribe_agent",
  {
    title: "Delete subscription",
    description: "Remove an agent subscription permanently.",
    inputSchema: { id: z.string() },
  },
  async (args) => {
    try {
      return asContent(await convex("agentSubscriptions:unsubscribe", args));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "list_subscriptions",
  {
    title: "List subscriptions",
    description:
      "List subscriptions, optionally filtered by agentId or by scope (global/project/workspace + optional scopeId).",
    inputSchema: {
      agentId: z.string().optional(),
      scope: z.enum(["global", "project", "workspace"]).optional(),
      scopeId: z.string().optional(),
    },
  },
  async (args) => {
    try {
      if (args.agentId) return asContent(await convex("agentSubscriptions:listByAgent", { agentId: args.agentId }));
      if (args.scope)
        return asContent(await convex("agentSubscriptions:listByScope", { scope: args.scope, scopeId: args.scopeId }));
      return asContent(await convex("agentSubscriptions:listAll", {}));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "list_agent_runs",
  {
    title: "List agent runs",
    description:
      "List the queue of triggered agent runs, optionally filtered by status / researchSlug / agentId. Use to see what fired and what is pending.",
    inputSchema: {
      status: z.enum(["pending", "running", "done", "error"]).optional(),
      researchSlug: z.string().optional(),
      agentId: z.string().optional(),
      limit: z.number().int().positive().optional(),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("agentSubscriptions:listRuns", args));
    } catch (e) {
      return asError(e);
    }
  },
);

// --- similarity / related-reading tools ---

server.registerTool(
  "similar_articles",
  {
    title: "Find similar articles",
    description:
      "Find summarized newsletter / paper articles similar to a topic or to an existing article. Pass `query` (free text: a topic, keywords, a claim, or a question) and/or `jobId` (find articles like that one). Ranks by full-text relevance of the Korean summary plus keyword overlap, deduped to one entry per source job. Use this to surface related reading and connect insights across the archive when answering questions.",
    inputSchema: {
      query: z.string().optional().describe("topic / keywords / claim / question to match against"),
      jobId: z.string().optional().describe("find articles similar to this job's article"),
      limit: z.number().int().positive().max(25).optional().describe("max results (default 8)"),
    },
  },
  async (args) => {
    try {
      return asContent(await convex("summaries:findSimilar", args));
    } catch (e) {
      return asError(e);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
