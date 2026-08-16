// Invented data for the demo build. Nothing here comes from a real
// deployment: the papers are famous enough to be recognisable, the scores are
// made up, and the projects are named for what they would be rather than for
// anything anyone is working on. Screenshots of the product are taken against
// this, so publishing one never publishes a reading list.

const DAY = 86_400_000;
const NOW = 1_755_000_000_000;
const ago = (days: number) => NOW - days * DAY;
const iso = (days: number) => new Date(ago(days)).toISOString().slice(0, 10);

type Job = Record<string, unknown>;

const job = (id: string, over: Job): Job => ({
  _id: id,
  _creationTime: ago(1),
  createdAt: ago(1),
  status: "done",
  url: "",
  ...over,
});

const papers: [string, string, number, string[]][] = [
  ["Attention Is All You Need", "https://arxiv.org/abs/1706.03762", 9.4, ["Transformer", "Self-Attention"]],
  ["Deep Residual Learning for Image Recognition", "https://arxiv.org/abs/1512.03385", 8.8, ["ResNet", "Vision"]],
  ["Denoising Diffusion Probabilistic Models", "https://arxiv.org/abs/2006.11239", 8.1, ["Diffusion", "Generative"]],
  ["Neural Ordinary Differential Equations", "https://arxiv.org/abs/1806.07366", 7.6, ["Neural ODE", "Dynamics"]],
  ["Chain-of-Thought Prompting", "https://arxiv.org/abs/2201.11903", 7.2, ["Reasoning", "Prompting"]],
  ["Mixture-of-Experts with Expert Choice Routing", "https://arxiv.org/abs/2202.09368", 6.4, ["MoE", "Routing"]],
  ["A Survey of Quantisation for Language Models", "https://arxiv.org/abs/2402.00000", 5.1, ["Quantisation"]],
];

const jobs: Job[] = [
  ...papers.map(([title, url, overall, keywords], i) =>
    job(`p${i}`, {
      type: "paper",
      title,
      url,
      createdAt: ago(i * 0.4),
      _creationTime: ago(i * 0.4),
      keywords,
      scores: { overall },
      tldr: [
        "Replaces recurrence with attention, so the whole sequence is seen at once.",
        "Trains in a fraction of the wall clock the recurrent baselines need.",
        "Sets up everything that followed it.",
      ],
    }),
  ),
  job("a0", {
    type: "article",
    title: "What actually makes a build reproducible",
    url: "https://example.com/reproducible-builds",
    createdAt: ago(0.2),
    _creationTime: ago(0.2),
    scores: { overall: 7.8 },
  }),
  job("n0", {
    type: "newsletter",
    title: "Weekly roundup, issue 214",
    url: "https://example.com/newsletter/214",
    createdAt: ago(0.6),
    _creationTime: ago(0.6),
  }),
  job("n1", {
    type: "newsletter",
    title: "Weekly roundup, issue 213",
    url: "https://example.com/newsletter/213",
    createdAt: ago(1.6),
    _creationTime: ago(1.6),
  }),
  job("p9", {
    type: "paper",
    title: "Scaling Laws Under a Fixed Compute Budget",
    url: "https://arxiv.org/abs/2403.00000",
    createdAt: ago(0.05),
    _creationTime: ago(0.05),
    status: "summarizing",
  }),
];

const project = (
  slug: string,
  title: string,
  phase: string,
  kind: "own" | "review",
  days: number,
  over: Record<string, unknown> = {},
) => ({
  _id: slug,
  _creationTime: ago(days),
  slug,
  title,
  kind,
  phase,
  updatedAt: ago(days),
  createdAt: ago(days + 40),
  ...over,
});

const own = [
  project("routing-under-budget", "Routing under a fixed budget", "analysis", "own", 0.2, {
    venue: "NeurIPS",
    deadline: iso(-38),
    keywords: ["routing", "budget"],
  }),
  project("long-context-recall", "What long context actually recalls", "writing", "own", 1.1, {
    venue: "ICLR",
    deadline: iso(-96),
    keywords: ["evaluation", "long context"],
  }),
  project("sparse-probe", "Probing sparsity without a second model", "run", "own", 2.4, {
    keywords: ["interpretability"],
  }),
  project("citation-drift", "Citation drift across preprint revisions", "literature", "own", 5.0, {
    keywords: ["meta-science"],
  }),
  project("held-out-eval", "A held-out set that survives contamination", "ideation", "own", 9.0),
];

const review = [
  project("workshop-batch", "Workshop batch, second round", "ranking", "review", 0.9),
  project("conference-cycle", "Conference cycle reviews", "rebuttal_audit", "review", 3.2),
];

const scoreBuckets = (rows: number[]) => {
  const buckets: Record<string, number> = {};
  for (const v of rows) {
    const bin = (Math.floor(v * 2) / 2).toFixed(1);
    buckets[bin] = (buckets[bin] ?? 0) + 1;
  }
  const sum = rows.reduce((a, b) => a + b, 0);
  return { count: rows.length, min: Math.min(...rows), max: Math.max(...rows), sum, buckets };
};

const paperScores = [9.4, 8.8, 8.1, 7.6, 7.2, 6.4, 5.1, 7.0, 6.8, 8.3, 7.9, 5.6, 6.1, 7.4, 8.6];
const articleScores = [7.8, 6.2, 5.4, 7.1, 6.9];

const dateSeries = (counts: number[]) => counts.map((count, i) => ({ date: iso(counts.length - 1 - i), count }));

export const queries: Record<string, unknown> = {
  "jobs:count": 11,
  "settings:get": { tabs: ["newsletter", "paper", "article", "pr", "research", "vocab"] },
  "summaries:scoreStats": { paper: scoreBuckets(paperScores), article: scoreBuckets(articleScores) },
  "jobs:jobDateStats": {
    created: dateSeries([2, 5, 3, 8, 6, 4, 7, 9, 5, 3, 6, 8, 4, 7]),
    published: dateSeries([1, 4, 2, 6, 5, 3, 6, 7, 4, 2, 5, 6, 3, 5]),
  },
  "jobs:newsletterStats": { total: 41, bySource: { "Weekly roundup": 22, "Papers digest": 12, Other: 7 } },
  "research:listByKind": own,
  "research:listByKindReview": review,
  "summaries:listByJob": [],
  "paperLinks:listByJob": [],
  "suggestions:listByJob": [],
};

export const paginated: Record<string, unknown[]> = {
  "jobs:list": jobs,
  "jobs:listPaperRefs": [],
};
