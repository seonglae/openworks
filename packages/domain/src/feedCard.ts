import type { UiLanguage } from "./uiText.ts";

// A feed card's composition, decided by the server so the phone can take a new
// order, label, colour or line limit without a release. The phone draws each
// block type it knows natively and skips any it does not, so a block added
// here reaches only the builds that know it; a card the phone cannot read
// falls back to the fields beside it.

export type CardAction = { kind: "open" | "source" | "archive" | "dismiss"; label: string; icon: string; url?: string };

export type CardBlock =
  | { type: "header"; title: string; lines: number }
  | {
      type: "figure";
      url: string;
      width?: number;
      height?: number;
      caption?: string;
      minRatio: number;
      maxRatio: number;
    }
  | { type: "image"; url: string; height: number }
  | { type: "formula"; tex: string; caption?: string; note?: string }
  | { type: "roles"; items: { label: string; color: string; text: string; lines: number }[] }
  | { type: "quote"; text: string; lines: number }
  | { type: "text"; text: string; lines: number; style: "body" | "subheadline" }
  | { type: "diffs"; label: string; show: number; total: number; maxLines: number; more?: string }
  | { type: "actions"; items: CardAction[] };

export type CardSource = {
  kind: string;
  title: string;
  subtitle?: string;
  lines?: string[];
  notion?: number;
  figure?: { url: string; caption?: string; width?: number; height?: number };
  formula?: string;
  formulaNote?: string;
  roles?: Partial<Record<RoleKey, string>>;
  visualCaption?: string;
  image?: string;
  inputSource?: { url?: string };
  place?: unknown;
  jobId?: string;
  insightId?: string;
};

type RoleKey = "problem" | "motivation" | "insight" | "solution" | "result" | "observation";

// Lucid's roles in argument order, ending on the takeaway. An observation
// joins its result rather than taking a line of its own.
const ROLES: { key: Exclude<RoleKey, "observation">; color: string; label: Record<UiLanguage, string> }[] = [
  { key: "problem", color: "#4F7CC4", label: { ko: "문제", en: "Problem" } },
  { key: "motivation", color: "#DE9818", label: { ko: "동기", en: "Motivation" } },
  { key: "solution", color: "#1A9684", label: { ko: "방법", en: "Method" } },
  { key: "result", color: "#68AA34", label: { ko: "결과", en: "Result" } },
  { key: "insight", color: "#E0457B", label: { ko: "통찰", en: "Takeaway" } },
];

// A role is read whole, wrapping as it needs. A number rather than "no limit"
// because installed phone builds pass it straight to a line limit, and no
// one sentence runs this long on a phone.
const ROLE_LINES = 12;
const TEXT_LINES = 12;

// A picture keeps its own shape and size: a frame forced wide whenever a card
// had edits shrank tall figures and screenshots to a strip no one could read.
const FIGURE_MIN_RATIO = 0.6;
const FIGURE_MAX_RATIO = 3.2;
const IMAGE_MIN_HEIGHT = 280;

const WORDS = {
  ko: {
    edits: (n: number) => `수정 제안 ${n}건`,
    more: (n: number) => `나머지 ${n}건은 열어서 보기`,
    open: "열기",
    source: "원문",
    archive: "보관",
    dismiss: "닫기",
  },
  en: {
    edits: (n: number) => `${n} ${n === 1 ? "edit" : "edits"}`,
    more: (n: number) => `Open to see the other ${n}`,
    open: "Open",
    source: "Original",
    archive: "Archive",
    dismiss: "Dismiss",
  },
};

// `imageHeight` is the screenshot's height in points; 0 leaves screenshots out.
export function feedCard(item: CardSource, lang: UiLanguage, imageHeight = IMAGE_MIN_HEIGHT): CardBlock[] | undefined {
  if (item.kind !== "job" && item.kind !== "insight") return undefined;
  const t = WORDS[lang];
  const lines = item.lines ?? [];
  const isPaper = item.subtitle === "Paper";
  const roles = ROLES.filter((r) => item.roles?.[r.key]);
  // A paper's role lines take the room of one edit on a phone screen.
  const show = item.place ? 1 : Math.min(item.notion ?? 0, roles.length ? 1 : 2);
  const blocks: CardBlock[] = [{ type: "header", title: item.title, lines: TEXT_LINES }];

  if (item.figure) {
    blocks.push({
      type: "figure",
      url: item.figure.url,
      width: item.figure.width,
      height: item.figure.height,
      caption: item.visualCaption ?? item.figure.caption,
      minRatio: FIGURE_MIN_RATIO,
      maxRatio: FIGURE_MAX_RATIO,
    });
  } else if (item.image) {
    const height = imageHeight > 0 ? Math.max(imageHeight, IMAGE_MIN_HEIGHT) : 0;
    if (height > 0) blocks.push({ type: "image", url: item.image, height });
  } else if (item.formula) {
    blocks.push({ type: "formula", tex: item.formula, caption: item.visualCaption, note: item.formulaNote });
  }

  if (isPaper && roles.length) {
    blocks.push({
      type: "roles",
      items: roles.map((r) => ({
        label: r.label[lang],
        color: r.color,
        text:
          r.key === "result" && item.roles?.observation
            ? `${item.roles.result} ${item.roles.observation}`
            : item.roles![r.key]!,
        lines: ROLE_LINES,
      })),
    });
  } else if (isPaper && show > 0 && lines.length > 1) {
    blocks.push({ type: "text", text: lines[1], lines: TEXT_LINES, style: "subheadline" });
  } else if (!isPaper && !item.insightId && show > 0) {
    for (const line of lines.slice(0, 3))
      blocks.push({ type: "text", text: line, lines: TEXT_LINES, style: "subheadline" });
  }
  if (item.insightId && lines.length > 1) blocks.push({ type: "quote", text: lines[1], lines: TEXT_LINES });

  if (show > 0) {
    const total = item.place ? 1 : (item.notion ?? 0);
    blocks.push({
      type: "diffs",
      label: t.edits(total),
      show,
      total,
      maxLines: 4,
      ...(total > show ? { more: t.more(total - show) } : {}),
    });
  } else {
    for (const line of lines.slice(0, isPaper ? 2 : 4))
      blocks.push({ type: "text", text: line, lines: TEXT_LINES, style: "subheadline" });
  }

  const actions: CardAction[] = [];
  if (item.jobId)
    actions.push(
      { kind: "open", label: t.open, icon: "arrow.up.right" },
      ...(item.inputSource?.url
        ? [{ kind: "source" as const, label: t.source, icon: "link", url: item.inputSource.url }]
        : []),
      { kind: "archive", label: t.archive, icon: "archivebox" },
    );
  if (item.insightId) actions.push({ kind: "dismiss", label: t.dismiss, icon: "xmark" });
  if (actions.length) blocks.push({ type: "actions", items: actions });
  return blocks;
}
