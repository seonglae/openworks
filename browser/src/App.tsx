import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id, Doc } from "../../convex/_generated/dataModel";
import { MailboxModal } from "./MailboxModal";
import { SettingsModal } from "./SettingsModal";
import { DrawingsView } from "./DrawingsView";
import { DietView } from "./views/DietView";
import { VocabView } from "./views/VocabView";
import { InsightsView } from "./views/InsightsView";
import { UsageView } from "./views/UsageView";
import { useUsageTracker } from "./shared/usage";
import { AuthorsView, PaperSubNav } from "./views/AuthorsView";
import { PRView } from "./views/PRView";
import { usePRData } from "./views/usePRData";
import { ResearchView } from "./views/ResearchView";
import { PlansView } from "./views/PlansView";
import {
  UniversalInput,
  NewsletterDistribution,
  DateDistribution,
  FeedsButton,
  ScoreDistribution,
  JobListSkeleton,
  ContentModal,
  JobRow,
} from "./views/JobsView";
import { MODE_KEYS, type Mode } from "./shared/types";
import { MODES, fallbackMode } from "./shared/modes";
import { useInfiniteScroll, useCachedQuery, useDropletRect } from "./shared/hooks";
import { isModifiedClick } from "./shared/ui";
import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/clerk-react";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const AUTH_ENABLED = Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
import { FileText, X, Archive, Search, Moon, Sun, Mail, Pencil, Settings as SettingsIcon, Menu } from "lucide-react";

// ── LaTeX Copy Context Menu ────────────────────────────────────────────

function useLatexContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; latex: string } | null>(null);

  const handleContextMenu = useCallback((e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const katexEl = target.closest(".katex");
    if (!katexEl) return;

    // Extract LaTeX from KaTeX's MathML annotation
    const annotation = katexEl.querySelector("annotation[encoding='application/x-tex']");
    if (!annotation?.textContent) return;

    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, latex: annotation.textContent });
  }, []);

  const handleClick = useCallback(() => setMenu(null), []);

  useEffect(() => {
    document.addEventListener("contextmenu", handleContextMenu);
    document.addEventListener("click", handleClick);
    return () => {
      document.removeEventListener("contextmenu", handleContextMenu);
      document.removeEventListener("click", handleClick);
    };
  }, [handleContextMenu, handleClick]);

  const copyLatex = useCallback(() => {
    if (menu) {
      navigator.clipboard.writeText(menu.latex);
      setMenu(null);
    }
  }, [menu]);

  // Intercept copy: replace rendered KaTeX glyphs with $latex-source$
  useEffect(() => {
    const handleCopy = (e: ClipboardEvent) => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);

      // Find katex elements in original DOM that intersect selection
      const katexEls = document.querySelectorAll(".katex");
      let hasKatex = false;
      katexEls.forEach((el) => {
        if (range.intersectsNode(el)) hasKatex = true;
      });
      if (!hasKatex) return;

      // Inject $source$ markers into the DOM temporarily, copy, then remove
      const markers: { katex: Element; marker: Text; ann: string; isBlock: boolean }[] = [];
      katexEls.forEach((el) => {
        if (!range.intersectsNode(el)) return;
        const ann = el.querySelector("annotation[encoding='application/x-tex']");
        if (!ann?.textContent) return;
        const isBlock = el.closest(".katex-display") !== null;
        const latex = isBlock ? `$$${ann.textContent}$$` : `$${ann.textContent}$`;
        // Hide katex-html, insert text marker
        const htmlEl = el.querySelector(".katex-html") as HTMLElement;
        if (!htmlEl) return;
        htmlEl.style.display = "none";
        const marker = document.createTextNode(latex);
        el.appendChild(marker);
        markers.push({ katex: el, marker, ann: ann.textContent, isBlock });
      });

      if (markers.length === 0) return;

      // Now selection.toString() will have $source$ instead of rendered glyphs
      const text = selection.toString();

      // Restore DOM
      markers.forEach(({ katex, marker }) => {
        const htmlEl = katex.querySelector(".katex-html") as HTMLElement;
        if (htmlEl) htmlEl.style.display = "";
        marker.remove();
      });

      e.preventDefault();
      e.clipboardData?.setData("text/plain", text);
    };

    document.addEventListener("copy", handleCopy);
    return () => document.removeEventListener("copy", handleCopy);
  }, []);

  return { menu, copyLatex };
}

function LatexContextMenu({ menu, onCopy }: { menu: { x: number; y: number; latex: string }; onCopy: () => void }) {
  return (
    <div className="fixed z-[100] glass rounded-xl py-1 min-w-[160px]" style={{ left: menu.x, top: menu.y }}>
      <button
        onClick={onCopy}
        className="w-full text-left px-3 py-1.5 mono text-xs hover:bg-paper-warm transition-colors flex items-center gap-2"
      >
        Copy LaTeX
      </button>
      <div className="px-3 py-1 mono text-[10px] text-ink-4 truncate max-w-[300px] border-t border-rule-light mt-1 pt-1 rounded-full">
        {menu.latex}
      </div>
    </div>
  );
}

