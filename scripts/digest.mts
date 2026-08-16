// The emailed digest: Openworks's own visual language, rendered for mail clients.
//
// Rendering is pure and lives apart from the sending so the template can be
// tested and previewed without a mailbox. Everything the worker needs to
// assemble one is `digest:snapshot` plus, optionally, the open PR list.
//
// Mail is not the browser. Three constraints shape every choice below:
//   - No web fonts. Gmail drops @font-face, so Instrument Serif / DM Sans /
//     IBM Plex Mono degrade to Georgia and the system stacks. The type scale
//     carries the identity instead of the typefaces.
//   - No external CSS and no <style> worth relying on. Every rule is inline.
//   - Tables, not flexbox, because Outlook renders through Word.

import { OWN_LABELS, REVIEW_LABELS } from "@openworks/domain";

export type DigestItem = {
  title: string;
  url: string;
  summary: string;
  overall?: number;
  category: string;
  keywords?: string[];
  jobId: string;
  type: string;
  tldr?: string[];
};

export type DigestSnapshot = {
  window: { since: number; until: number; hasPrev: boolean };
  truncated: boolean;
  // What was cleared, which is the number this digest exists to report.
  archived: { total: number; prevTotal: number | null; byType: Record<string, number> };
  suggestions: { approved: number; rejected: number; pending: number };
  jobs: { total: number; prevTotal: number | null; byType: Record<string, number>; errored: number };
  papers: { count: number; scored: number; mean: number | null; items: DigestItem[] };
  articles: { count: number; items: DigestItem[] };
  newsletters: { count: number; items: DigestItem[] };
  // What to read next, out of the unarchived backlog rather than the window.
  // Optional so a snapshot from an older deployment still renders.
  recommend?: { papers: DigestItem[]; articles: DigestItem[]; newsletters: DigestItem[] };
  insights: {
    text: string;
    source?: string;
    sourceUrl?: string;
    origin: string;
    status: string;
    notionPageName?: string;
    notionPageUrl?: string;
  }[];
  research: {
    projects: { slug: string; title: string; kind: string; phase: string; venue?: string; deadline?: string }[];
    moves: { researchSlug: string; state: string; note?: string; at: number; actor?: string }[];
    reports?: { researchSlug: string; day: string; author: string; body: string }[];
  };
  planItems: { title: string; date: string; kind: string; done: boolean; time?: string; tags: string[] }[];
  vocab: {
    added: { en: string; jp?: string; meaning?: string; reps: number }[];
    due: number;
    moreDue: number;
    study: {
      id?: string;
      en: string;
      jp?: string;
      reading?: string;
      meaning?: string;
      example?: string;
      ipa?: string;
      ko?: string;
      due: string;
      reps: number;
    }[];
  };
  diet: { entries: number; days: number; kcal: number; protein: number; carbs: number; fat: number };
};

export type DigestPR = {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  // Filled by github:listPRDetails and github:getChecks. Optional because the
  // search payload alone cannot answer them, and a mail that lost its GitHub
  // token should still list the PRs it knows about rather than nothing.
  checksPass?: number;
  checksTotal?: number;
  checksState?: string;
  mergeable?: boolean | null;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
};

export type DigestInput = {
  kind: "daily" | "weekly";
  snapshot: DigestSnapshot;
  prs?: DigestPR[];
  appUrl?: string;
};

// Openworks's tokens from browser/src/index.css. Mail clients cannot read CSS
// variables, so they are literals here and must be kept in step by hand.
const C = {
  paper: "#ffffff",
  paperWarm: "#fafafa",
  ink: "#0a0a0a",
  ink2: "#4a4a4a",
  ink3: "#8a8a8a",
  ink4: "#b8b8b8",
  rule: "#d4d4d4",
  ruleLight: "#e4e4e4",
  rust: "#333333",
  slate: "#3d5a80",
  ochre: "#5c5c5c",
  sage: "#5a7a5a",
};

// Kept short on purpose. Each of these is repeated inline on the order of a
// hundred times, so a long stack costs real kilobytes against the size limit
// below, and the extra fallbacks buy nothing a mail client would use.
const SERIF = "'Instrument Serif',Georgia,serif";
const SANS = "'DM Sans',Helvetica,Arial,sans-serif";
const MONO = "'IBM Plex Mono',Menlo,monospace";

// Gmail stops rendering a message near 102KB and hides the remainder behind
// "View entire message". Whatever came last would silently vanish, which for
// this layout is the study list. Both parts are base64 inside the message, so
// 102KB of message is only about 102/1.37 of source; 72KB keeps a margin under
// that even after the headers. The digest trims itself to fit and says what it
// dropped, rather than letting the mail client decide for it.
export const MAX_BODY_BYTES = 72_000;

// Body copy is 18px rather than the browser's 14px: this is read on a phone,
// once, and the ask was explicitly for large type.
const BODY = 18;

// Trades inline styles for a <style> block and classes, which is smaller but
// backwards for mail: inline is the only styling every client honours, and a
// client that drops <style> renders the whole layout as bare text. Reserved
// for the case where even the tightest content budget overruns MAX_BODY_BYTES,
// since unstyled-but-whole does beat a message Gmail cuts in half. It is not
// worth spending anywhere else: it saved about 11KB on a real send that had
// 45KB of headroom left.
export function hoistStyles(html: string): string {
  const uses = new Map<string, number>();
  for (const m of html.matchAll(/ style="([^"]*)"/g)) uses.set(m[1], (uses.get(m[1]) ?? 0) + 1);

  const rules: string[] = [];
  const names = new Map<string, string>();
  for (const [rule, n] of uses) {
    const name = `q${rules.length.toString(36)}`;
    // ` style="RULE"` costs 8+L per use; a class costs 9+k per use plus
    // `.name{RULE}` once. Only hoist when the repetition actually pays.
    if (n * (8 + rule.length) <= n * (9 + name.length) + 5 + name.length + rule.length) continue;
    names.set(rule, name);
    rules.push(`.${name}{${rule}}`);
  }
  if (rules.length === 0) return html;

  // `esc` turns a quote into &quot;, so no escaped title or summary can carry
  // a `style="` of its own for this to chew on.
  const out = html.replace(/ style="([^"]*)"/g, (whole, rule: string) => {
    const name = names.get(rule);
    return name ? ` class="${name}"` : whole;
  });
  return `<style>${rules.join("")}</style>\n${out}`;
}

