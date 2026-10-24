import { useQuery } from "convex/react";
import { Search, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";
import { Md } from "../../components/markdown";
import type { MODES } from "../modes";
import type { Mode } from "../types";
import { isModifiedClick } from "../ui";
import { useDialog } from "./useDialog";

type Entry = {
  key: string;
  group: "Go to" | "Actions" | "Items";
  label: string;
  hint?: string;
  href?: string;
  item?: Doc<"jobs">;
  run: () => void;
};

export function CommandPalette({
  modes,
  onClose,
  onMode,
  onCapture,
  onSettings,
  onDraw,
  onOpen,
  hrefFor,
}: {
  modes: typeof MODES;
  onClose: () => void;
  onMode: (mode: Mode) => void;
  onCapture: () => void;
  onSettings: () => void;
  onDraw: () => void;
  onOpen: (id: Id<"jobs">, mode: Mode) => void;
  hrefFor: (mode: Mode) => string;
}) {
  const dialogRef = useDialog(onClose);
  const id = useId();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(timer);
  }, [q]);
  const args = (type: Mode) =>
    debounced.length >= 2 && modes.some((m) => m.key === type)
      ? { type, query: debounced, limit: 8 }
      : ("skip" as const);
  const papers = useQuery(api.jobs.searchWithContent, args("paper"));
  const articles = useQuery(api.jobs.searchWithContent, args("article"));
  const newsletters = useQuery(api.jobs.searchWithContent, args("newsletter"));
  const needle = q.trim().toLowerCase();
  const commands: Entry[] = [
    ...modes.map((m) => ({
      key: m.key,
      group: "Go to" as const,
      label: m.label,
      href: hrefFor(m.key),
      run: () => onMode(m.key),
    })),
    ...(modes.some((m) => m.key === "paper")
      ? [
          {
            key: "authors",
            group: "Go to" as const,
            label: "Authors",
            href: hrefFor("authors"),
            run: () => onMode("authors"),
          },
        ]
      : []),
    { key: "draw", group: "Go to", label: "Draw", run: onDraw },
    { key: "capture", group: "Actions", label: "Add", hint: "c", run: onCapture },
    { key: "settings", group: "Actions", label: "Settings", run: onSettings },
  ];
  const items: Entry[] =
    debounced === q.trim() && debounced.length >= 2
      ? [...(papers ?? []), ...(articles ?? []), ...(newsletters ?? [])].map((item) => {
          const mode = item.type as Mode;
          const url = new URL(hrefFor(mode));
          url.searchParams.set("item", item._id);
          return {
            key: item._id,
            group: "Items",
            label: item.title || item.url || "Untitled",
            hint: modes.find((m) => m.key === mode)?.label,
            href: url.href,
            item,
            run: () => onOpen(item._id, mode),
          };
        })
      : [];
  const entries = [...commands.filter((entry) => !needle || entry.label.toLowerCase().includes(needle)), ...items];
  const at = Math.min(index, Math.max(entries.length - 1, 0));
  const current = entries[at];
  const pending =
    debounced !== q.trim() ||
    (debounced.length >= 2 &&
      [
        ["paper", papers],
        ["article", articles],
        ["newsletter", newsletters],
      ].some(([mode, result]) => modes.some((m) => m.key === mode) && result === undefined));
  const run = (entry: Entry) => {
    onClose();
    entry.run();
  };
  useEffect(() => {
    dialogRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [at, dialogRef]);

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-ink/30 px-4 pt-[10dvh]" onClick={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="glass-strong flex max-h-[75dvh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-rule-light px-4 py-3">
          <Search size={16} className="text-ink-3" />
          <input
            role="combobox"
            aria-label="Search sections, actions, and items"
            aria-controls={`${id}-results`}
            aria-expanded="true"
            aria-activedescendant={current ? `${id}-${at}` : undefined}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "ArrowDown") setIndex(Math.min(at + 1, Math.max(entries.length - 1, 0)));
              else if (e.key === "ArrowUp") setIndex(Math.max(at - 1, 0));
              else if (e.key === "Enter" && current) run(current);
              else return;
              e.preventDefault();
            }}
            placeholder="Go to a section, run an action, or find a title"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-4"
          />
          <button onClick={onClose} title="Close (Esc)" className="p-1 text-ink-3 hover:text-ink">
            <X size={16} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <ul
            id={`${id}-results`}
            role="listbox"
            aria-label="Results"
            aria-busy={pending}
            className="min-w-0 flex-1 overflow-y-auto p-2"
          >
            {entries.length === 0 && (
              <li className="px-3 py-6 text-center text-[13px] text-ink-3">{pending ? "Searching…" : "No matches"}</li>
            )}
            {entries.map((entry, i) => (
              <li key={entry.key} role="presentation">
                {(i === 0 || entries[i - 1].group !== entry.group) && (
                  <p className="mono px-2 pb-1 pt-2 text-[11px] tracking-wider text-ink-3">{entry.group}</p>
                )}
                <a
                  id={`${id}-${i}`}
                  href={entry.href ?? "#"}
                  role="option"
                  aria-selected={i === at}
                  onMouseEnter={() => setIndex(i)}
                  onClick={(e) => {
                    if (entry.href && isModifiedClick(e)) return;
                    e.preventDefault();
                    run(entry);
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left ${i === at ? "bg-rust-dim" : "hover:bg-paper-warm"}`}
                >
                  <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{entry.label}</span>
                  {entry.hint && <span className="mono shrink-0 text-[11px] text-ink-3">{entry.hint}</span>}
                </a>
              </li>
            ))}
          </ul>
          {current?.item && (
            <aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-rule-light p-4 sm:block">
              <p className="mono mb-1 text-[11px] text-ink-3">{current.hint}</p>
              <h2 className="text-[15px] font-semibold leading-snug text-ink">{current.label}</h2>
              <div className="prose prose-sm mt-3 max-w-none text-[13px] leading-relaxed text-ink-2">
                {current.item.tldr?.map((line, i) => (
                  <Md key={i}>{line}</Md>
                ))}
              </div>
            </aside>
          )}
        </div>
        <p className="mono border-t border-rule-light px-4 py-2 text-[11px] text-ink-3">
          ↑↓ navigate · Enter open · Esc close
        </p>
      </div>
    </div>
  );
}