// ── Masthead ───────────────────────────────────────────────────────────

function Masthead({
  onHome,
  showDraw,
  onToggleDraw,
  onOpenSettings,
  onToggleSidebar,
}: {
  onHome?: () => void;
  showDraw?: boolean;
  onToggleDraw?: () => void;
  onOpenSettings?: () => void;
  onToggleSidebar?: () => void;
}) {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  };
  useEffect(() => {
    const saved = localStorage.getItem("theme");
    if (saved === "dark") {
      setDark(true);
      document.documentElement.classList.add("dark");
    }
  }, []);
  return (
    <header className="pt-10 pb-6 anim flex items-start justify-between">
      <div className="flex items-start gap-2">
        {onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            className="p-2 -ml-2 mt-1 text-ink-3 hover:text-ink transition-colors sm:hidden"
            title="Menu"
          >
            <Menu size={20} />
          </button>
        )}
        <div>
          <h1
            className="serif text-[2.4rem] leading-tight tracking-tight text-ink cursor-pointer hover:text-rust transition-colors"
            onClick={onHome}
          >
            Openworks AI
          </h1>
          <p className="mono text-ink-3 mt-1">
            read &rarr; summarize &rarr; internalize &rarr; organize &rarr; express
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-2">
        {AUTH_ENABLED && (
          <>
            <SignedOut>
              <SignInButton mode="modal">
                <button className="mono text-[10px] tracking-wider text-ink-3 hover:text-ink px-2 py-0.5 rounded-full">
                  Sign in
                </button>
              </SignInButton>
            </SignedOut>
            <SignedIn>
              <UserButton appearance={{ elements: { avatarBox: "w-6 h-6" } }} />
            </SignedIn>
          </>
        )}
        {onToggleDraw && (
          <button
            onClick={onToggleDraw}
            className={`p-2 transition-colors ${showDraw ? "text-rust" : "text-ink-3 hover:text-ink"}`}
            title="Draw"
          >
            <Pencil size={16} />
          </button>
        )}
        {onOpenSettings && (
          <button onClick={onOpenSettings} className="p-2 text-ink-3 hover:text-ink transition-colors" title="Settings">
            <SettingsIcon size={16} />
          </button>
        )}
        <button onClick={toggle} className="p-2 text-ink-3 hover:text-ink transition-colors" title="Toggle dark mode">
          {dark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </div>
    </header>
  );
}

// ── Mode Nav ──────────────────────────────────────────────────────────

function SortableTab({
  m,
  isActive,
  href,
  onSelect,
}: {
  m: (typeof MODES)[number];
  isActive: boolean;
  href: string;
  onSelect: (k: Mode) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: m.key });
  const wasDragged = useRef(false);
  useEffect(() => {
    if (isDragging) wasDragged.current = true;
  }, [isDragging]);
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    cursor: isDragging ? "grabbing" : undefined,
  };
  const Icon = m.icon;
  return (
    <a
      ref={setNodeRef}
      style={{ ...style, touchAction: "pan-y" }}
      {...attributes}
      {...listeners}
      href={href}
      draggable={false}
      onClick={(e) => {
        if (wasDragged.current) {
          e.preventDefault();
          wasDragged.current = false;
          return;
        }
        if (isModifiedClick(e)) return;
        e.preventDefault();
        onSelect(m.key);
      }}
      data-tabkey={m.key}
      className={`relative z-10 flex w-full items-center gap-2.5 px-3 py-2 mono text-xs tracking-wider transition-colors cursor-pointer select-none outline-none rounded-xl whitespace-nowrap
        ${isActive ? "text-rust" : "text-ink-3 hover:text-ink"}
      `}
    >
      <Icon size={15} className="shrink-0" />
      {m.label}
    </a>
  );
}