// Summaries are written as markdown for the app's renderer. Mail shows them as
// text, so `[numbat](https://github.com/…)` printed the label and the whole URL
// side by side. Keep the label and drop the target: the row already links to
// the source, so the address was never the part worth reading.
export function plainText(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// A score's colour is its judgement: the Papers tab reads 7+ as worth keeping,
// 5 and under as noise, so the digest must not flatten them into one grey.
export function scoreColor(score: number): string {
  if (score >= 7) return C.sage;
  if (score >= 6) return C.slate;
  if (score >= 5) return C.ochre;
  return C.rust;
}

export function deltaLabel(now: number, prev: number | null): string {
  if (prev === null) return "";
  const d = now - prev;
  if (d === 0) return "same as last period";
  return `${d > 0 ? "+" : ""}${d} vs last period`;
}

function section(title: string, inner: string): string {
  if (!inner.trim()) return "";
  return `
  <tr><td style="padding:34px 32px 0 32px;">
    <div style="font-family:${MONO};font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:${C.ink3};padding-bottom:6px;">${esc(title)}</div>
    <div style="height:1px;background:${C.rule};font-size:0;line-height:0;">&nbsp;</div>
  </td></tr>
  <tr><td style="padding:14px 32px 0 32px;font-family:${SANS};font-size:${BODY}px;line-height:1.6;color:${C.ink};">${inner}</td></tr>`;
}

// One big number with its label. Rendered as table cells so Outlook keeps the
// row on one line instead of stacking.
function stat(value: string, label: string, color = C.ink): string {
  // The gap has to clear the widest label, not the number: at 42px the values
  // are narrow but "open prs" is not, and a tighter rule ran them together.
  return `<td style="padding:0 38px 0 0;vertical-align:bottom;white-space:nowrap;">
    <div style="font-family:${SERIF};font-size:44px;line-height:1;color:${color};">${esc(value)}</div>
    <div style="font-family:${MONO};font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${C.ink3};padding-top:7px;">${esc(label)}</div>
  </td>`;
}

function chip(text: string, color: string): string {
  return `<span style="font-family:${MONO};font-size:13px;color:${color};border:1px solid ${color};border-radius:3px;padding:1px 7px;white-space:nowrap;">${esc(text)}</span>`;
}

// Where a title goes. The mail is a way into the app, not a way around it: the
// row you tapped opens as the row you tapped, with its summary, its score, its
// comments and the archive control all present. `item` is the job id and the
// app resolves it whatever the current filter is, so the link survives a queue
// that has moved on. The source itself stays one line below, since sometimes
// the paper is what you want and not the entry about it.
export function itemHref(item: DigestItem, appUrl?: string): string {
  if (!appUrl || !item.jobId) return item.url;
  const href = appHref(appUrl, {
    // `newsletter` is the app's default tab and is dropped from its own URLs,
    // so writing it here would produce a link the app immediately rewrites.
    tab: item.type && item.type !== "newsletter" ? item.type : undefined,
    item: item.jobId,
  });
  return href ?? item.url;
}

// Every other section wants the same thing the item titles want: a link that
// lands on the row inside the app. Returns null rather than a broken string
// when there is no app URL configured, so each caller decides its own fallback
// (a PR still has GitHub to fall back to; a vocabulary card has nowhere).
export function appHref(appUrl: string | undefined, params: Record<string, string | undefined>): string | null {
  if (!appUrl) return null;
  try {
    const url = new URL(appUrl);
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
    return url.toString();
  } catch {
    return null;
  }
}

// A PR link goes to the app, not to GitHub: the app is where the checks, the
// diff and the fix action already are, and reading the mail on a phone then
// bouncing to github.com loses all of it. GitHub stays as the fallback for a
// deployment with no app URL, which is the only case where the mail would
// otherwise carry a dead link.
export function prHref(p: DigestPR, appUrl?: string): string {
  return appHref(appUrl, { tab: "pr", pr: `${p.repo}#${p.number}` }) ?? p.url;
}

// Titles alone made the reader open the app to find out whether an item was
// worth reading, which is the opposite of what a digest is for. Each entry now
// carries its written summary.
function itemsBlock(
  rows: DigestItem[],
  opts: { showScore: boolean; limit: number; bodyChars: number; appUrl?: string },
): string {
  const items = dedupeByUrl(rows);
  if (items.length === 0) return "";
  return items
    .slice(0, opts.limit)
    .map((p) => {
      const score =
        opts.showScore && p.overall !== undefined
          ? `<span style="padding-right:9px;">${chip(p.overall.toFixed(1), scoreColor(p.overall))}</span>`
          : "";
      const tldr = (p.tldr ?? []).map((l) => plainText(l ?? "").trim()).filter(Boolean);
      const summary = plainText(p.summary);
      const body = tldr.length
        ? tldr
            .map(
              (l) =>
                `<div style="padding:0 0 5px 13px;text-indent:-13px;color:${C.ink2};">&middot;&nbsp;${esc(l.slice(0, opts.bodyChars))}</div>`,
            )
            .join("")
        : `<div style="color:${C.ink2};">${esc(summary.slice(0, opts.bodyChars))}${summary.length > opts.bodyChars ? "…" : ""}</div>`;
      return `
    <div style="padding:0 0 22px 0;">
      <div style="padding-bottom:6px;">${score}<a href="${esc(itemHref(p, opts.appUrl))}" style="color:${C.ink};text-decoration:none;font-weight:600;font-size:19px;">${esc(p.title)}</a></div>
      <div style="font-size:16px;line-height:1.62;">${body}</div>
      <div style="font-family:${MONO};font-size:12px;color:${C.ink3};padding-top:6px;">
        ${p.url ? `<a href="${esc(p.url)}" style="color:${C.ink3};">${esc(p.category)} &rarr; source</a>` : esc(p.category)}
      </div>
    </div>`;
    })
    .join("");
}

// One heading per topic instead of one list of everything. A flat list of a
// day's reading is a pile; the same rows under their own topic say what the day
// was about before a single title is read. Topics are ordered by how much
// arrived under them, so the day leads with whatever it was mostly about, and
// each is capped on its own so a busy topic cannot crowd out a quiet one.
// One source, one row. A job can hold more than one summary of the same piece,
// typically the original title and a translated one, and they arrived as two
// entries pointing at the same URL. Keeps the first, which after the score sort
// is the better-scored of the pair.
export function dedupeByUrl(items: DigestItem[]): DigestItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const key = (i.url ?? "").trim() || i.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function byTopic(rows: DigestItem[]): { topic: string; items: DigestItem[] }[] {
  const items = dedupeByUrl(rows);
  // `category` is "Paper" or "Article", which is the kind of thing, not what it
  // is about: grouping on it produced one heading reading "Papers · Paper".
  // The keywords each summary already carries are the subject, so a topic is
  // the keyword an item shares with the most of its neighbours. An item whose
  // keywords are all unique keeps its own first one and stands alone, which is
  // still a truer heading than the word "Paper".
  const freq = new Map<string, number>();
  for (const item of items) {
    for (const k of item.keywords ?? []) {
      const key = k.trim().toLowerCase();
      if (key) freq.set(key, (freq.get(key) ?? 0) + 1);
    }
  }
  const groups = new Map<string, DigestItem[]>();
  for (const item of items) {
    let topic = (item.category ?? "").trim() || "Other";
    let best = 0;
    for (const k of item.keywords ?? []) {
      const key = k.trim().toLowerCase();
      const n = freq.get(key) ?? 0;
      // Strictly greater, so a tie keeps the earlier keyword: the agents write
      // the primary subject first.
      if (key && n > best) {
        best = n;
        topic = k.trim();
      }
    }
    const list = groups.get(topic);
    if (list) list.push(item);
    else groups.set(topic, [item]);
  }
  return [...groups.entries()]
    .map(([topic, rows]) => ({ topic, items: rows }))
    .sort((a, b) => b.items.length - a.items.length || a.topic.localeCompare(b.topic));
}

// Only the day's actual topics. Grouping the whole backlog produced fifteen
// headings, nine of them holding a single paper, which is a list with extra
// rules drawn through it, and it pushed the message past the size limit. The
// biggest few are what the day is about; the tail is reported as a count.
function topicSections(
  label: string,
  items: DigestItem[],
  opts: { showScore: boolean; perTopic: number; maxTopics: number; bodyChars: number; appUrl?: string },
): string {
  if (items.length === 0) return "";
  const groups = byTopic(items);
  const kept = groups.slice(0, opts.maxTopics);
  const restTopics = groups.length - kept.length;
  const restItems = groups.slice(opts.maxTopics).reduce((n, g) => n + g.items.length, 0);
  const body = kept
    .map(({ topic, items: rows }) =>
      section(
        `${label} · ${topic}`,
        itemsBlock(rows, {
          showScore: opts.showScore,
          limit: opts.perTopic,
          bodyChars: opts.bodyChars,
          appUrl: opts.appUrl,
        }),
      ),
    )
    .join("");
  if (restTopics <= 0) return body;
  // The tail is a count of what this section did not print, so it points at the
  // tab holding all of it rather than being a dead line of text.
  const tail = `+ ${restItems} more across ${restTopics} other topic${restTopics === 1 ? "" : "s"}`;
  const href = appHref(opts.appUrl, { tab: items[0].type });
  return `${body}
  <tr><td style="padding:10px 32px 0 32px;">
    <div style="font-family:${MONO};font-size:12px;color:${C.ink3};">${href ? `<a href="${esc(href)}" style="color:${C.ink3};">${tail}</a>` : tail}</div>
  </td></tr>`;
}

// `pre_submit_check` is a database value, not a phase anyone says out loud. The
// browser has always shown the label and the mail was printing the raw id, so
// the same project read as two different things depending on where you saw it.
// Falls back to the id rather than blanking, since an unknown state is still
// information.
export function phaseLabel(kind: string, phase: string): string {
  const labels = kind === "review" ? REVIEW_LABELS : OWN_LABELS;
  return (labels as Record<string, string>)[phase] ?? phase;
}

function researchBlock(s: DigestSnapshot, appUrl?: string): string {
  const { projects, moves } = s.research;
  if (projects.length === 0) return "";
  const movedBySlug = new Map<string, number>();
  for (const m of moves) movedBySlug.set(m.researchSlug, (movedBySlug.get(m.researchSlug) ?? 0) + 1);
  const rows = projects
    .map((p) => {
      const n = movedBySlug.get(p.slug) ?? 0;
      const href = appHref(appUrl, { research: p.slug });
      const title = href
        ? `<a href="${esc(href)}" style="color:${C.ink};text-decoration:none;font-weight:500;">${esc(p.title)}</a>`
        : `<span style="font-weight:500;">${esc(p.title)}</span>`;
      return `
    <tr>
      <td style="padding:0 0 12px 0;vertical-align:top;">
        ${title}
        ${p.deadline ? `<div style="font-family:${MONO};font-size:12px;color:${C.rust};padding-top:2px;">due ${esc(p.deadline)}${p.venue ? ` · ${esc(p.venue)}` : ""}</div>` : ""}
      </td>
      <td style="padding:0 0 12px 0;vertical-align:top;text-align:right;white-space:nowrap;">
        ${chip(phaseLabel(p.kind, p.phase), n > 0 ? C.sage : C.ink3)}
        ${n > 0 ? `<div style="font-family:${MONO};font-size:11px;color:${C.sage};padding-top:3px;">${n} move${n > 1 ? "s" : ""}</div>` : ""}
      </td>
    </tr>`;
    })
    .join("");
  return `<table cellpadding="0" cellspacing="0" border="0" width="100%">${rows}</table>`;
}

// Reports grouped by project and read newest first, because the question this
// section answers is "where did each project get to", not "what happened on
// Tuesday". Two agents reporting the same day are two rows, not a merge: whose
// account it is matters when they disagree.
export function reportsByProject(
  s: DigestSnapshot,
): { slug: string; title: string; rows: { day: string; author: string; body: string }[] }[] {
  const reports = s.research.reports ?? [];
  if (reports.length === 0) return [];
  const titleBySlug = new Map(s.research.projects.map((p) => [p.slug, p.title]));
  const bySlug = new Map<string, { day: string; author: string; body: string }[]>();
  for (const r of reports) {
    const list = bySlug.get(r.researchSlug) ?? [];
    list.push({ day: r.day, author: r.author, body: r.body });
    bySlug.set(r.researchSlug, list);
  }
  return [...bySlug.entries()]
    .map(([slug, rows]) => ({
      slug,
      // A report can outlive the project row it names, so the slug is the
      // fallback rather than an empty heading.
      title: titleBySlug.get(slug) ?? slug,
      rows: rows.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.author.localeCompare(b.author))),
    }))
    .sort((a, b) => b.rows.length - a.rows.length || a.title.localeCompare(b.title));
}

