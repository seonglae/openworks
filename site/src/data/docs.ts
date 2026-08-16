export type DocPage = { slug: string; title: string; blurb: string };
export type DocGroup = { label: string; items: DocPage[] };

// The sidebar is also the allow-list: `docs/` holds design notes and runbooks
// that are notes to ourselves, and a page nobody can navigate to is worse on
// the site than absent from it. Adding a doc means adding it here.
export const DOC_GROUPS: DocGroup[] = [
  {
    label: "Start",
    items: [
      {
        slug: "getting-started",
        title: "Getting started",
        blurb: "Clone, provision a Convex deployment, close the backend, and get the UI and the two workers up.",
      },
      {
        slug: "concepts",
        title: "Concepts",
        blurb: "Projects, entities, references and comments: the substrate every feature is built on.",
      },
    ],
  },
  {
    label: "Working",
    items: [
      {
        slug: "intake",
        title: "Intake",
        blurb: "Newsletters, papers, articles and feeds arrive as jobs, get distilled and scored, and leave as a line.",
      },
      {
        slug: "research",
        title: "Research",
        blurb:
          "Projects on a state machine, with memos, experiments, tables, figures, sections and venues hanging off them.",
      },
      {
        slug: "agents",
        title: "Agents",
        blurb: "Subscriptions that fan out on entity events, queue autonomous runs, and post results back as comments.",
      },
      {
        slug: "pull-requests",
        title: "Pull requests",
        blurb: "Open PRs across your accounts and orgs in one queue, with a fix dispatched to a CLI.",
      },
      {
        slug: "digest",
        title: "Digest",
        blurb: "A daily and a weekly mail of what moved, what was cleared, and what is due.",
      },
    ],
  },
  {
    label: "Running it",
    items: [
      {
        slug: "agent-clis",
        title: "Agent CLIs",
        blurb: "How a model call is dispatched, the per-task fallback order, and why there is no provider key.",
      },
      {
        slug: "mcp",
        title: "MCP server",
        blurb: "~50 tools so codex, antigravity and claude can read and write the graph directly.",
      },
      {
        slug: "workers",
        title: "Workers",
        blurb: "The two long-running processes, what each one polls, and how to keep them alive.",
      },
      {
        slug: "auth",
        title: "Auth and sharing",
        blurb: "The owner gate, the service key, and what changes when a project is made public.",
      },
      {
        slug: "configuration",
        title: "Configuration",
        blurb: "Every environment variable, where it is read, and what happens when it is unset.",
      },
    ],
  },
];

export const DOC_SLUGS = DOC_GROUPS.flatMap((g) => g.items.map((i) => i.slug));
export const DOC_PAGES = DOC_GROUPS.flatMap((g) => g.items);