// Search runs a fan-out over four search indexes, so firing it on every
// keystroke queues a query per character. Wait for a pause in typing instead.
function useDebounced<T>(value: T, ms = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

// Left sidebar navigation. On desktop it is an in-flow sticky column; on
// mobile it becomes an off-canvas drawer toggled by the masthead hamburger.
// Tabs are a vertical, reorderable list (dnd-kit). This replaces the old
// horizontal pill nav that overflowed on narrow screens.
function SideNav({
  active,
  onSelect,
  tabHref,
  modes,
  onReorder,
  open,
  onClose,
}: {
  active: Mode;
  onSelect: (m: Mode) => void;
  tabHref: (m: Mode) => string;
  modes: typeof MODES;
  onReorder?: (next: Mode[]) => void;
  open: boolean;
  onClose: () => void;
}) {
  // Mouse drags start on distance, never on a hold: a stationary press is
  // always a click, so no amount of dwelling on a tab can reorder the list.
  // Touch keeps a hold delay because a finger cannot hover to signal intent.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 400, tolerance: 8 } }),
  );
  const navRef = useRef<HTMLElement | null>(null);
  const droplet = useDropletRect(navRef, active ?? null, [modes, open]);
  const handleDragEnd = (e: DragEndEvent) => {
    if (!onReorder || !e.over || e.active.id === e.over.id) return;
    const oldIndex = modes.findIndex((m) => m.key === e.active.id);
    const newIndex = modes.findIndex((m) => m.key === e.over!.id);
    if (oldIndex < 0 || newIndex < 0) return;
    onReorder(arrayMove(modes, oldIndex, newIndex).map((m) => m.key));
  };
  const pick = (m: Mode) => {
    onSelect(m);
    onClose();
  };
  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-ink/40 sm:hidden" onClick={onClose} aria-hidden />}
      <aside
        className={`glass-bar fixed inset-y-0 left-0 z-50 flex w-64 flex-col overflow-y-auto border-r border-rule px-3 py-5 transition-transform duration-200
          ${open ? "translate-x-0" : "-translate-x-full"}
          sm:sticky sm:top-0 sm:z-30 sm:h-screen sm:w-56 sm:translate-x-0 sm:transform-none`}
      >
        <div className="mb-5 flex items-center justify-between px-2">
          <span className="serif text-2xl tracking-tight text-ink">Openworks</span>
          <button onClick={onClose} className="p-1 text-ink-3 hover:text-ink sm:hidden" title="Close">
            <X size={16} />
          </button>
        </div>
        <nav ref={navRef} className="relative flex flex-1 flex-col gap-1">
          {droplet && (
            <span
              aria-hidden
              className="droplet droplet-v pointer-events-none absolute left-0 right-0 rounded-xl z-0"
              style={{ top: droplet.top, height: droplet.height }}
            />
          )}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={modes.map((m) => m.key)} strategy={verticalListSortingStrategy}>
              {modes.map((m) => (
                <SortableTab key={m.key} m={m} isActive={active === m.key} href={tabHref(m.key)} onSelect={pick} />
              ))}
            </SortableContext>
          </DndContext>
        </nav>
      </aside>
    </>
  );
}

// ── Main App ───────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

// The full URL-persisted view state. Every list filter lives here so a refresh
// (or a link shared mid-investigation) restores the exact same view.
type ViewState = {
  mode: Mode;
  showDraw: boolean;
  drawingId: Id<"drawings"> | null;
  q: string;
  searchContent: boolean;
  archived: boolean;
  date: string | null;
  source: string | null;
  basis: "created" | "published";
  item: string | null;
  research: string | null;
  expr: string | null;
  pr: string | null;
};

function readURL(): ViewState {
  const p = new URLSearchParams(window.location.search);
  const tab = p.get("tab");
  // A focus param names its own tab, so a link can carry just the target.
  // `?research=<slug>` predates the others and has been printed as the share
  // URL all along while nothing read it, which is why it needs no `tab=`.
  const research = p.get("research");
  const expr = p.get("expr");
  const pr = p.get("pr");
  const focusTab = research ? "research" : expr ? "vocab" : pr ? "pr" : null;
  const mode: Mode = (tab && (MODE_KEYS as readonly string[]).includes(tab) ? tab : (focusTab ?? "newsletter")) as Mode;
  // Drawing param: prefer the short `d` form; fall back to legacy `drawing`
  // for old shared links.
  const drawingId = (p.get("d") || p.get("drawing") || null) as Id<"drawings"> | null;
  const showDraw = tab === "draw" || drawingId !== null;
  return {
    mode,
    showDraw,
    drawingId,
    q: p.get("q") ?? "",
    searchContent: p.get("sc") === "1",
    archived: p.get("arch") === "1",
    date: p.get("date"),
    source: p.get("source"),
    basis: p.get("basis") === "published" ? "published" : "created",
    item: p.get("item"),
    research,
    expr,
    pr,
  };
}

function buildURL(state: ViewState) {
  const url = new URL(window.location.href);
  // Always purge legacy long param so old links don't survive.
  url.searchParams.delete("drawing");
  if (state.drawingId) {
    // d=<id> implies draw mode — no separate tab=draw needed.
    url.searchParams.set("d", state.drawingId);
    url.searchParams.delete("tab");
  } else {
    url.searchParams.delete("d");
    if (state.showDraw) {
      url.searchParams.set("tab", "draw");
    } else if (state.mode !== "newsletter") {
      url.searchParams.set("tab", state.mode);
    } else {
      url.searchParams.delete("tab");
    }
  }
  const setOrDel = (key: string, val: string | null | undefined, keep: boolean) => {
    if (keep && val) url.searchParams.set(key, val);
    else url.searchParams.delete(key);
  };
  setOrDel("q", state.q, state.q.trim().length > 0);
  setOrDel("sc", "1", state.searchContent);
  setOrDel("arch", "1", state.archived);
  setOrDel("date", state.date, Boolean(state.date));
  setOrDel("source", state.source, Boolean(state.source));
  setOrDel("basis", state.basis, state.basis === "published" && state.mode === "paper");
  setOrDel("item", state.item, Boolean(state.item));
  setOrDel("research", state.research, Boolean(state.research));
  setOrDel("expr", state.expr, Boolean(state.expr));
  setOrDel("pr", state.pr, Boolean(state.pr));
  return url.toString();
}