function reportsBlock(s: DigestSnapshot, bodyChars: number, appUrl?: string): string {
  const groups = reportsByProject(s);
  if (groups.length === 0) return "";
  return groups
    .map(({ slug, title, rows }) => {
      const href = appHref(appUrl, { research: slug });
      const head = href
        ? `<a href="${esc(href)}" style="color:${C.ink};text-decoration:none;">${esc(title)}</a>`
        : esc(title);
      const body = rows
        .map(
          (r) => `
      <div style="padding:0 0 10px 0;">
        <span style="font-family:${MONO};font-size:12px;color:${C.ink4};">${esc(r.day.slice(5))} ${esc(r.author)}</span>
        <div style="font-size:16px;color:${C.ink2};padding-top:2px;">${esc(r.body.slice(0, bodyChars))}</div>
      </div>`,
        )
        .join("");
      return `<div style="padding-bottom:16px;">
      <div style="font-weight:500;font-size:17px;padding-bottom:6px;">${head}</div>
      <div style="border-left:2px solid ${C.ruleLight};padding-left:12px;">${body}</div>
    </div>`;
    })
    .join("");
}

function insightsBlock(s: DigestSnapshot): string {
  if (s.insights.length === 0) return "";
  return s.insights
    .slice(0, 6)
    .map(
      (i) => `
    <div style="border-left:3px solid ${C.ochre};padding:2px 0 2px 14px;margin:0 0 16px 0;">
      <div style="font-family:${SERIF};font-size:19px;line-height:1.5;color:${C.ink};">${esc(i.text.slice(0, 300))}</div>
      <div style="font-family:${MONO};font-size:12px;color:${C.ink3};padding-top:5px;">
        ${esc(i.source ?? i.origin)}${i.notionPageName ? ` → ${esc(i.notionPageName)}` : ""}
      </div>
    </div>`,
    )
    .join("");
}

