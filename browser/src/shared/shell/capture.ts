import type { Mode } from "../types";

export type CaptureKind = "newsletter" | "paper" | "article" | "insight";

export const CAPTURE_KINDS: { key: CaptureKind; label: string; placeholder: string; tab: Mode }[] = [
  { key: "article", label: "Article", placeholder: "Paste article URL or text...", tab: "article" },
  { key: "paper", label: "Paper", placeholder: "Paste arXiv URL, DOI, or paper title...", tab: "paper" },
  { key: "newsletter", label: "Newsletter", placeholder: "Paste newsletter URL or content...", tab: "newsletter" },
  {
    key: "insight",
    label: "Insight",
    placeholder: "Paste a quote / insight — a blank line separates multiple. Or paste a screenshot.",
    tab: "insights",
  },
];

const PAPER_HOST =
  /^https?:\/\/(www\.)?(arxiv\.org|doi\.org|openreview\.net|aclanthology\.org|proceedings\.mlr\.press|proceedings\.neurips\.cc)\//i;

export function guessKind(text: string, fallback: CaptureKind): CaptureKind {
  return PAPER_HOST.test(text.trim()) ? "paper" : fallback;
}

export function captureKindFor(mode: Mode): CaptureKind {
  if (mode === "newsletter" || mode === "paper" || mode === "article") return mode;
  if (mode === "insights") return "insight";
  return "article";
}