export default function App() {
  const initial = readURL();
  const [mode, setModeState] = useState<Mode>(initial.mode);
  // Job queries take the active tab key; tabs that are not job types simply
  // match no rows server-side.
  const jobType = mode as NonNullable<Doc<"jobs">["type"]>;
  const [showDraw, setShowDrawState] = useState(initial.showDraw);
  const [activeDrawingId, setActiveDrawingIdState] = useState<Id<"drawings"> | null>(initial.drawingId);
  const [search, setSearch] = useState(initial.q);
  const [searchContent, setSearchContent] = useState(initial.searchContent);
  const [showArchived, setShowArchived] = useState(initial.archived);
  // Clicked distribution bar / legend → filter the list. Paper toggle chooses
  // which date the bars (and filter) are keyed on. All persisted in the URL.
  const [dateFilter, setDateFilter] = useState<string | null>(initial.date);
  const [sourceFilter, setSourceFilter] = useState<string | null>(initial.source);
  const [paperDateBasis, setPaperDateBasis] = useState<"created" | "published">(initial.basis);
  // Deep-link: ?item=<jobId> opens that job with its inline detail expanded,
  // even when it isn't on the current page.
  const [openItem, setOpenItem] = useState<string | null>(initial.item);
  // The same idea for the tabs whose rows are not jobs, so the digest can land
  // on a project, a card or a pull request instead of just its tab.
  const [focusResearch, setFocusResearch] = useState<string | null>(initial.research);
  const [focusExpr, setFocusExpr] = useState<string | null>(initial.expr);
  const [focusPR, setFocusPR] = useState<string | null>(initial.pr);
  const dateBasis = mode === "newsletter" ? "issue" : mode === "paper" ? paperDateBasis : "created";

  // Records which view is open and how long it is actually looked at. Mounted
  // here because the shell is the one place that always knows the current
  // view; the drawing surface is its own destination rather than a tab, so it
  // is reported as one.
  useUsageTracker(showDraw ? "draw" : mode);

  // The complete current view as a ViewState, with optional overrides. Both the
  // history writers below build their URL from this so no filter is ever dropped.
  const viewState = (o: Partial<ViewState> = {}): ViewState => ({
    mode,
    showDraw,
    drawingId: activeDrawingId,
    q: search,
    searchContent,
    archived: showArchived,
    date: dateFilter,
    source: sourceFilter,
    basis: paperDateBasis,
    item: openItem,
    research: focusResearch,
    expr: focusExpr,
    pr: focusPR,
    ...o,
  });

  const nav = (
    patch: { mode?: Mode; showDraw?: boolean; drawingId?: Id<"drawings"> | null },
    opts?: { replace?: boolean },
  ) => {
    const modeChanged = patch.mode !== undefined && patch.mode !== mode;
    const next = viewState({
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
      ...(patch.showDraw !== undefined ? { showDraw: patch.showDraw } : {}),
      ...(patch.drawingId !== undefined ? { drawingId: patch.drawingId } : {}),
      // Switching tabs starts that tab's list fully unfiltered: every filter
      // searchparam (search text, content toggle, date, source, open item) is
      // dropped so the URL only carries the new tab.
      ...(modeChanged
        ? { q: "", searchContent: false, date: null, source: null, item: null, research: null, expr: null, pr: null }
        : {}),
    });
    if (patch.mode !== undefined) setModeState(next.mode);
    if (patch.showDraw !== undefined) setShowDrawState(next.showDraw);
    if (patch.drawingId !== undefined) setActiveDrawingIdState(next.drawingId);
    if (modeChanged) {
      setSearch("");
      setSearchContent(false);
      setDateFilter(null);
      setSourceFilter(null);
      setOpenItem(null);
      setFocusResearch(null);
      setFocusExpr(null);
      setFocusPR(null);
    }
    const url = buildURL(next);
    // Never stack an entry identical to the current URL (re-clicking the
    // active tab, keystroke page resets). Duplicate entries make the browser
    // back button appear dead.
    if (url === window.location.href) return;
    // Programmatic corrections (data-driven page clamp, disabled-tab fallback)
    // must replace: a pushState without user activation trips Chrome's history
    // manipulation intervention, which flags every same-document entry as
    // skippable and silently disables back / ctrl+back for the whole app.
    if (opts?.replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
  };

  const setMode = (m: Mode) => nav({ mode: m, showDraw: false, drawingId: null });
  // Anchor hrefs mirroring what nav() would push, so nav controls can be real
  // links whose modifier clicks open the same view in a new tab.
  const modeHref = (m: Mode) =>
    buildURL(
      viewState({
        mode: m,
        showDraw: false,
        drawingId: null,
        q: "",
        searchContent: false,
        date: null,
        source: null,
        item: null,
        research: null,
        expr: null,
        pr: null,
      }),
    );
  const setActiveDrawingId = (id: Id<"drawings"> | null) => nav({ drawingId: id, showDraw: id !== null || showDraw });

  // Filter changes (search text, archived toggle, date/source/basis) update the
  // URL in place via replaceState — they persist across a refresh but don't spam
  // the back-button history the way tab/page navigation (pushState) does. Skip
  // the first run so the URL the user loaded with is left untouched.
  const firstSync = useRef(true);
  useEffect(() => {
    if (firstSync.current) {
      firstSync.current = false;
      return;
    }
    window.history.replaceState(null, "", buildURL(viewState()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    search,
    searchContent,
    showArchived,
    dateFilter,
    sourceFilter,
    paperDateBasis,
    openItem,
    focusResearch,
    focusExpr,
    focusPR,
  ]);

  useEffect(() => {
    const onPop = () => {
      const s = readURL();
      setModeState(s.mode);
      setShowDrawState(s.showDraw);
      setActiveDrawingIdState(s.drawingId);
      setSearch(s.q);
      setSearchContent(s.searchContent);
      setShowArchived(s.archived);
      setDateFilter(s.date);
      setSourceFilter(s.source);
      setPaperDateBasis(s.basis);
      setOpenItem(s.item);
      setFocusResearch(s.research);
      setFocusExpr(s.expr);
      setFocusPR(s.pr);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const createJob = useMutation(api.jobs.create);
  const generateUploadUrl = useMutation(api.jobs.generateUploadUrl);
  const deleteJob = useMutation(api.jobs.remove);
  const archiveJob = useMutation(api.jobs.archive);
  const unarchiveJob = useMutation(api.jobs.unarchive);
  const retryJob = useMutation(api.jobs.retry);
  // Deep-linked job (?item=). Fetched directly so it opens expanded even when
  // it is not on the current page / in the current filter.
  const openJob = useQuery(api.jobs.getById, openItem ? { jobId: openItem } : "skip");
  // Switch to the item's own tab so the surrounding list matches it.
  useEffect(() => {
    if (!openJob) return;
    const t = openJob.type === "pr-fix" ? "pr" : (openJob.type ?? "newsletter");
    if (t !== mode) setModeState(t as Mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openJob?._id]);
  const [contentModal, setContentModal] = useState<Id<"jobs"> | null>(null);
  // The article whose inline detail is currently open. Pressing "e" (when not
  // typing and no detail input is focused) archives it, like Gmail / Superhuman.
  const [activeJobId, setActiveJobId] = useState<Id<"jobs"> | null>(null);
  // Switching into the archived view drops the active row, so a later "e" can't
  // archive a now-hidden job.
  useEffect(() => {
    if (showArchived) setActiveJobId(null);
  }, [showArchived]);
  useEffect(() => {
    if (!activeJobId || showArchived) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "e" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      const typing =
        el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (typing) return;
      e.preventDefault();
      const id = activeJobId;
      setActiveJobId(null);
      setOpenItem((prev) => (prev === id ? null : prev));
      void archiveJob({ jobId: id });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [activeJobId, showArchived, archiveJob]);
  const [showMailbox, setShowMailbox] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Optimistic tab order applied synchronously on drag end. Without it the new
  // order only lands after the Convex round-trip, so dnd-kit renders one frame
  // in the old order (the tab snaps back) then reflows when the server reply
  // arrives (it looks like it re-drags itself). Cleared once the server order
  // matches.
  const [orderOverride, setOrderOverride] = useState<Mode[] | null>(null);

  // Cached across loads: without it the first paint of every page load falls
  // back to the built-in MODES order, so the sidebar visibly reshuffles into
  // the user's saved order once the query resolves.
  const appSettingsRaw = useQuery(api.settings.get, {});
  const appSettings = useCachedQuery("cache:settings:get", appSettingsRaw);
  const setTabsMutation = useMutation(api.settings.setTabs);
  const visibleModes = useMemo(() => {
    if (!appSettings) return MODES;
    const byKey = new Map(MODES.map((m) => [m.key, m] as const));
    const enabled = appSettings.tabs
      .filter((t) => t.enabled)
      .map((t) => byKey.get(t.key as Mode))
      .filter((m): m is (typeof MODES)[number] => Boolean(m));
    // Append modes that ship after the user's saved tab list was written, so
    // new tabs (e.g. Diet) appear automatically without a settings migration.
    const known = new Set(appSettings.tabs.map((t) => t.key));
    const fresh = MODES.filter((m) => !known.has(m.key));
    // If user disabled every tab, fall back to the full list so they can
    // still re-enable from Settings — empty nav would leave them stranded.
    return enabled.length > 0 ? [...enabled, ...fresh] : MODES;
  }, [appSettings]);

  // Render order: optimistic override while a reorder is in flight, otherwise
  // the server order. Maps override keys through the current enabled set so a
  // tab toggled off elsewhere can't reappear.
  const displayModes = useMemo(() => {
    if (!orderOverride) return visibleModes;
    const byKey = new Map(visibleModes.map((m) => [m.key, m] as const));
    const inOverride = new Set(orderOverride);
    const ordered = orderOverride.map((k) => byKey.get(k)).filter((m): m is (typeof MODES)[number] => Boolean(m));
    const extra = visibleModes.filter((m) => !inOverride.has(m.key));
    return ordered.length > 0 ? [...ordered, ...extra] : visibleModes;
  }, [orderOverride, visibleModes]);

  useEffect(() => {
    if (!orderOverride) return;
    if (visibleModes.map((m) => m.key).join(",") === orderOverride.join(",")) {
      setOrderOverride(null);
    }
  }, [visibleModes, orderOverride]);

  useEffect(() => {
    if (!appSettings) return;
    if (showDraw) return;
    const fallback = fallbackMode(mode, visibleModes);
    if (fallback) nav({ mode: fallback, showDraw: false, drawingId: null }, { replace: true });
    // We intentionally exclude `mode` from deps: this only fires when the
    // enabled-set changes, not on every navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appSettings, showDraw, visibleModes]);
  const { menu: latexMenu, copyLatex } = useLatexContextMenu();
  const searchRef = useRef<HTMLInputElement>(null);
  const prData = usePRData();

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, []);

  // Cursor pagination rather than skip/limit: the offset query re-read every
  // row before the requested window, so deep pages cost more and more.
  const {
    results: allJobs,
    status: jobsStatus,
    loadMore: loadMoreJobs,
  } = usePaginatedQuery(api.jobs.list, { type: jobType, archived: showArchived }, { initialNumItems: PAGE_SIZE });
  const jobsSentinelRef = useInfiniteScroll(jobsStatus, loadMoreJobs, PAGE_SIZE);
  // Convex delivers a consistent snapshot, so every query subscribed in the same
  // render lands in one transition — a slow distribution query would hold the row
  // list behind it. Subscribing the charts only once the list has arrived puts
  // them in a later transition, so the rows always paint first. Derived rather
  // than stateful so switching tabs (which resets jobsStatus to LoadingFirstPage)
  // re-arms it on its own.
  const chartsReady = jobsStatus !== "LoadingFirstPage";
  const totalCount = useQuery(api.jobs.count, { type: mode, archived: showArchived });
  const debouncedSearch = useDebounced(search.trim());
  const searchResults = useQuery(
    api.jobs.searchWithContent,
    debouncedSearch
      ? { type: mode, archived: showArchived, query: debouncedSearch, includeContent: searchContent }
      : "skip",
  );
  // When a distribution bar is selected, show just that date's jobs (whole
  // bucket, unpaginated) in place of the paged list. Search takes precedence.
  const isSearching = search.trim().length > 0;
  const isDateFiltered = (Boolean(dateFilter) || Boolean(sourceFilter)) && !isSearching;
  const dateJobs = useQuery(
    api.jobs.listByDate,
    isDateFiltered
      ? {
          type: jobType,
          archived: showArchived,
          basis: dateBasis,
          ...(dateFilter ? { dateKey: dateFilter } : {}),
          ...(sourceFilter ? { source: sourceFilter } : {}),
        }
      : "skip",
  );
  const effectiveCount = isSearching ? (searchResults?.length ?? 0) : (totalCount ?? 0);
  // A date / source filter is keyed to the current basis + archived view, so a
  // user-initiated change to either clears them (the URL would otherwise restore
  // a stale key). Mode changes clear inside nav(). These run on the explicit
  // toggle handlers, NOT as a mount effect, so a refreshed URL keeps its filters.
  const changeBasis = (b: "created" | "published") => {
    setPaperDateBasis(b);
    setDateFilter(null);
  };
  const toggleArchived = (v: boolean) => {
    setShowArchived(v);
    setDateFilter(null);
    setSourceFilter(null);
  };
  // Date and source are one filter, not two: picking a date drops the source
  // and vice versa. Stacking them narrowed to an intersection nobody asked for
  // and left the chart showing two active selections at once.
  const selectDate = (key: string | null) => {
    setDateFilter(key);
    if (key != null) setSourceFilter(null);
  };
  const selectSource = (src: string | null) => {
    setSourceFilter(src);
    if (src != null) setDateFilter(null);
  };

  // Search and date-filter results are already bounded server-side, so they
  // render whole; only the unfiltered feed streams.
  const jobs = isDateFiltered ? (dateJobs ?? []) : isSearching ? (searchResults ?? []) : allJobs;
  // A deep-linked job that isn't on the current page is prepended to the list as
  // a normal row (expanded) — no separate panel. When it is already in the list,
  // it just expands in place.
  const itemInList = openItem != null && jobs.some((j) => j._id === openItem);
  // A deep-linked item belongs only when no filter is narrowing the list. The
  // moment a date / source / search filter is active and the open item isn't in
  // those results, it no longer belongs to what's being viewed — drop it (and
  // flush ?item=) instead of pinning a stale row on top. Gated on the filtered
  // query having resolved so the item isn't cleared mid-load.
  const filterActive = isDateFiltered || isSearching;
  const filterResolved = isDateFiltered ? dateJobs !== undefined : isSearching ? searchResults !== undefined : true;
  useEffect(() => {
    if (filterActive && filterResolved && openItem != null && openJob !== undefined && !itemInList) {
      setOpenItem(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterActive, filterResolved, openItem, openJob, itemInList]);
  const displayJobs = openItem && openJob && !itemInList && !filterActive ? [openJob, ...jobs] : jobs;
  // Archiving / deleting the open item (or collapsing its fold) flushes ?item=.
  const flushIfOpen = (id: Id<"jobs">) => setOpenItem((prev) => (prev === id ? null : prev));

  const handleSubmit = async (input: string, images?: File[]) => {
    // Upload every attached image, in order, to one job.
    const imageIds: Id<"_storage">[] = [];
    for (const image of images ?? []) {
      const postUrl = await generateUploadUrl({});
      const res = await fetch(postUrl, {
        method: "POST",
        headers: { "Content-Type": image.type },
        body: image,
      });
      const json = (await res.json()) as { storageId: Id<"_storage"> };
      imageIds.push(json.storageId);
    }
    // Batch URL paste — split on whitespace/comma. When every non-empty token
    // is an http(s) URL (and there are ≥2 of them), create one job per URL.
    // Image upload still goes as a single job — multi-URL + image isn't useful.
    const tokens = input.split(/[\s,]+/).filter(Boolean);
    if (imageIds.length === 0 && tokens.length > 1 && tokens.every((t) => /^https?:\/\//i.test(t))) {
      for (const url of tokens) {
        await createJob({ url, type: jobType });
      }
      return;
    }
    const isUrl = /^https?:\/\//i.test(input);
    await createJob({
      ...(isUrl ? { url: input } : { url: "", ...(input ? { content: input } : {}) }),
      type: jobType,
      ...(imageIds.length > 0 ? { imageIds } : {}),
    });
  };

  const currentMode = MODES.find((m) => m.key === mode)!;
  const emptyMessage = {
    newsletter: {
      title: "Paste a newsletter URL or content to get started",
      sub: "AlphaSignal, TLDR, or any newsletter",
    },
    paper: { title: "Paste an arXiv link, DOI, or paper title", sub: "summarized by claude -p, no API key needed" },
    article: { title: "Paste an article URL or text", sub: "summarized by claude -p, no API key needed" },
    pr: { title: "", sub: "" },
  };

  return (
    <div className="sm:flex">
      {latexMenu && <LatexContextMenu menu={latexMenu} onCopy={copyLatex} />}
      {contentModal && <ContentModal jobId={contentModal} onClose={() => setContentModal(null)} />}
      {showMailbox && <MailboxModal onClose={() => setShowMailbox(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      <SideNav
        active={showDraw ? (null as unknown as Mode) : mode === "authors" ? "paper" : mode}
        onSelect={(m) => nav({ mode: m, showDraw: false, drawingId: null })}
        tabHref={modeHref}
        modes={displayModes}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onReorder={(nextEnabled) => {
          if (!appSettings) return;
          // Apply the new order synchronously so dnd-kit settles in place; the
          // Convex write persists it and the override clears once it round-trips.
          setOrderOverride(nextEnabled);
          // Splice the new visible order back into the full tabs list,
          // keeping disabled tabs at their existing positions relative to
          // the remaining enabled-position slots.
          const remaining = appSettings.tabs.filter((t) => !nextEnabled.includes(t.key as Mode));
          const next = [...nextEnabled.map((key) => ({ key, enabled: true })), ...remaining];
          void setTabsMutation({ tabs: next });
        }}
      />
      <div className="min-w-0 flex-1">
        <div className="max-w-4xl mx-auto px-6 pb-16">
          <Masthead
            onHome={() => setMode(visibleModes[0]?.key ?? "newsletter")}
            showDraw={showDraw}
            onToggleDraw={() => {
              if (showDraw) {
                nav({ showDraw: false, drawingId: null });
              } else {
                nav({ showDraw: true });
              }
            }}
            onOpenSettings={() => setShowSettings(true)}
            onToggleSidebar={() => setSidebarOpen((v) => !v)}
          />
          {showDraw ? (
            <DrawingsView
              activeId={activeDrawingId}
              onActiveIdChange={setActiveDrawingId}
              backHref={buildURL(viewState({ drawingId: null, showDraw: true }))}
            />
          ) : mode === "research" ? (
            <ResearchView focusSlug={focusResearch} />
          ) : mode === "plan" ? (
            <PlansView />
          ) : mode === "diet" ? (
            <DietView />
          ) : mode === "vocab" ? (
            <VocabView focusId={focusExpr} />
          ) : mode === "insights" ? (
            <InsightsView />
          ) : mode === "usage" ? (
            <UsageView />
          ) : mode === "authors" ? (
            <AuthorsView subNav={<PaperSubNav active="authors" hrefFor={modeHref} />} />
          ) : mode === "pr" ? (
            <div className="panel anim d2">
              <PRView prData={prData} focus={focusPR} />
            </div>
          ) : (
            <>
              {mode === "paper" && <PaperSubNav active="paper" hrefFor={modeHref} />}
              <UniversalInput
                placeholder={currentMode.placeholder}
                onSubmit={handleSubmit}
                loading={jobsStatus === "LoadingFirstPage"}
                allowImage={mode === "paper" || mode === "article" || mode === "newsletter"}
              />

              {mode === "article" && <FeedsButton />}
              {chartsReady && (mode === "paper" || mode === "article") && (
                <ScoreDistribution kind={mode} archived={showArchived} />
              )}
              {chartsReady && (mode === "paper" || mode === "article") && (
                <DateDistribution
                  kind={mode}
                  basis={paperDateBasis}
                  onBasisChange={changeBasis}
                  selected={dateFilter}
                  onSelect={setDateFilter}
                  archived={showArchived}
                />
              )}
              {chartsReady && mode === "newsletter" && (
                <NewsletterDistribution
                  selected={dateFilter}
                  onSelect={selectDate}
                  selectedSource={sourceFilter}
                  onSelectSource={selectSource}
                  archived={showArchived}
                />
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-1 flex-1 min-w-[140px] mr-3">
                  <Search size={10} className="text-ink-4 shrink-0" />
                  <input
                    ref={searchRef}
                    type="text"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                    }}
                    placeholder="Filter... (/)"
                    className="bg-transparent outline-none mono text-[10px] text-ink-2 placeholder:text-ink-4 w-full border-b border-transparent focus:border-rule-light transition-colors"
                  />
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1">
                  <button
                    onClick={() => {
                      setSearchContent((v) => !v);
                    }}
                    className={`mono text-[10px] tracking-wider px-2 py-0.5 transition-colors ${searchContent ? "droplet text-rust" : "text-ink-4 hover:text-ink-3"} rounded-full`}
                    title={
                      searchContent
                        ? "Filter scope: title + summary + chat + full content"
                        : "Filter scope: title + summary + chat (click to also search content)"
                    }
                  >
                    <FileText size={10} className="inline mr-1" />
                    {searchContent ? "Detail on" : "Detail"}
                  </button>
                  {mode === "newsletter" && (
                    <button
                      onClick={() => setShowMailbox(true)}
                      className="mono text-[10px] tracking-wider px-2 py-0.5 text-ink-4 hover:text-ink-3 transition-colors rounded-full"
                      title="Open inbox of unread newsletters"
                    >
                      <Mail size={10} className="inline mr-1" />
                      Mailbox
                    </button>
                  )}
                  <button
                    onClick={() => {
                      toggleArchived(!showArchived);
                    }}
                    className={`mono text-[10px] tracking-wider px-2 py-0.5 transition-colors ${showArchived ? "droplet text-rust" : "text-ink-4 hover:text-ink-3"} rounded-full`}
                  >
                    <Archive size={10} className="inline mr-1" />
                    {showArchived ? "Viewing archived" : "Archived"}
                  </button>
                </div>
              </div>

              {displayJobs.length > 0 ? (
                <div className="panel anim d3">
                  <div className="[&>.ruled:last-child]:border-b-0">
                    {displayJobs.map((job) => (
                      <JobRow
                        key={job._id}
                        job={job}
                        defaultExpanded={job._id === openItem}
                        onContentClick={setContentModal}
                        onRetry={(id) => retryJob({ jobId: id })}
                        onArchive={
                          job.archived
                            ? undefined
                            : (id) => {
                                flushIfOpen(id);
                                archiveJob({ jobId: id });
                              }
                        }
                        onUnarchive={job.archived ? (id) => unarchiveJob({ jobId: id }) : undefined}
                        onDelete={(id) => {
                          flushIfOpen(id);
                          deleteJob({ jobId: id });
                        }}
                        onActiveChange={(open) => {
                          setActiveJobId((prev) => (open ? job._id : prev === job._id ? null : prev));
                          // Reflect the open row in the URL so it is shareable; clear
                          // when this row collapses (fold closed flushes ?item=).
                          setOpenItem((prev) => (open ? job._id : prev === job._id ? null : prev));
                        }}
                      />
                    ))}
                  </div>
                  {!isDateFiltered && !isSearching && (
                    <div ref={jobsSentinelRef} className="py-6 text-center mono text-[10px] tracking-wider text-ink-4">
                      {jobsStatus === "LoadingMore"
                        ? "loading…"
                        : jobsStatus === "Exhausted"
                          ? `${jobs.length} of ${effectiveCount}`
                          : ""}
                    </div>
                  )}
                </div>
              ) : jobsStatus === "LoadingFirstPage" || (search.trim() && searchResults === undefined) ? (
                <JobListSkeleton count={4} />
              ) : search.trim() ? (
                <div className="text-center py-16 anim d3">
                  <p className="serif text-xl text-ink-3">No matches for "{search.trim()}"</p>
                  <p className="mono text-xs text-ink-4 mt-2">
                    searched title, summaries, chat{searchContent ? ", and full content" : ""}
                  </p>
                </div>
              ) : openItem ? null : (
                <div className="text-center py-16 anim d3">
                  <p className="serif text-xl text-ink-3">{emptyMessage[mode].title}</p>
                  <p className="mono text-xs text-ink-4 mt-2">{emptyMessage[mode].sub}</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
