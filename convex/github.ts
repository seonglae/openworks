import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { requireOwner } from "./auth";

// Deliberately empty. A fresh install has no idea whose pull requests to show,
// and guessing means shipping one person's queue into everyone else's
// deployment. The PR tab stays empty until Settings names a user or an org.
// The field takes a comma-separated list so one queue can span both.
const DEFAULT_ORGS: string[] = [];

async function resolveOrgs(ctx: { runQuery: any }): Promise<string[]> {
  try {
    // Owner identity propagates on a browser call; the service key covers the
    // worker / no-identity path once the lockdown is on.
    const settings = await ctx.runQuery(api.settings.get, { serviceKey: process.env.OPENWORKS_SERVICE_KEY });
    // Dedicated orgs field wins. `username` is only honored when it's an
    // explicit comma-separated list. The gh-verify setup flow stamps the gh
    // CLI's logged-in account into `username`, which is a login identity, not
    // a search scope; treating it as the org list silently emptied the whole
    // PR tab.
    const orgsField = settings?.github?.orgs;
    const candidate = typeof orgsField === "string" && orgsField.trim().length > 0 ? orgsField : null;
    const username = settings?.github?.username;
    const legacyList = !candidate && typeof username === "string" && username.includes(",") ? username : null;
    const source = candidate ?? legacyList;
    if (source) {
      const parts = source
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length > 0) return parts;
    }
  } catch {}
  return DEFAULT_ORGS;
}

function ghFetch(token: string, path: string) {
  return fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  }).then((r) => r.json());
}

export const listOpenPRs = action({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN not set");

    // One search across every org rather than one per org. Repeated `org:`
    // qualifiers are OR'd, so the result set is identical, but GitHub throttles
    // concurrent search requests — issuing them in parallel bought nothing and
    // three orgs cost ~2.7s against ~1.0s for the single combined query.
    async function fetchAllPages(orgs: string[]) {
      const scope = orgs.map((o) => `+org:${o}`).join("");
      const items: Record<string, unknown>[] = [];
      let page = 1;
      while (true) {
        const data = (await ghFetch(
          token!,
          `/search/issues?q=is:pr+is:open${scope}&per_page=100&sort=updated&order=desc&page=${page}`,
        )) as { items?: Record<string, unknown>[]; total_count?: number };
        items.push(...(data.items ?? []));
        if (!data.items || data.items.length < 100) break;
        page++;
        if (page > 10) break; // safety cap
      }
      return items;
    }
    const orgs = await resolveOrgs(ctx);
    // An empty scope is not "no filter" to GitHub's search API, it is every
    // open pull request on the site. Unscoped, this returned 1000 results from
    // 346 unrelated repositories and took 41s, which overran the worker's
    // 30s call timeout, so the daily digest shipped without its PR section and
    // said nothing about why. DEFAULT_ORGS always claimed the tab stays empty
    // until Settings names someone; this is the code finally agreeing.
    if (orgs.length === 0) return {};
    const results = [await fetchAllPages(orgs)];

    const allPRs: {
      id: number;
      repo: string;
      repoUrl: string;
      number: number;
      title: string;
      url: string;
      author: string;
      authorAvatar: string;
      labels: string[];
      draft: boolean;
      createdAt: string;
      updatedAt: string;
      comments: number;
      checksPass: number;
      checksTotal: number;
      checksState: string;
      mergeable: boolean | null;
      behindBy: number;
      changedFiles: number;
      commits: number;
      additions: number;
      deletions: number;
      branch: string;
    }[] = [];

    // Collect basic info from search
    const searchItems: { repo: string; number: number; item: Record<string, unknown> }[] = [];
    for (const items of results) {
      for (const item of items) {
        const repoUrl = item.repository_url as string;
        const repo = repoUrl?.split("/repos/")[1] ?? "";
        searchItems.push({ repo, number: item.number as number, item });
      }
    }

    // Everything below comes straight from the search payload — no per-PR
    // request. The fields that need one (mergeable, diffstat, branch) start at
    // their neutral values and are filled in by listPRDetails, which the client
    // fires right after this resolves. Waiting for them here doubled the time
    // to first paint on a tab whose list is readable without them.
    for (const { repo, number, item } of searchItems) {
      allPRs.push({
        id: item.id as number,
        repo,
        repoUrl: `https://github.com/${repo}`,
        number,
        title: item.title as string,
        url: item.html_url as string,
        author: (item.user as { login: string })?.login ?? "",
        authorAvatar: (item.user as { avatar_url: string })?.avatar_url ?? "",
        labels: ((item.labels ?? []) as { name: string }[]).map((l) => l.name),
        draft: (item.draft as boolean) ?? false,
        createdAt: item.created_at as string,
        updatedAt: item.updated_at as string,
        comments: (item.comments as number) ?? 0,
        checksPass: 0,
        checksTotal: 0,
        checksState: "loading",
        mergeable: null,
        behindBy: 0,
        changedFiles: 0,
        commits: 0,
        additions: 0,
        deletions: 0,
        branch: "",
      });
    }

    const grouped: Record<string, typeof allPRs> = {};
    for (const pr of allPRs) {
      (grouped[pr.repo] ??= []).push(pr);
    }
    return grouped;
  },
});

