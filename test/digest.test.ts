import { describe, expect, it } from "vitest";
import {
  buildMime,
  deltaLabel,
  digestsDue,
  esc,
  gwsSendArgs,
  hoistStyles,
  isBotPR,
  isoWeekKey,
  MAX_BODY_BYTES,
  plainText,
  renderDigest,
  scoreColor,
  type DigestPR,
  type DigestSnapshot,
} from "../scripts/digest.mts";

// A window with something in every section, so a test can empty exactly one
// and assert on the difference.
function snap(over: Partial<DigestSnapshot> = {}): DigestSnapshot {
  return {
    window: { since: 1_700_000_000_000, until: 1_700_604_800_000, hasPrev: true },
    truncated: false,
    archived: { total: 4, prevTotal: 11, byType: { newsletter: 4 } },
    suggestions: { approved: 2, rejected: 0, pending: 5 },
    jobs: { total: 13, prevTotal: 29, byType: { paper: 9, newsletter: 3, article: 1 }, errored: 0 },
    papers: {
      count: 9,
      scored: 9,
      mean: 6.23,
      items: [
        {
          title: "SOAP, Muon, and Beyond",
          url: "https://arxiv.org/abs/1",
          summary: "AdamW breaks down at very large global batch sizes.",
          overall: 7.2,
          category: "Paper",
          jobId: "j1",
          type: "paper",
        },
      ],
    },
    articles: {
      count: 4,
      items: [
        {
          title: "WebRTC WARP",
          url: "https://datatracker.ietf.org/doc/draft-uberti-tsvwg-warp-00",
          summary: "Cuts the handshake to a single round trip.",
          category: "Article",
          jobId: "j2",
          type: "article",
        },
      ],
    },
    newsletters: {
      count: 2,
      items: [
        {
          title: "TLDR 2026-08-03",
          url: "https://tldr.tech/tech/2026-08-03",
          summary: "Six links, two of them worth opening.",
          category: "Newsletter",
          jobId: "j3",
          type: "newsletter",
        },
      ],
    },
    // What the mail leads with: the unarchived backlog, not the window.
    recommend: {
      papers: [
        {
          title: "Attention Is All You Need",
          url: "https://arxiv.org/abs/1706.03762",
          summary: "Sequence transduction without recurrence.",
          overall: 9.5,
          category: "Paper",
          keywords: ["Transformer", "Self-Attention"],
          jobId: "r1",
          type: "paper",
        },
      ],
      articles: [
        {
          title: "Recent LLM architectures",
          url: "https://example.com/arch",
          summary: "KV sharing and compressed attention.",
          category: "Article",
          keywords: ["Transformer", "KV Cache"],
          jobId: "r2",
          type: "article",
        },
      ],
      newsletters: [
        {
          title: "TLDR 2026-08-08",
          url: "https://tldr.tech/tech/2026-08-08",
          summary: "Five links.",
          category: "Newsletter",
          keywords: [],
          jobId: "r3",
          type: "newsletter",
        },
      ],
    },
    insights: [],
    research: {
      projects: [{ slug: "routerrl", title: "RouterRL", kind: "own", phase: "slide" }],
      moves: [{ researchSlug: "routerrl", state: "slide", at: 1_700_100_000_000 }],
      reports: [],
    },
    planItems: [],
    vocab: {
      added: [],
      due: 172,
      moreDue: 160,
      study: [
        {
          en: "piggyback",
          jp: "便乗する",
          reading: "びんじょうする",
          meaning: "to ride along with someone else's effort",
          ipa: "/ˈpɪɡibæk/",
          ko: "\uD53C\uAE30\uBC31",
          due: "2026-07-11",
          reps: 0,
          id: "x1",
        },
      ],
    },
    diet: { entries: 0, days: 0, kcal: 0, protein: 0, carbs: 0, fat: 0 },
    ...over,
  };
}

const pr = (over: Partial<DigestPR> = {}): DigestPR => ({
  repo: "acme/widgets",
  number: 609,
  title: "feat(knowledge): Convex knowledge store",
  url: "https://github.com/acme/widgets/pull/609",
  author: "octocat",
  draft: false,
  ...over,
});