// Dependency bots open most of the PRs and none of them are what the reader
// is checking for. Listing them by title buried the human ones entirely, so
// they collapse to one line and the humans get the space.
export function isBotPR(pr: DigestPR): boolean {
  return /\[bot\]$/.test(pr.author) || /^(dependabot|renovate)/i.test(pr.author);
}

// Every open PR, under its repo. Grouping is what makes a long list readable:
// the repo name is said once instead of on all 34 rows, and the reader scans
// by project. Human-authored PRs sort to the top of each group, since a repo
// is usually one real branch under a pile of dependency bumps.
// The state a PR is actually in, which is what decides whether it needs you:
// green checks and no conflict is waiting on a click, a red check is waiting on
// a fix. A title alone says none of that, so the list read as one flat pile
// whether every check had passed or every one had failed.
// `listOpenPRs` answers from GitHub's search payload, which carries no diff, so
// it fills the three counts with zero. Printing that produced `+0/-0` on every
// row whenever the detail call was skipped or failed: a placeholder rendered as
// a measurement. A pull request that really changes nothing has nothing to
// report either way, so an all-zero diffstat is treated as absent.
function hasDiffstat(p: DigestPR): boolean {
  return Boolean(p.additions || p.deletions || p.changedFiles);
}

export function prStatus(p: DigestPR): string {
  const bits: string[] = [];
  if (p.checksTotal && p.checksTotal > 0) {
    const color =
      p.checksState === "failure"
        ? C.rust
        : p.checksState === "pending"
          ? C.ochre
          : p.checksState === "success"
            ? C.sage
            : C.ink4;
    bits.push(`<span style="color:${color};">${p.checksPass ?? 0}/${p.checksTotal} checks</span>`);
  } else if (p.checksState === "pending") {
    bits.push(`<span style="color:${C.ochre};">checks running</span>`);
  }
  if (p.mergeable === false) bits.push(`<span style="color:${C.rust};">conflict</span>`);
  if (hasDiffstat(p)) {
    bits.push(
      `<span style="color:${C.sage};">+${p.additions ?? 0}</span>&thinsp;<span style="color:${C.rust};">&minus;${p.deletions ?? 0}</span>` +
        (p.changedFiles ? ` <span style="color:${C.ink4};">${p.changedFiles}f</span>` : ""),
    );
  }
  if (bits.length === 0) return "";
  return ` <span style="font-family:${MONO};font-size:12px;">${bits.join(" &middot; ")}</span>`;
}

// Same facts as prStatus, for the plain-text alternative.
export function prStatusText(p: DigestPR): string {
  const bits: string[] = [];
  if (p.checksTotal && p.checksTotal > 0) bits.push(`${p.checksPass ?? 0}/${p.checksTotal} checks`);
  else if (p.checksState === "pending") bits.push("checks running");
  if (p.mergeable === false) bits.push("conflict");
  if (hasDiffstat(p)) {
    bits.push(`+${p.additions ?? 0}/-${p.deletions ?? 0}${p.changedFiles ? ` ${p.changedFiles}f` : ""}`);
  }
  return bits.length ? `  [${bits.join(" · ")}]` : "";
}