// Second pass over the list listOpenPRs just returned: the per-PR fields the
// search endpoint does not carry. Runs as its own action so the tab paints the
// PR list first and fills these in when they land, the same way check runs
// already arrive separately. One wave of concurrent requests — GitHub serves 25
// of these in about the time it serves one, and asks only that callers stay
// under 100 in flight.
export const listPRDetails = action({
  args: {
    prs: v.array(v.object({ repo: v.string(), number: v.number() })),
    serviceKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN not set");
    const batchSize = 50;
    const out: {
      repo: string;
      number: number;
      mergeable: boolean | null;
      behindBy: number;
      changedFiles: number;
      commits: number;
      additions: number;
      deletions: number;
      branch: string;
    }[] = [];
    for (let i = 0; i < args.prs.length; i += batchSize) {
      const batch = args.prs.slice(i, i + batchSize);
      const details = await Promise.all(
        batch.map(async ({ repo, number }) => {
          try {
            const pr = (await ghFetch(token, `/repos/${repo}/pulls/${number}`)) as {
              mergeable?: boolean | null;
              mergeable_state?: string;
              changed_files?: number;
              commits?: number;
              additions?: number;
              deletions?: number;
              head?: { ref?: string };
            };
            return {
              repo,
              number,
              mergeable: pr.mergeable ?? null,
              behindBy: pr.mergeable_state === "behind" || pr.mergeable_state === "dirty" ? 1 : 0,
              changedFiles: pr.changed_files ?? 0,
              commits: pr.commits ?? 0,
              additions: pr.additions ?? 0,
              deletions: pr.deletions ?? 0,
              branch: pr.head?.ref ?? "",
            };
          } catch {}
          return {
            repo,
            number,
            mergeable: null,
            behindBy: 0,
            changedFiles: 0,
            commits: 0,
            additions: 0,
            deletions: 0,
            branch: "",
          };
        }),
      );
      out.push(...details);
    }
    return out;
  },
});

export const getChecks = action({
  args: { repo: v.string(), number: v.number(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN not set");

    const pr = (await ghFetch(token, `/repos/${args.repo}/pulls/${args.number}`)) as {
      head?: { sha?: string };
      mergeable?: boolean;
      mergeable_state?: string;
    };
    const sha = pr.head?.sha;
    const mergeable = pr.mergeable ?? true;
    const mergeableState = pr.mergeable_state ?? "unknown";
    if (!sha) return { checksPass: 0, checksTotal: 0, checksState: "none", mergeable, mergeableState };

    const status = await ghFetch(token, `/repos/${args.repo}/commits/${sha}/check-runs?per_page=100`);
    const runs = (status as { check_runs?: { conclusion: string; status: string }[] }).check_runs ?? [];
    const checksTotal = runs.length;
    const checksPass = runs.filter((r) => r.conclusion === "success").length;
    const failed = runs.some((r) => r.conclusion === "failure");
    const pending = runs.some((r) => r.status !== "completed");
    const checksState = failed ? "failure" : pending ? "pending" : checksTotal > 0 ? "success" : "none";

    return { checksPass, checksTotal, checksState, mergeable, mergeableState };
  },
});

export const mergePR = action({
  args: { repo: v.string(), number: v.number(), method: v.string(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN not set");
    // Get PR title for commit message
    const pr = (await ghFetch(token, `/repos/${args.repo}/pulls/${args.number}`)) as { title?: string };
    const title = pr.title ?? `PR #${args.number}`;
    const commitTitle = `merge: ${title} (#${args.number})`;
    const res = await fetch(`https://api.github.com/repos/${args.repo}/pulls/${args.number}/merge`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      body: JSON.stringify({ merge_method: args.method, commit_title: commitTitle }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data as { message?: string }).message ?? "Merge failed");
    return data;
  },
});

export const updatePRBranch = action({
  args: { repo: v.string(), number: v.number(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN not set");
    const res = await fetch(`https://api.github.com/repos/${args.repo}/pulls/${args.number}/update-branch`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data as { message?: string }).message ?? "Rebase failed");
    return data;
  },
});

export const closePR = action({
  args: { repo: v.string(), number: v.number(), serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.serviceKey);
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN not set");
    const res = await fetch(`https://api.github.com/repos/${args.repo}/pulls/${args.number}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      body: JSON.stringify({ state: "closed" }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data as { message?: string }).message ?? "Close failed");
    return data;
  },
});
