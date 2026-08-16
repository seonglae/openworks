import {
  Activity,
  Apple,
  BookOpen,
  Calendar,
  GitBranch,
  GitPullRequest,
  Languages,
  Newspaper,
  Quote,
  ScrollText,
} from "lucide-react";
import type { Mode } from "./types";

// Kept out of App.tsx so that file exports only its component: a module that
// exports a non-component is not Fast Refreshable, and App.tsx holding these
// made every edit to the shell full-reload the page instead of hot-updating.
export const MODES: { key: Mode; label: string; icon: typeof Newspaper; placeholder: string }[] = [
  { key: "newsletter", label: "Newsletter", icon: Newspaper, placeholder: "Paste newsletter URL or content..." },
  { key: "paper", label: "Paper", icon: BookOpen, placeholder: "Paste arXiv URL, DOI, or paper title..." },
  { key: "article", label: "Article", icon: ScrollText, placeholder: "Paste article URL or text..." },
  { key: "pr", label: "PRs", icon: GitPullRequest, placeholder: "" },
  { key: "plan", label: "Plans", icon: Calendar, placeholder: "" },
  { key: "research", label: "Research", icon: GitBranch, placeholder: "" },
  { key: "diet", label: "Diet", icon: Apple, placeholder: "" },
  { key: "vocab", label: "Vocab", icon: Languages, placeholder: "" },
  { key: "insights", label: "Insights", icon: Quote, placeholder: "" },
  { key: "usage", label: "Usage", icon: Activity, placeholder: "" },
];

// Which tab the shell must fall back to when the enabled set no longer holds
// the current one, or null to stay put. A `?tab=` deep link may name a mode
// with no nav slot of its own (`authors` opens under the Paper subnav), and
// those must never be evicted: they are not in MODES, so the enabled set can
// never contain them. Derived from MODES rather than a hardcoded key list so a
// future subnav-only tab does not reintroduce the same eviction.
export function fallbackMode(mode: Mode, visible: readonly { key: Mode }[]): Mode | null {
  if (!MODES.some((m) => m.key === mode)) return null;
  if (visible.some((m) => m.key === mode)) return null;
  return visible.length > 0 ? visible[0].key : null;
}