// Text mirror of topicSections, including the same topic cap: the two parts of
// one message disagreeing about what it contains is worse than either choice.
function topicLines(
  label: string,
  items: DigestItem[],
  perTopic: number,
  maxTopics: number,
  showScore: boolean,
  appUrl?: string,
): string[] {
  if (items.length === 0) return [];
  const groups = byTopic(items);
  const kept = groups.slice(0, maxTopics);
  const restItems = groups.slice(maxTopics).reduce((n, g) => n + g.items.length, 0);
  return [
    ...kept.flatMap(({ topic, items: rows }) => [
      `${label} · ${topic.toUpperCase()}`,
      ...rows
        .slice(0, perTopic)
        .flatMap((p) => [
          `  ${showScore && p.overall !== undefined ? `${p.overall.toFixed(1)}  ` : ""}${p.title}`,
          `      ${itemHref(p, appUrl)}`,
        ]),
      "",
    ]),
    ...(restItems > 0
      ? [
          `  + ${restItems} more across ${groups.length - kept.length} other topics`,
          ...(appHref(appUrl, { tab: items[0].type }) ? [`      ${appHref(appUrl, { tab: items[0].type })}`] : []),
          "",
        ]
      : []),
  ];
}

function prBlock(prs: DigestPR[] | undefined, appUrl?: string): string {
  if (!prs || prs.length === 0) return "";
  const byRepo = new Map<string, DigestPR[]>();
  for (const p of prs) {
    const list = byRepo.get(p.repo) ?? [];
    list.push(p);
    byRepo.set(p.repo, list);
  }
  // Repos with human work first, then by how much is open.
  const repos = [...byRepo.entries()].sort((a, b) => {
    const ah = a[1].filter((p) => !isBotPR(p)).length;
    const bh = b[1].filter((p) => !isBotPR(p)).length;
    if (ah !== bh) return bh - ah;
    return b[1].length - a[1].length;
  });

  // One <a> per PR rather than a two-cell table row. With 38 open PRs the
  // per-row style attributes were 29KB, 44% of the whole mail and more than
  // papers and articles put together, which is what pushed the message past
  // the point where Gmail cuts it off. The author is dropped for bots because
  // it is the same name on every one of those rows.
  const human = `color:${C.ink};text-decoration:none;font-weight:500;`;
  const bot = `color:${C.ink3};text-decoration:none;`;
  return repos
    .map(([repo, list]) => {
      const sorted = [...list].sort((a, b) => Number(isBotPR(a)) - Number(isBotPR(b)) || a.number - b.number);
      const rows = sorted
        .map((p) => {
          const who = isBotPR(p) ? "" : ` <span style="color:${C.ink4};">${esc(p.author)}</span>`;
          return `<div style="padding-bottom:6px;"><a href="${esc(prHref(p, appUrl))}" style="${isBotPR(p) ? bot : human}"><span style="color:${isBotPR(p) ? C.ink4 : C.rust};">#${p.number}</span> ${esc(p.title)}</a>${who}${p.draft ? ` <span style="color:${C.ink4};">draft</span>` : ""}${prStatus(p)}</div>`;
        })
        .join("");
      const repoHref = appHref(appUrl, { tab: "pr", pr: repo }) ?? `https://github.com/${repo}/pulls`;
      return `<div style="padding-bottom:16px;font-size:16px;">
      <a href="${esc(repoHref)}" style="font-family:${MONO};font-size:13px;color:${C.slate};text-decoration:none;">${esc(repo)} <span style="color:${C.ink4};">${list.length}</span></a>
      <div style="padding-top:6px;">${rows}</div>
    </div>`;
    })
    .join("");
}

// The cards due today, not a count. Pronunciation rides along because the mail
// is read away from the app: IPA for precision, Hangul because the reader gets
// there faster. Cards enriched before those fields existed simply show neither.
// Headword and what it means, and nothing else. The card used to stack the
// headword, its IPA, a hangul respelling, a Japanese translation, that
// translation's romaji, an English definition and a bilingual example: six
// lines and three languages for one word, which is how an English headword
// ended up explained in Japanese. `meaning` is written in the deployment's
// configured language, so this row is the gloss.
// Every card carries both an English expression and its Japanese equivalent, so
// prompting with the English side every time studies only half of what is
// stored. Alternating the prompt side turns one deck into two, and the gloss
// underneath stays in the reader's own language either way, which is the point
// of a gloss: English defined in English is a dictionary, not a study card.
export function studySide(index: number, card: { jp?: string }): "en" | "jp" {
  return index % 2 === 1 && card.jp ? "jp" : "en";
}

function vocabBlock(s: DigestSnapshot, appUrl?: string): string {
  if (s.vocab.study.length === 0) return "";
  const cards = s.vocab.study
    .map((c, i) => {
      const jp = studySide(i, c) === "jp";
      const head = jp ? c.jp! : c.en;
      // How to say it, which is the whole use of a card read away from the app.
      // The Japanese side gets its kana reading and the English side its IPA and
      // the hangul approximation, and neither gets the other language's gloss.
      const say = jp ? c.reading : [c.ipa, c.ko].filter(Boolean).join("  ");
      const href = appHref(appUrl, { tab: "vocab", expr: c.id });
      const headHtml = `<span style="font-size:19px;font-weight:600;color:${C.ink};">${esc(head)}</span>`;
      return `
    <div style="padding:0 0 12px 0;">
      ${href ? `<a href="${esc(href)}" style="text-decoration:none;">${headHtml}</a>` : headHtml}
      ${say ? `<span style="font-family:${MONO};font-size:13px;color:${C.ink3};padding-left:9px;">${esc(say)}</span>` : ""}
      ${c.meaning ? `<div style="font-size:16px;color:${C.ink2};padding-top:3px;">${esc(c.meaning.slice(0, 120))}</div>` : ""}
    </div>`;
    })
    .join("");
  const moreHref = appHref(appUrl, { tab: "vocab" });
  const moreText = `+ ${s.vocab.moreDue} more due`;
  const more =
    s.vocab.moreDue > 0
      ? `<div style="font-family:${MONO};font-size:13px;color:${C.ink3};">${moreHref ? `<a href="${esc(moreHref)}" style="color:${C.ink3};">${moreText}</a>` : moreText}</div>`
      : "";
  return cards + more;
}