describe("escaping", () => {
  // Paper titles come from an agent and land in the mail unescaped otherwise.
  it("escapes markup so a title cannot inject into the mail", () => {
    expect(esc(`<script>alert("x")</script>`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(esc("a & b")).toBe("a &amp; b");
  });

  it("renders a hostile title as text, not markup", () => {
    const html = renderDigest({
      kind: "weekly",
      snapshot: snap({
        papers: {
          count: 1,
          scored: 1,
          mean: 7,
          items: [
            {
              title: "<img src=x onerror=1>",
              url: "https://a.example",
              summary: "x",
              overall: 7,
              category: "Paper",
              jobId: "j1",
              type: "paper",
            },
          ],
        },
      }),
    }).html;
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("survives missing optional fields", () => {
    expect(esc(undefined)).toBe("");
    expect(esc(null)).toBe("");
  });
});

describe("score colour", () => {
  // The Papers tab treats 7+ as worth keeping and 5 and under as noise; the
  // digest must not flatten that into one grey.
  it("separates keep / good / marginal / noise", () => {
    expect(scoreColor(7.2)).not.toBe(scoreColor(6.5));
    expect(scoreColor(6.5)).not.toBe(scoreColor(5.2));
    expect(scoreColor(5.2)).not.toBe(scoreColor(4.1));
  });

  it("puts the boundaries at 7, 6 and 5", () => {
    expect(scoreColor(7)).toBe(scoreColor(9));
    expect(scoreColor(6.99)).toBe(scoreColor(6));
    expect(scoreColor(5.99)).toBe(scoreColor(5));
    expect(scoreColor(4.99)).toBe(scoreColor(0));
  });
});

describe("period delta", () => {
  it("signs the change and says nothing without a previous window", () => {
    expect(deltaLabel(13, 29)).toBe("-16 vs last period");
    expect(deltaLabel(30, 29)).toBe("+1 vs last period");
    expect(deltaLabel(29, 29)).toBe("same as last period");
    expect(deltaLabel(13, null)).toBe("");
  });
});

describe("bot pull requests", () => {
  // 31 of 34 open PRs were dependabot. Listing them by title buried the three
  // the reader actually opened.
  it("recognises the bots that open most of the PRs", () => {
    expect(isBotPR(pr({ author: "dependabot[bot]" }))).toBe(true);
    expect(isBotPR(pr({ author: "renovate[bot]" }))).toBe(true);
    expect(isBotPR(pr({ author: "octocat" }))).toBe(false);
  });

  // Every PR is listed now, so the bot check only decides ordering and weight.
  it("lists bot PRs too, rather than collapsing them to a count", () => {
    const prs = [
      pr(),
      ...Array.from({ length: 31 }, (_, i) => pr({ author: "dependabot[bot]", number: i, title: `bump ${i}` })),
    ];
    const html = renderDigest({ kind: "weekly", snapshot: snap(), prs }).html;
    expect(html).toContain("feat(knowledge)");
    expect(html).toContain("bump 7");
    expect(html).not.toContain("dependency updates across");
  });

  it("sorts human PRs above bots inside a repo", () => {
    const prs = [pr({ author: "dependabot[bot]", number: 1, title: "bump x" }), pr({ number: 2, title: "real work" })];
    const html = renderDigest({ kind: "weekly", snapshot: snap(), prs }).html;
    expect(html.indexOf("real work")).toBeLessThan(html.indexOf("bump x"));
  });

  it("says each repo once as a heading instead of on every row", () => {
    const prs = [pr({ number: 1 }), pr({ number: 2 }), pr({ number: 3 })];
    const html = renderDigest({ kind: "weekly", snapshot: snap(), prs }).html;
    // The name still appears inside each PR's own href; what must not repeat
    // is the heading that links to the repo's pull request list.
    const headings = html.split('href="https://github.com/acme/widgets/pulls"').length - 1;
    expect(headings).toBe(1);
  });

  it("puts repos with human work before repos that are only bots", () => {
    const prs = [
      pr({ repo: "a/bots", author: "dependabot[bot]", number: 1, title: "bump a" }),
      pr({ repo: "b/real", author: "octocat", number: 2, title: "real b" }),
    ];
    const html = renderDigest({ kind: "weekly", snapshot: snap(), prs }).html;
    expect(html.indexOf("b/real")).toBeLessThan(html.indexOf("a/bots"));
  });

  // A PR's title says nothing about whether it needs you. Its checks and its
  // diff do, and the browser has always shown both.
  it("carries checks, conflict state and the diffstat", () => {
    const prs = [
      pr({ checksPass: 3, checksTotal: 4, checksState: "failure", additions: 12, deletions: 40, changedFiles: 3 }),
    ];
    const { html, text } = renderDigest({ kind: "weekly", snapshot: snap(), prs });
    expect(html).toContain("3/4 checks");
    expect(html).toContain("+12");
    expect(html).toContain("3f");
    expect(text).toContain("3/4 checks");
    expect(text).toContain("+12/-40");
  });

  it("says conflict when the branch cannot merge", () => {
    const prs = [pr({ mergeable: false, checksPass: 4, checksTotal: 4, checksState: "success" })];
    expect(renderDigest({ kind: "weekly", snapshot: snap(), prs }).html).toContain("conflict");
  });

  // A deployment with no GitHub token has none of these fields, and should
  // still render the list rather than a row of zeros.
  it("renders a PR that has no status at all", () => {
    const html = renderDigest({ kind: "weekly", snapshot: snap(), prs: [pr()] }).html;
    expect(html).toContain("#609");
    expect(html).not.toContain("checks");
  });

  // The search payload behind listOpenPRs carries no diff and fills the counts
  // with zero, so an unfilled row was claiming a measured diffstat of nothing.
  it("prints no diffstat when the counts are the search payload's zeros", () => {
    const prs = [pr({ additions: 0, deletions: 0, changedFiles: 0, checksPass: 2, checksTotal: 2 })];
    const { html, text } = renderDigest({ kind: "weekly", snapshot: snap(), prs });
    expect(html).toContain("2/2 checks");
    expect(text).toContain("2/2 checks");
    expect(text).not.toContain("+0/-0");
    expect(html).not.toContain("+0");
  });
});

describe("rendering a digest", () => {
  it("omits a section that has nothing in it", () => {
    const html = renderDigest({ kind: "weekly", snapshot: snap() }).html;
    expect(html).toContain("Papers");
    expect(html).not.toContain("Insights");
    expect(html).not.toContain("Open PRs");
  });

  // The counters keep the subject line, where they are a preview, and are gone
  // from the body. A block of four numbers above the reading reported a row of
  // zeros on exactly the days there was least to read.
  it("keeps the counts in the subject and not in the body", () => {
    const r = renderDigest({ kind: "weekly", snapshot: snap() });
    expect(r.subject).toContain("4 archived");
    expect(r.html).not.toContain(">archived</div>");
    expect(r.html).not.toContain("mean score");
    expect(r.html).not.toContain("newsletters and articles are not scored");
    expect(r.text).not.toContain("archived 4");
  });

  // The reading is the mail. Research and the PR queue are the standing state
  // of the work, worth a glance after it, and the study list is the tail.
  it("puts the reading first and the operational sections last", () => {
    const { html } = renderDigest({ kind: "weekly", snapshot: snap(), prs: [pr()] });
    expect(html.indexOf("SOAP, Muon, and Beyond")).toBeLessThan(html.indexOf("Research"));
    expect(html.indexOf("TLDR 2026-08-03")).toBeLessThan(html.indexOf("Open PRs"));
    expect(html.indexOf("Research")).toBeLessThan(html.indexOf("Study today"));
  });

  // A day where nothing was processed still has a backlog worth triaging, and
  // used to produce a mail whose first section was the vocabulary.
  it("leads with what to read even when the window held nothing", () => {
    const s = snap();
    s.papers.items = [];
    s.articles.items = [];
    s.newsletters.items = [];
    const { html } = renderDigest({ kind: "daily", snapshot: s });
    expect(html).toContain("Attention Is All You Need");
    expect(html.indexOf("Attention Is All You Need")).toBeLessThan(html.indexOf("Study today"));
  });

  it("separates what to read from what was read", () => {
    const { html } = renderDigest({ kind: "weekly", snapshot: snap() });
    expect(html).toContain("Read · papers");
    expect(html.indexOf("Attention Is All You Need")).toBeLessThan(html.indexOf("SOAP, Muon, and Beyond"));
  });

  // The mail is a way into the app, not around it. A title opened arxiv, so
  // the row's score, comments and archive control were all a search away.
  it("sends the title into the app and leaves the source one line below", () => {
    const { html, text } = renderDigest({
      kind: "weekly",
      snapshot: snap(),
      appUrl: "https://openworks.example/",
    });
    expect(html).toContain("https://openworks.example/?tab=paper&amp;item=r1");
    expect(text).toContain("https://openworks.example/?tab=paper&item=r1");
    // The source is still reachable, just not from the headline.
    expect(html).toContain('href="https://arxiv.org/abs/1706.03762"');
    expect(html).toContain("&rarr; source");
  });

  // newsletter is the app's default tab and is stripped from its own URLs, so
  // writing it produces a link the app rewrites the moment it opens.
  it("omits the tab for the default one", () => {
    const { html } = renderDigest({ kind: "weekly", snapshot: snap(), appUrl: "https://openworks.example/" });
    expect(html).toContain("https://openworks.example/?item=r3");
    expect(html).not.toContain("tab=newsletter");
  });

  it("falls back to the source when no app URL is configured", () => {
    const { html } = renderDigest({ kind: "weekly", snapshot: snap() });
    expect(html).toContain('href="https://arxiv.org/abs/1706.03762"');
    expect(html).not.toContain("item=r1");
  });

  // Everything below the reading was a dead end: a project was plain text, a
  // word was plain text, and a PR bounced the reader out to github.com, which
  // is where the checks and the fix action are not.
  // A timeline note only exists where a phase moved, and most days nothing
  // moves. The reports are the record of those days, and the week is what the
  // reader cannot reconstruct from memory.
  const withReports = () => {
    const s = snap();
    s.research.reports = [
      { researchSlug: "routerrl", day: "2026-08-05", author: "codex", body: "swept the router temperature" },
      { researchSlug: "routerrl", day: "2026-08-07", author: "gemini", body: "rebuilt the eval harness" },
      { researchSlug: "ghost", day: "2026-08-06", author: "claude", body: "left over from a deleted project" },
    ];
    return s;
  };

  it("collects the week's agent reports under each project, newest day first", () => {
    const { html, text } = renderDigest({ kind: "weekly", snapshot: withReports() });
    expect(html).toContain("Agent reports");
    expect(html).toContain("rebuilt the eval harness");
    expect(html).toContain("swept the router temperature");
    expect(html.indexOf("rebuilt the eval harness")).toBeLessThan(html.indexOf("swept the router temperature"));
    expect(text).toContain("08-07 gemini");
  });

  // The daily mail covers the same day the agents ran, which the person who
  // ran them already knows.
  it("keeps the reports out of the daily mail", () => {
    expect(renderDigest({ kind: "daily", snapshot: withReports() }).html).not.toContain("Agent reports");
  });

  // A report outlives the project row it names, and an empty heading reads as
  // a rendering bug rather than as a deleted project.
  it("falls back to the slug when the project a report names is gone", () => {
    const { html } = renderDigest({ kind: "weekly", snapshot: withReports() });
    expect(html).toContain("ghost");
  });

  it("omits the section entirely when no agent reported", () => {
    expect(renderDigest({ kind: "weekly", snapshot: snap() }).html).not.toContain("Agent reports");
  });

  it("opens a research project in the app rather than printing its name", () => {
    const { html, text } = renderDigest({
      kind: "weekly",
      snapshot: snap(),
      appUrl: "https://openworks.example/",
    });
    expect(html).toContain("https://openworks.example/?research=routerrl");
    expect(text).toContain("https://openworks.example/?research=routerrl");
  });

  it("opens a study card on its own row", () => {
    const { html, text } = renderDigest({
      kind: "weekly",
      snapshot: snap(),
      appUrl: "https://openworks.example/",
    });
    expect(html).toContain("https://openworks.example/?tab=vocab&amp;expr=x1");
    expect(text).toContain("https://openworks.example/?tab=vocab&expr=x1");
  });

  it("sends a pull request to the app, which is where its checks and diff are", () => {
    const { html, text } = renderDigest({
      kind: "weekly",
      snapshot: snap(),
      prs: [pr()],
      appUrl: "https://openworks.example/",
    });
    expect(html).toContain("https://openworks.example/?tab=pr&amp;pr=acme%2Fwidgets%23609");
    expect(text).toContain("https://openworks.example/?tab=pr&pr=acme%2Fwidgets%23609");
    expect(html).not.toContain("https://github.com/acme/widgets/pull/609");
  });

  // With no app there is nowhere else for a PR to go, and a mail carrying a
  // dead link is worse than one that leaves the platform.
  it("keeps github as the pull request link when no app URL is configured", () => {
    const { html } = renderDigest({ kind: "weekly", snapshot: snap(), prs: [pr()] });
    expect(html).toContain('href="https://github.com/acme/widgets/pull/609"');
  });

  // A title-only list forced the reader into the app to find out whether an
  // item was worth opening.
  it("carries the summary, not only the title", () => {
    const html = renderDigest({ kind: "weekly", snapshot: snap() }).html;
    expect(html).toContain("AdamW breaks down");
    expect(html).toContain("Cuts the handshake");
  });

  it("prefers the tldr lines over the raw summary when a job has them", () => {
    const s = snap();
    s.papers.items[0].tldr = ["line one", "line two"];
    const html = renderDigest({ kind: "weekly", snapshot: s }).html;
    expect(html).toContain("line one");
    expect(html).not.toContain("AdamW breaks down");
  });

  it("links every paper, article and PR to its source", () => {
    const html = renderDigest({ kind: "weekly", snapshot: snap(), prs: [pr()] }).html;
    expect(html).toContain('href="https://arxiv.org/abs/1"');
    expect(html).toContain('href="https://datatracker.ietf.org/doc/draft-uberti-tsvwg-warp-00"');
    expect(html).toContain('href="https://github.com/acme/widgets/pull/609"');
  });

  it("shows today's cards rather than only a due count", () => {
    const html = renderDigest({ kind: "weekly", snapshot: snap() }).html;
    expect(html).toContain("piggyback");
    expect(html).toContain("160 more due");
  });

  // Both sides of a card are stored, so prompting with the English one every
  // time studies half the deck and never the Japanese half.
  it("alternates which side of the card is the prompt", () => {
    const s = snap();
    s.vocab.study = [
      { en: "piggyback", jp: "便乗する", due: "2026-07-11", reps: 0 },
      { en: "breakneck", jp: "猛烈な速さの", due: "2026-07-11", reps: 0 },
      { en: "cog", jp: "歯車", due: "2026-07-11", reps: 0 },
    ];
    const html = renderDigest({ kind: "weekly", snapshot: s }).html;
    expect(html).toContain("piggyback");
    expect(html).toContain("猛烈な速さの");
    expect(html).toContain("cog");
    // The Japanese-side card is prompted by the Japanese, so its English does
    // not also appear.
    expect(html).not.toContain("breakneck");
  });

  it("falls back to the English side when a card has no Japanese", () => {
    const s = snap();
    s.vocab.study = [
      { en: "piggyback", jp: "便乗する", due: "2026-07-11", reps: 0 },
      { en: "breakneck", due: "2026-07-11", reps: 0 },
    ];
    expect(renderDigest({ kind: "weekly", snapshot: s }).html).toContain("breakneck");
  });

  // Newsletters used to sit in the articles bucket, which put a link roundup
  // beside a piece that was actually read.
  it("separates newsletters from articles, and ranks the reading first", () => {
    const { html } = renderDigest({ kind: "weekly", snapshot: snap() });
    expect(html).toContain("Articles");
    expect(html).toContain("Newsletters");
    expect(html).toContain("WebRTC WARP");
    expect(html).toContain("TLDR 2026-08-03");
    expect(html.indexOf("WebRTC WARP")).toBeLessThan(html.indexOf("TLDR 2026-08-03"));
  });

  it("puts papers above both of them", () => {
    const { html } = renderDigest({ kind: "weekly", snapshot: snap() });
    expect(html.indexOf("SOAP, Muon, and Beyond")).toBeLessThan(html.indexOf("WebRTC WARP"));
  });

  // A flat list of a day's reading is a pile. The same rows under their own
  // topic say what the day was about before a title is read.
  // The topic is the keyword an item shares with the most of its neighbours.
  // Grouping on `category` produced a heading that read "Papers · Paper",
  // because that field is the kind of thing, not what it is about.
  it("gives a section the single topic it is most about", () => {
    const s = snap();
    const base = s.recommend!.papers[0];
    s.recommend!.papers = [
      { ...base, title: "opt one", url: "https://x/1", keywords: ["Optimization", "Adam"] },
      { ...base, title: "opt two", url: "https://x/2", keywords: ["Optimization", "Muon"] },
      { ...base, title: "sys one", url: "https://x/3", keywords: ["Systems"] },
    ];
    const { html } = renderDigest({ kind: "weekly", snapshot: s });
    // The shared keyword wins over the one that appears once, and it is the
    // only heading: a recommendation with four headings is a second inbox.
    expect(html).toContain("Papers · Optimization");
    expect(html).not.toContain("Papers · Systems");
    expect(html).not.toContain("Papers · Paper");
  });

  it("reports what the one topic left out instead of dropping it silently", () => {
    const s = snap();
    const base = s.recommend!.papers[0];
    s.recommend!.papers = [
      ...Array.from({ length: 9 }, (_, i) => ({
        ...base,
        title: `opt ${i}`,
        url: `https://x/opt/${i}`,
        keywords: ["Optimization"],
      })),
      { ...base, title: "sys only", url: "https://x/sys", keywords: ["Systems"] },
    ];
    const { html } = renderDigest({ kind: "weekly", snapshot: s });
    expect(html).toContain("opt 4");
    expect(html).not.toContain("opt 5");
    expect(html).not.toContain("sys only");
    expect(html).toContain("+ 1 more across 1 other topic");
  });

  it("falls back to the category when a summary carries no keywords", () => {
    const s = snap();
    s.recommend!.papers = [{ ...s.recommend!.papers[0], keywords: [] }];
    expect(renderDigest({ kind: "weekly", snapshot: s }).html).toContain("Papers · Paper");
  });

  // A job can hold both the original title and a translated one, pointing at
  // the same source, and the pair arrived as two rows of the same paper.
  it("lists one row per source, not one per summary of it", () => {
    const s = snap();
    const base = s.recommend!.papers[0];
    s.recommend!.papers = [
      { ...base, title: "Shared Semantics", url: "https://arxiv.org/abs/2606.08236" },
      { ...base, title: "Shared Semantics (\uD55C\uAD6D\uC5B4)", url: "https://arxiv.org/abs/2606.08236" },
    ];
    const { html } = renderDigest({ kind: "weekly", snapshot: s });
    expect(html).toContain("Shared Semantics");
    expect(html).not.toContain("(\uD55C\uAD6D\uC5B4)");
  });

  // pre_submit_check is a database value. The browser has always shown the
  // label and the mail was printing the id, so one project read as two things.
  it("names a phase the way the app does, never the raw state id", () => {
    const s = snap();
    s.research.projects = [{ slug: "vls", title: "VLS", kind: "own", phase: "pre_submit_check" }];
    const { html, text } = renderDigest({ kind: "weekly", snapshot: s });
    for (const part of [html, text]) {
      expect(part).toContain("pre-submit check");
      expect(part).not.toContain("pre_submit_check");
    }
  });

  it("falls back to the id when the state is not one it knows", () => {
    const s = snap();
    s.research.projects = [{ slug: "x", title: "X", kind: "own", phase: "some_future_state" }];
    expect(renderDigest({ kind: "weekly", snapshot: s }).html).toContain("some_future_state");
  });

  // A card is read away from the app, so it has to say how the headword sounds:
  // IPA and the hangul approximation for the English side, kana for the
  // Japanese one. What it must not carry is the other language's gloss, which
  // is what had an English word arriving explained in Japanese.
  it("carries the pronunciation of the side it is prompting with", () => {
    const s = snap();
    s.vocab.study = [
      {
        en: "piggyback",
        ipa: "/ˈpɪɡibæk/",
        ko: "\uD53C\uAE30\uBC31",
        jp: "便乗する",
        reading: "びんじょうする",
        meaning: "\uAE30\uC874\uC758 \uAC83\uC5D0 \uC5B9\uC5B4 \uAC04\uB2E4",
        due: "2026-07-11",
        reps: 0,
      },
    ];
    const { html, text } = renderDigest({ kind: "weekly", snapshot: s });
    for (const part of [html, text]) {
      expect(part).toContain("piggyback");
      expect(part).toContain("/ˈpɪɡibæk/");
      expect(part).toContain("\uD53C\uAE30\uBC31");
      expect(part).toContain("\uAE30\uC874\uC758 \uAC83\uC5D0 \uC5B9\uC5B4 \uAC04\uB2E4");
      // The English side is the prompt here, so the Japanese translation is not
      // the answer and does not appear.
      expect(part).not.toContain("便乗する");
    }
  });

  it("gives the Japanese side its kana reading instead", () => {
    const s = snap();
    s.vocab.study = [
      {
        en: "a",
        jp: "亜",
        reading: "あ",
        ipa: "/eɪ/",
        ko: "\uC5D0\uC774",
        meaning: "\uCCAB \uBC88\uC9F8",
        due: "2026-07-11",
        reps: 0,
      },
      {
        en: "piggyback",
        jp: "便乗する",
        reading: "びんじょうする",
        ipa: "/ˈpɪɡibæk/",
        ko: "\uD53C\uAE30\uBC31",
        meaning: "\uC5B9\uC5B4 \uAC04\uB2E4",
        due: "2026-07-11",
        reps: 0,
      },
    ];
    const { html } = renderDigest({ kind: "weekly", snapshot: s });
    expect(html).toContain("便乗する");
    expect(html).toContain("びんじょうする");
    // The IPA belongs to the English headword, which this card is not showing.
    expect(html).not.toContain("/ˈpɪɡibæk/");
  });

  // Rows the enrichment has not reached yet still have to render.
  it("renders a card that has no meaning yet", () => {
    const s = snap();
    s.vocab.study = [{ en: "piggyback", due: "2026-07-11", reps: 0 }];
    const html = renderDigest({ kind: "weekly", snapshot: s }).html;
    expect(html).toContain("piggyback");
    expect(html).not.toContain("undefined");
  });

  it("shows a section once it has content", () => {
    const html = renderDigest({
      kind: "weekly",
      snapshot: snap({ insights: [{ text: "a sharp idea", origin: "manual", status: "new" }] }),
    }).html;
    expect(html).toContain("Insights");
    expect(html).toContain("a sharp idea");
  });

  it("labels the two cadences differently", () => {
    expect(renderDigest({ kind: "weekly", snapshot: snap() }).html).toContain("WEEKLY");
    expect(renderDigest({ kind: "daily", snapshot: snap() }).html).toContain("DAILY");
  });

  it("puts the numbers a reader scans for in the subject", () => {
    const weekly = renderDigest({ kind: "weekly", snapshot: snap() }).subject;
    expect(weekly).toContain("4 archived");
    expect(weekly).toContain("9 papers");
    expect(weekly).toContain("mean 6.23");
    expect(renderDigest({ kind: "daily", snapshot: snap() }).subject).toContain("Openworks daily");
  });

  it("handles a window with no scored paper rather than printing NaN", () => {
    const r = renderDigest({
      kind: "daily",
      snapshot: snap({ papers: { count: 0, scored: 0, mean: null, items: [] } }),
    });
    expect(r.subject).not.toContain("NaN");
    expect(r.html).not.toContain("NaN");
    expect(r.html).not.toContain("undefined");
  });

  // Mail clients drop @font-face and many strip <style>, so the template has
  // to carry its own styling inline and pull no external asset.
  it("uses no external stylesheet, font or script", () => {
    const html = renderDigest({ kind: "weekly", snapshot: snap(), prs: [pr()] }).html;
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("@font-face");
    expect(html).not.toContain("@import");
  });

  it("says so when the window hit the read cap", () => {
    expect(renderDigest({ kind: "weekly", snapshot: snap({ truncated: true }) }).html).toContain("capped");
    expect(renderDigest({ kind: "weekly", snapshot: snap() }).html).not.toContain("capped");
  });

  it("writes a plain-text alternative that is not empty", () => {
    const { text } = renderDigest({ kind: "weekly", snapshot: snap(), prs: [pr()] });
    expect(text).toContain("OPENWORKS WEEKLY");
    expect(text).toContain("SOAP, Muon, and Beyond");
    expect(text.length).toBeGreaterThan(50);
  });

  // One mail is rendered three times over, and a name written by hand into any
  // one of them ships a header that disagrees with its own subject line.
  // Asserting on all three is what catches the surface nobody remembered.
  it("names the product on every rendered surface", () => {
    const { subject, text, html } = renderDigest({ kind: "daily", snapshot: snap() });
    for (const part of [subject, text, html]) {
      expect(part).toMatch(/openworks/i);
    }
  });

  // Every mail client honours inline styles; <style> is dropped by enough of
  // them that hoisting into classes arrives as unformatted text.
  it("styles the mail inline rather than through a stylesheet", () => {
    const { html } = renderDigest({ kind: "weekly", snapshot: snap(), prs: [pr()] });
    expect(html).not.toContain("<style>");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('style="');
  });
});

// Gmail stops rendering near 102KB and hides the rest behind "View entire
// message", so an oversized digest loses whichever sections came last without
// saying so. A real week already produced a 169KB message.
describe("staying inside the mail size limit", () => {
  const heavy = () => {
    const long = "\uAC00".repeat(600);
    return snap({
      papers: {
        count: 40,
        scored: 40,
        mean: 6.5,
        items: Array.from({ length: 40 }, (_, i) => ({
          title: `paper ${i} ${long}`,
          url: `https://arxiv.org/abs/${i}`,
          summary: long,
          overall: 6.5,
          category: "Paper",
          jobId: `j${i}`,
          type: "paper",
          tldr: [long, long, long],
        })),
      },
      articles: {
        count: 60,
        items: Array.from({ length: 60 }, (_, i) => ({
          title: `article ${i} ${long}`,
          url: `https://example.com/${i}`,
          summary: long,
          category: "Article",
          jobId: `a${i}`,
          type: "newsletter",
          tldr: [long, long, long],
        })),
      },
    });
  };

  const bytes = (r: { html: string; text: string }) =>
    Buffer.byteLength(r.html, "utf8") + Buffer.byteLength(r.text, "utf8");

  it("trims a heavy week instead of letting the client cut it", () => {
    const r = renderDigest({
      kind: "weekly",
      snapshot: heavy(),
      prs: Array.from({ length: 60 }, (_, i) => pr({ number: i, author: "dependabot[bot]" })),
    });
    expect(bytes(r)).toBeLessThanOrEqual(MAX_BODY_BYTES);
  });

  it("says what it dropped rather than trimming silently", () => {
    const r = renderDigest({ kind: "weekly", snapshot: heavy() });
    expect(r.html).toContain("trimmed to fit");
  });

  it("leaves an ordinary week untrimmed", () => {
    const r = renderDigest({ kind: "weekly", snapshot: snap(), prs: [pr()] });
    expect(r.html).not.toContain("trimmed to fit");
    expect(bytes(r)).toBeLessThan(MAX_BODY_BYTES);
  });

  it("keeps the study list, which sits last and would be the first thing lost", () => {
    const r = renderDigest({ kind: "weekly", snapshot: heavy() });
    expect(r.html).toContain("piggyback");
  });

  it("fits an ordinary week without dropping a single pull request", () => {
    const prs = Array.from({ length: 40 }, (_, i) =>
      pr({ number: i, url: `https://github.com/acme/widgets/pull/${i}`, author: "dependabot[bot]" }),
    );
    const r = renderDigest({ kind: "weekly", snapshot: snap(), prs });
    for (const p of prs) expect(r.html).toContain(`"${p.url}"`);
    expect(r.html).not.toContain("trimmed to fit");
  });
});

describe("markdown in a summary", () => {
  it("keeps a link's label and drops the address it would have printed twice", () => {
    expect(plainText("[numbat](https://github.com/perplexityai/numbat) watches endpoints")).toBe(
      "numbat watches endpoints",
    );
  });

  it("unwraps emphasis and code so the markers do not show as text", () => {
    expect(plainText("**bold** and `code`")).toBe("bold and code");
  });

  it("leaves prose that only looks like markup alone", () => {
    expect(plainText("f(x) [see note] and a * b")).toBe("f(x) [see note] and a * b");
  });

  it("reaches the rendered summary, not just the helper", () => {
    const s = snap();
    s.articles.items = [
      {
        title: "numbat",
        url: "https://example.com/n",
        summary: "[numbat](https://github.com/perplexityai/numbat) gives endpoint visibility",
        category: "Repo",
        jobId: "j1",
        type: "article",
      },
    ];
    const r = renderDigest({ kind: "weekly", snapshot: s });
    expect(r.html).toContain("numbat gives endpoint visibility");
    expect(r.html).not.toContain("github.com/perplexityai/numbat)");
  });
});

describe("hoisting repeated styles", () => {
  // Every rule that survives has to still be reachable: a class that names no
  // rule, or a rule no element names, is a silently unstyled mail.
  const classesResolve = (html: string) => {
    const declared = new Set([...html.matchAll(/\.(q[0-9a-z]+)\{/g)].map((m) => m[1]));
    const used = new Set([...html.matchAll(/ class="(q[0-9a-z]+)"/g)].map((m) => m[1]));
    return [...used].every((c) => declared.has(c)) && [...declared].every((c) => used.has(c));
  };

  it("collapses a rule that repeats and leaves a one-off inline", () => {
    const twice = ` style="color:red;padding-bottom:12px;"`;
    const html = `<div${twice}>a</div><div${twice}>b</div><div style="color:blue;padding:44px 9px 3px 1px;">c</div>`;
    const out = hoistStyles(html);
    expect(out).toContain(".q0{color:red;padding-bottom:12px;}");
    expect(out).toContain(`style="color:blue;padding:44px 9px 3px 1px;"`);
    expect(classesResolve(out)).toBe(true);
  });

  it("declares each surviving class exactly once and uses each one", () => {
    const r = renderDigest({ kind: "weekly", snapshot: snap(), prs: [pr(), pr({ number: 2 })] });
    expect(classesResolve(r.html)).toBe(true);
  });

  it("shrinks the message, which is the only reason to do it", () => {
    const row = ` style="font-family:Menlo,monospace;font-size:13px;color:#8a8478;"`;
    const many = Array.from({ length: 30 }, (_, i) => `<div${row}>${i}</div>`).join("");
    // The rule is carried once instead of thirty times, so the saving has to be
    // most of what the repetition cost.
    expect(hoistStyles(many).length).toBeLessThan(many.length * 0.5);
  });

  it("does not chew on a title that merely looks like markup", () => {
    // `esc` turns the quotes into entities, so the attribute regex cannot reach
    // into copy. Escaped text must come through a hoist byte for byte.
    const titled = esc(`a style="color:red;" trick`);
    const out = hoistStyles(`<div style="color:red;padding-bottom:9px;">${titled}</div>`);
    expect(out).toContain(titled);
  });

  it("leaves html alone when nothing repeats", () => {
    const html = `<div style="color:red;">a</div><span>b</span>`;
    expect(hoistStyles(html)).toBe(html);
  });
});

describe("when a digest is due", () => {
  // Local time throughout: the day the reader means is the day their machine
  // is in, and the period key doubles as the send's identity.
  const at = (y: number, m: number, d: number, h: number) => new Date(y, m - 1, d, h, 0, 0);

  it("sends nothing before the send hour", () => {
    expect(digestsDue(at(2026, 8, 6, 7), 8)).toEqual([]);
    expect(digestsDue(at(2026, 8, 6, 8), 8).length).toBeGreaterThan(0);
  });

  it("covers yesterday in full, not a rolling 24 hours", () => {
    const [daily] = digestsDue(at(2026, 8, 6, 9), 8);
    expect(new Date(daily.since)).toEqual(at(2026, 8, 5, 0));
    expect(new Date(daily.until)).toEqual(at(2026, 8, 6, 0));
  });

  it("keys the daily send by local calendar day", () => {
    expect(digestsDue(at(2026, 8, 6, 9), 8)[0].periodKey).toBe("2026-08-06");
  });

  // 2026-08-06 is a Thursday; 2026-08-10 is a Monday.
  it("adds the weekly only on the configured weekday", () => {
    expect(digestsDue(at(2026, 8, 6, 9), 8).map((d) => d.kind)).toEqual(["daily"]);
    expect(digestsDue(at(2026, 8, 10, 9), 8).map((d) => d.kind)).toEqual(["daily", "weekly"]);
  });

  it("makes the weekly cover the seven days before today", () => {
    const weekly = digestsDue(at(2026, 8, 10, 9), 8).find((d) => d.kind === "weekly")!;
    expect(new Date(weekly.since)).toEqual(at(2026, 8, 3, 0));
    expect(new Date(weekly.until)).toEqual(at(2026, 8, 10, 0));
    expect(new Date(weekly.prevSince)).toEqual(at(2026, 7, 27, 0));
  });

  it("gives the two kinds different keys on a Monday, so one claim cannot swallow the other", () => {
    const due = digestsDue(at(2026, 8, 10, 9), 8);
    expect(due[0].periodKey).not.toBe(due[1].periodKey);
  });

  // A week that straddles New Year must keep one key, or the year boundary
  // splits it into two partial digests.
  it("uses ISO weeks so a new-year week is not split", () => {
    expect(isoWeekKey(new Date(2026, 11, 31))).toBe(isoWeekKey(new Date(2027, 0, 1)));
    expect(isoWeekKey(new Date(2026, 0, 4))).toBe("2026-W01");
  });
});

describe("the gws request", () => {
  it("posts through the raw messages API, because +send cannot carry HTML", () => {
    const args = gwsSendArgs("me@example.com", "RAWDATA");
    expect(args.slice(0, 4)).toEqual(["gmail", "users", "messages", "send"]);
    expect(args).toContain(JSON.stringify({ raw: "RAWDATA" }));
    expect(args).toContain(JSON.stringify({ userId: "me" }));
    expect(args).not.toContain("--dry-run");
  });

  it("can be asked for a dry run", () => {
    expect(gwsSendArgs("me@example.com", "X", true)).toContain("--dry-run");
  });
});

describe("the MIME message", () => {
  it("round-trips through base64url with both alternatives", () => {
    const raw = buildMime("me@example.com", "\uC81C\uBAA9 test", "<b>hi</b>", "hi");
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toContain("To: me@example.com");
    expect(decoded).toContain("multipart/alternative");
    expect(decoded).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(decoded).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(Buffer.from("<b>hi</b>", "utf8").toString("base64")).toBeTruthy();
    expect(decoded).toContain(Buffer.from("<b>hi</b>", "utf8").toString("base64"));
  });

  // A raw Subject header is 7-bit only, so Korean subjects have to be encoded
  // or Gmail rejects the message.
  it("encodes a non-ascii subject rather than sending it raw", () => {
    const decoded = Buffer.from(buildMime("a@b.c", "\uC8FC\uAC04 \uC694\uC57D", "<p></p>", ""), "base64url").toString(
      "utf8",
    );
    expect(decoded).not.toContain("Subject: \uC8FC\uAC04 \uC694\uC57D");
    expect(decoded).toContain("Subject: =?UTF-8?B?");
    const encoded = decoded.match(/Subject: =\?UTF-8\?B\?(.+?)\?=/)![1];
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe("\uC8FC\uAC04 \uC694\uC57D");
  });

  it("closes the multipart boundary", () => {
    const decoded = Buffer.from(buildMime("a@b.c", "s", "<p>h</p>", "h"), "base64url").toString("utf8");
    expect(decoded.trimEnd().endsWith("--openworks-digest-boundary--")).toBe(true);
  });
});
