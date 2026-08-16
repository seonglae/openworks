/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentSubscriptions from "../agentSubscriptions.js";
import type * as agentTriggers from "../agentTriggers.js";
import type * as auth from "../auth.js";
import type * as authors from "../authors.js";
import type * as calendar from "../calendar.js";
import type * as chats from "../chats.js";
import type * as cleanup from "../cleanup.js";
import type * as comments from "../comments.js";
import type * as crons from "../crons.js";
import type * as diet from "../diet.js";
import type * as digest from "../digest.js";
import type * as drawings from "../drawings.js";
import type * as emailDigests from "../emailDigests.js";
import type * as embeddings from "../embeddings.js";
import type * as expressions from "../expressions.js";
import type * as feeds from "../feeds.js";
import type * as github from "../github.js";
import type * as http from "../http.js";
import type * as insights from "../insights.js";
import type * as jobs from "../jobs.js";
import type * as machine from "../machine.js";
import type * as mailbox from "../mailbox.js";
import type * as notion from "../notion.js";
import type * as paperLinks from "../paperLinks.js";
import type * as plans from "../plans.js";
import type * as push from "../push.js";
import type * as pushNode from "../pushNode.js";
import type * as research from "../research.js";
import type * as researchChecklists from "../researchChecklists.js";
import type * as researchCitations from "../researchCitations.js";
import type * as researchExperiments from "../researchExperiments.js";
import type * as researchFigures from "../researchFigures.js";
import type * as researchFiles from "../researchFiles.js";
import type * as researchHosts from "../researchHosts.js";
import type * as researchMemos from "../researchMemos.js";
import type * as researchPapers from "../researchPapers.js";
import type * as researchPhaseInfer from "../researchPhaseInfer.js";
import type * as researchRefs from "../researchRefs.js";
import type * as researchReports from "../researchReports.js";
import type * as researchSections from "../researchSections.js";
import type * as researchTables from "../researchTables.js";
import type * as researchTex from "../researchTex.js";
import type * as researchVenues from "../researchVenues.js";
import type * as settings from "../settings.js";
import type * as setup from "../setup.js";
import type * as suggestions from "../suggestions.js";
import type * as summaries from "../summaries.js";
import type * as summaryAggregates from "../summaryAggregates.js";
import type * as usage from "../usage.js";
import type * as validators from "../validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentSubscriptions: typeof agentSubscriptions;
  agentTriggers: typeof agentTriggers;
  auth: typeof auth;
  authors: typeof authors;
  calendar: typeof calendar;
  chats: typeof chats;
  cleanup: typeof cleanup;
  comments: typeof comments;
  crons: typeof crons;
  diet: typeof diet;
  digest: typeof digest;
  drawings: typeof drawings;
  emailDigests: typeof emailDigests;
  embeddings: typeof embeddings;
  expressions: typeof expressions;
  feeds: typeof feeds;
  github: typeof github;
  http: typeof http;
  insights: typeof insights;
  jobs: typeof jobs;
  machine: typeof machine;
  mailbox: typeof mailbox;
  notion: typeof notion;
  paperLinks: typeof paperLinks;
  plans: typeof plans;
  push: typeof push;
  pushNode: typeof pushNode;
  research: typeof research;
  researchChecklists: typeof researchChecklists;
  researchCitations: typeof researchCitations;
  researchExperiments: typeof researchExperiments;
  researchFigures: typeof researchFigures;
  researchFiles: typeof researchFiles;
  researchHosts: typeof researchHosts;
  researchMemos: typeof researchMemos;
  researchPapers: typeof researchPapers;
  researchPhaseInfer: typeof researchPhaseInfer;
  researchRefs: typeof researchRefs;
  researchReports: typeof researchReports;
  researchSections: typeof researchSections;
  researchTables: typeof researchTables;
  researchTex: typeof researchTex;
  researchVenues: typeof researchVenues;
  settings: typeof settings;
  setup: typeof setup;
  suggestions: typeof suggestions;
  summaries: typeof summaries;
  summaryAggregates: typeof summaryAggregates;
  usage: typeof usage;
  validators: typeof validators;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