function planBlock(s: DigestSnapshot): string {
  if (s.planItems.length === 0) return "";
  return s.planItems
    .slice(0, 15)
    .map(
      (p) => `
    <div style="padding:0 0 9px 0;">
      <span style="font-family:${MONO};font-size:13px;color:${C.ink3};">${esc(p.date)}${p.time ? ` ${esc(p.time)}` : ""}</span>
      <span style="padding-left:10px;${p.done ? `color:${C.ink3};text-decoration:line-through;` : ""}">${esc(p.title)}</span>
    </div>`,
    )
    .join("");
}

function dietBlock(s: DigestSnapshot): string {
  const bits: string[] = [];
  if (s.diet.entries > 0) {
    const perDay = s.diet.days > 0 ? Math.round(s.diet.kcal / s.diet.days) : 0;
    bits.push(
      `<div><span style="font-family:${MONO};font-size:13px;color:${C.ink3};">DIET</span> ${s.diet.entries} entries over ${s.diet.days} day${s.diet.days === 1 ? "" : "s"} · ${perDay} kcal/day · P${Math.round(s.diet.protein)} C${Math.round(s.diet.carbs)} F${Math.round(s.diet.fat)}</div>`,
    );
  }
  return bits.join("");
}

export function renderDigest(input: DigestInput): { subject: string; html: string; text: string } {
  const { kind, snapshot: s, prs } = input;
  const from = fmtDate(s.window.since);
  const to = fmtDate(s.window.until);
  const label = kind === "weekly" ? "WEEKLY" : "DAILY";
  const range = kind === "weekly" ? `${from} — ${to}` : to;

  const meanStr = s.papers.mean === null ? "—" : s.papers.mean.toFixed(2);
  const archivedDelta = deltaLabel(s.archived.total, s.archived.prevTotal);
  const humanPRs = prs?.filter((p) => !isBotPR(p));

  // Archived leads because clearing the queue is the outcome; reading is only
  // the work. `read` and `scored` used to sit side by side as if they measured
  // the same thing, and they do not: read counts jobs, scored counts summaries,
  // and only paper jobs are scored at all. So papers carry their own scored
  // figure and everything else is counted apart from them.
  const stats = `<table cellpadding="0" cellspacing="0" border="0"><tr>
    ${stat(String(s.archived.total), "archived", C.rust)}
    ${stat(`${s.papers.count}`, "papers")}
    ${stat(meanStr, "mean score", s.papers.mean === null ? C.ink3 : scoreColor(s.papers.mean))}
    ${humanPRs ? stat(String(humanPRs.length), "your prs") : ""}
    ${s.jobs.errored > 0 ? stat(String(s.jobs.errored), "errors", C.rust) : ""}
  </tr></table>
  ${archivedDelta ? `<div style="font-family:${MONO};font-size:14px;color:${C.ink2};padding-top:14px;">archived ${esc(archivedDelta)}</div>` : ""}
  <div style="font-family:${MONO};font-size:13px;color:${C.ink3};padding-top:5px;line-height:1.7;">
    read ${s.jobs.total} &nbsp;·&nbsp; ${Object.entries(s.jobs.byType)
      .map(([t, n]) => `${esc(t)} ${n}`)
      .join(" · ")}<br>
    ${s.papers.count > 0 ? `all ${s.papers.scored} of ${s.papers.count} papers scored &nbsp;·&nbsp; ` : ""}newsletters and articles are not scored
    ${s.suggestions.approved + s.suggestions.pending + s.suggestions.rejected > 0 ? `<br>notion suggestions: ${s.suggestions.approved} approved · ${s.suggestions.pending} pending${s.suggestions.rejected > 0 ? ` · ${s.suggestions.rejected} rejected` : ""}` : ""}
  </div>`;

  // Successively tighter budgets, tried in order until one fits. Papers keep
  // their detail longest because they are the point of the mail; the article
  // and newsletter list gives way first, since a newsletter contributes one
  // row per item and is what actually makes a week overflow.
  //
  // PRs are only capped in the last two tiers. The ask was to send all of
  // them, and normally that costs little; but on a week heavy enough to
  // overflow, keeping every dependency bump would cost the study list, which
  // is worse than a shortened PR list that says it is shortened.
  // One topic per section. A day has one thing it was about; printing four
  // topic headings under Papers and another four under Articles turned a
  // recommendation into a second inbox, which is the opposite of the point.
  // `perTopic` is therefore the size of the section, not a per-heading cap.
  // Newsletters are one flat list, since a roundup has no topic of its own.
  const BUDGETS = [
    { perTopic: 5, maxTopics: 1, newsletters: 5, chars: 420, prs: Infinity },
    { perTopic: 5, maxTopics: 1, newsletters: 5, chars: 340, prs: Infinity },
    { perTopic: 4, maxTopics: 1, newsletters: 5, chars: 260, prs: Infinity },
    { perTopic: 3, maxTopics: 1, newsletters: 4, chars: 180, prs: 40 },
    { perTopic: 3, maxTopics: 1, newsletters: 3, chars: 120, prs: 20 },
  ];

  // Human PRs survive a cap; the bumps are what get dropped.
  const prsFor = (b: (typeof BUDGETS)[number]) => {
    if (!prs || prs.length <= b.prs) return prs;
    const ranked = [...prs].sort((x, y) => Number(isBotPR(x)) - Number(isBotPR(y)));
    return ranked.slice(0, b.prs);
  };

  // The recommendation leads, because it is the part of the mail with something
  // to do in it. What the window actually held is reported under it, and on a
  // day that held nothing those sections simply do not appear. A counter block
  // used to sit above all of it, reporting a row of zeros on exactly the days
  // there was least to read.
  const rec = s.recommend;
  const topicOpts = (b: (typeof BUDGETS)[number], showScore: boolean) => ({
    showScore,
    perTopic: b.perTopic,
    maxTopics: b.maxTopics,
    bodyChars: b.chars,
    appUrl: input.appUrl,
  });
  const bodyFor = (b: (typeof BUDGETS)[number]) =>
    [
      topicSections("Papers", rec?.papers ?? [], topicOpts(b, true)),
      topicSections("Articles", rec?.articles ?? [], topicOpts(b, false)),
      section(
        "Newsletters",
        itemsBlock(rec?.newsletters ?? [], {
          showScore: false,
          limit: b.newsletters,
          bodyChars: b.chars,
          appUrl: input.appUrl,
        }),
      ),
      topicSections("Read · papers", s.papers.items, topicOpts(b, true)),
      topicSections("Read · articles", s.articles.items, topicOpts(b, false)),
      section(
        "Read · newsletters",
        itemsBlock(s.newsletters.items, {
          showScore: false,
          limit: b.newsletters,
          bodyChars: b.chars,
          appUrl: input.appUrl,
        }),
      ),
      section("Insights", insightsBlock(s)),
      section("Plan", planBlock(s)),
      section("Log", dietBlock(s)),
      section("Research", researchBlock(s, input.appUrl)),
      // Weekly only. A day's reports are the same day's work, which the person
      // who ran the agents already knows; a week of them is the thing they
      // cannot reconstruct from memory.
      kind === "weekly" ? section("Agent reports", reportsBlock(s, b.chars, input.appUrl)) : "",
      section("Open PRs", prBlock(prsFor(b), input.appUrl)),
      // Last. Vocabulary is the tail of this mail, not its subject.
      section("Study today", vocabBlock(s, input.appUrl)),
    ].join("");

  const htmlFor = (body: string, trimNote: string) =>
    `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.paperWarm};">
<div style="margin:0;padding:0;background:${C.paperWarm};">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${C.paperWarm};">
<tr><td align="center" style="padding:28px 12px;">
<table cellpadding="0" cellspacing="0" border="0" width="640" style="width:640px;max-width:100%;background:${C.paper};border:1px solid ${C.rule};">

  <tr><td style="padding:36px 32px 0 32px;">
    <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td style="vertical-align:baseline;">
        <span style="font-family:${SERIF};font-size:38px;line-height:1;color:${C.ink};letter-spacing:-0.01em;">Openworks</span>
      </td>
      <td style="vertical-align:baseline;text-align:right;">
        <span style="font-family:${MONO};font-size:11px;letter-spacing:0.18em;color:${C.rust};">${label}</span>
      </td>
    </tr></table>
    <div style="font-family:${MONO};font-size:13px;color:${C.ink3};padding-top:8px;">${esc(range)}</div>
    <div style="height:2px;background:${C.ink};margin-top:18px;font-size:0;line-height:0;">&nbsp;</div>
  </td></tr>

  ${body}

  <tr><td style="padding:34px 32px 32px 32px;">
    <div style="height:1px;background:${C.ruleLight};font-size:0;line-height:0;">&nbsp;</div>
    <div style="font-family:${MONO};font-size:12px;color:${C.ink3};padding-top:12px;line-height:1.6;">
      ${s.truncated ? `capped at the per-window read limit; some rows are not shown<br>` : ""}
      ${trimNote ? `${esc(trimNote)}<br>` : ""}
      ${input.appUrl ? `<a href="${esc(input.appUrl)}" style="color:${C.ink3};">open openworks</a>` : "openworks"}
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</div>
</body></html>`;

  // Archived leads the subject too, since it is the number being tracked.
  const subject =
    kind === "weekly"
      ? `Openworks weekly · ${s.archived.total} archived, ${s.papers.count} papers, mean ${meanStr}`
      : `Openworks daily · ${to} · ${s.archived.total} archived, ${s.jobs.total} read`;

  // Plain-text alternative, so the mail is not blank where HTML is refused.
  // URLs are spelled out here because there is nothing to attach a link to.
  const textFor = (b: (typeof BUDGETS)[number]) =>
    [
      `OPENWORKS ${label}  ${range}`,
      "",
      ...topicLines("PAPERS", rec?.papers ?? [], b.perTopic, b.maxTopics, true, input.appUrl),
      ...topicLines("ARTICLES", rec?.articles ?? [], b.perTopic, b.maxTopics, false, input.appUrl),
      ...(rec?.newsletters.length
        ? [
            "NEWSLETTERS",
            ...dedupeByUrl(rec.newsletters)
              .slice(0, b.newsletters)
              .flatMap((p) => [`  ${p.title}`, `      ${itemHref(p, input.appUrl)}`]),
            "",
          ]
        : []),
      ...topicLines("READ · PAPERS", s.papers.items, b.perTopic, b.maxTopics, true, input.appUrl),
      ...topicLines("READ · ARTICLES", s.articles.items, b.perTopic, b.maxTopics, false, input.appUrl),
      ...(s.newsletters.items.length
        ? [
            "READ · NEWSLETTERS",
            ...dedupeByUrl(s.newsletters.items)
              .slice(0, b.newsletters)
              .flatMap((p) => [`  ${p.title}`, `      ${itemHref(p, input.appUrl)}`]),
            "",
          ]
        : []),
      ...(s.research.projects.length
        ? [
            "RESEARCH",
            ...s.research.projects.flatMap((p) => {
              const href = appHref(input.appUrl, { research: p.slug });
              return [`  ${p.title}: ${phaseLabel(p.kind, p.phase)}`, ...(href ? [`      ${href}`] : [])];
            }),
            "",
          ]
        : []),
      ...(kind === "weekly" && reportsByProject(s).length
        ? [
            "AGENT REPORTS",
            ...reportsByProject(s).flatMap(({ title, rows }) => [
              `  ${title}`,
              ...rows.map((r) => `    ${r.day.slice(5)} ${r.author}  ${r.body.slice(0, b.chars)}`),
              "",
            ]),
          ]
        : []),
      ...(prsFor(b)?.length
        ? [
            "OPEN PRS",
            ...prsFor(b)!.map(
              (p) => `  ${p.repo} #${p.number} ${p.title}${prStatusText(p)}  ${prHref(p, input.appUrl)}`,
            ),
            "",
          ]
        : []),
      ...(s.vocab.study.length
        ? [
            "STUDY TODAY",
            ...s.vocab.study.flatMap((c, i) => {
              const jp = studySide(i, c) === "jp";
              const head = jp ? c.jp! : c.en;
              const say = jp ? c.reading : [c.ipa, c.ko].filter(Boolean).join("  ");
              const href = appHref(input.appUrl, { tab: "vocab", expr: c.id });
              return [
                `  ${head}${say ? `  ${say}` : ""}`,
                c.meaning ? `      ${c.meaning.slice(0, 120)}` : "",
                href ? `      ${href}` : "",
              ].filter(Boolean);
            }),
            s.vocab.moreDue > 0 ? `  + ${s.vocab.moreDue} more due` : "",
            "",
          ]
        : []),
    ]
      .filter((l) => l !== "")
      .join("\n");

  // Try each budget until the whole message fits, measuring html and text
  // together because both travel inside it. Falls through to the tightest
  // budget rather than sending something the client will cut in half.
  let html = "";
  let text = "";
  for (const b of BUDGETS) {
    // Counted per topic, because that is where the cap applies now: a section
    // with three topics keeps up to three times `perTopic`.
    const shown = (items: DigestItem[]) => byTopic(items).reduce((n, g) => n + Math.min(g.items.length, b.perTopic), 0);
    const droppedPapers = s.papers.items.length - shown(s.papers.items);
    const droppedArticles =
      s.articles.items.length - shown(s.articles.items) + Math.max(0, s.newsletters.items.length - b.newsletters);
    const droppedPRs = Math.max(0, (prs?.length ?? 0) - (prsFor(b)?.length ?? 0));
    const dropped = [
      droppedPapers > 0 ? `${droppedPapers} paper${droppedPapers === 1 ? "" : "s"}` : "",
      droppedArticles > 0 ? `${droppedArticles} article${droppedArticles === 1 ? "" : "s"}` : "",
      droppedPRs > 0 ? `${droppedPRs} PR${droppedPRs === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    const trimNote = dropped.length ? `trimmed to fit the mail size limit: ${dropped.join(", ")} more in the app` : "";
    html = htmlFor(bodyFor(b), trimNote);
    text = textFor(b);
    if (Buffer.byteLength(html, "utf8") + Buffer.byteLength(text, "utf8") <= MAX_BODY_BYTES) break;
  }

  // Last resort only. Hoisting used to run on every send, which cost the mail
  // its styling in any client that drops <style>: the whole layout arrived as
  // bare text. It was buying about 11KB against a budget with 45KB to spare,
  // because BUDGETS above already trims content to fit. Now it runs only when
  // even the tightest budget overruns, where unstyled-but-whole genuinely does
  // beat letting Gmail cut the message in half.
  if (Buffer.byteLength(html, "utf8") + Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    html = hoistStyles(html);
  }

  return { subject, html, text };
}

// ── Scheduling ─────────────────────────────────────────────────────────────
// All boundaries are the worker machine's local day, because that is the day
// the reader means. The period key doubles as the send's identity, so it has
// to be derived the same way on every wake-up.

function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ISO-8601 week, so a week starting Monday 29 Dec keeps one key across the
// year boundary instead of splitting into two partial digests.
export function isoWeekKey(d: Date): string {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  // Thursday of this week decides the year the week belongs to.
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
  const week1 = new Date(t.getFullYear(), 0, 4);
  const weeks = 1 + Math.round(((t.getTime() - week1.getTime()) / 86_400_000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${t.getFullYear()}-W${String(weeks).padStart(2, "0")}`;
}

function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export type DueDigest = {
  kind: "daily" | "weekly";
  periodKey: string;
  since: number;
  until: number;
  prevSince: number;
};

// Which digests are due right now. Returns both when a Monday morning is also
// a daily morning; the caller claims each separately, so one already sent does
// not suppress the other.
export function digestsDue(now: Date, sendHour: number, weeklyDow = 1): DueDigest[] {
  const due: DueDigest[] = [];
  if (now.getHours() < sendHour) return due;

  // Daily covers yesterday in full, which is why it is sent in the morning
  // rather than at midnight: nothing is still being written.
  const todayStart = startOfLocalDay(now);
  const dayLen = 86_400_000;
  due.push({
    kind: "daily",
    periodKey: localDayKey(now),
    since: todayStart - dayLen,
    until: todayStart,
    prevSince: todayStart - 2 * dayLen,
  });

  if (now.getDay() === weeklyDow) {
    due.push({
      kind: "weekly",
      periodKey: isoWeekKey(now),
      since: todayStart - 7 * dayLen,
      until: todayStart,
      prevSince: todayStart - 14 * dayLen,
    });
  }
  return due;
}

// Gmail's raw field wants a base64url RFC 2822 message. `gws gmail +send` only
// takes plain text, so an HTML digest has to be assembled here and posted
// through the raw messages.send API.
export function buildMime(to: string, subject: string, html: string, text: string): string {
  const boundary = "openworks-digest-boundary";
  const mime = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(text, "utf8").toString("base64"),
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html, "utf8").toString("base64"),
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}

// Arguments for `gws gmail users messages send`. Split from the spawn so a
// test can assert the request without a mailbox, and so a caller can dry-run
// the exact same command.
export function gwsSendArgs(to: string, raw: string, dryRun = false): string[] {
  return [
    "gmail",
    "users",
    "messages",
    "send",
    "--params",
    JSON.stringify({ userId: "me" }),
    "--json",
    JSON.stringify({ raw }),
    ...(dryRun ? ["--dry-run"] : []),
    "--format",
    "json",
  ];
}
