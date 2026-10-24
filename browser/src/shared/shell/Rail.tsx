import { useEffect, useRef, useState, type ReactNode } from "react";
import { Plus, Search, X } from "lucide-react";
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
import { MODES } from "../modes";
import type { Mode } from "../types";
import { useDialog } from "./useDialog";
import { isModifiedClick } from "../ui";

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
      role="link"
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
      aria-current={isActive ? "page" : undefined}
      className={`relative flex w-full items-center gap-2.5 px-2 py-1.5 text-[13px] transition-colors cursor-pointer select-none outline-none rounded-lg whitespace-nowrap
        ${isActive ? "bg-rust-dim font-medium text-rust" : "text-ink-2 hover:bg-paper-warm hover:text-ink"}
      `}
    >
      <Icon size={15} className="shrink-0" />
      {m.label}
    </a>
  );
}

export function Rail({
  active,
  onSelect,
  tabHref,
  modes,
  onReorder,
  open,
  onClose,
  onCapture,
  onSearch,
  onHome,
  footer,
}: {
  active: Mode | null;
  onSelect: (m: Mode) => void;
  tabHref: (m: Mode) => string;
  modes: typeof MODES;
  onReorder?: (next: Mode[]) => void;
  open: boolean;
  onClose: () => void;
  onCapture: () => void;
  onSearch: () => void;
  onHome: () => void;
  footer: ReactNode;
}) {
  const [phone, setPhone] = useState(() => !window.matchMedia("(min-width: 40rem)").matches);
  const dialogRef = useDialog(onClose, phone && open);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 40rem)");
    const update = () => setPhone(!query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 400, tolerance: 8 } }),
  );
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
        ref={dialogRef}
        tabIndex={-1}
        role={phone && open ? "dialog" : undefined}
        aria-modal={phone && open ? true : undefined}
        aria-label="Menu"
        inert={phone && !open}
        className={`glass-bar fixed inset-y-0 left-0 z-50 flex w-64 flex-col overflow-y-auto border-r border-rule px-3 py-5 transition-transform duration-200
          ${open ? "translate-x-0" : "-translate-x-full"}
          sm:sticky sm:top-0 sm:z-30 sm:h-dvh sm:shrink-0 sm:w-56 sm:translate-x-0 sm:transform-none`}
        style={{
          paddingTop: "max(1.25rem, env(safe-area-inset-top))",
          paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))",
        }}
      >
        <div className="mb-5 flex items-center justify-between px-2">
          <button onClick={onHome} className="serif text-2xl tracking-tight text-ink" title="Openworks AI">
            Openworks
          </button>
          <button onClick={onClose} className="p-1 text-ink-3 hover:text-ink sm:hidden" title="Close">
            <X size={16} />
          </button>
        </div>
        <p className="mb-4 px-2 text-[11px] leading-relaxed text-ink-3">
          read &rarr; summarize &rarr; internalize &rarr; organize &rarr; express
        </p>
        <button
          onClick={() => {
            onClose();
            onCapture();
          }}
          className="mb-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] font-medium text-rust hover:bg-rust-dim"
          title="Press c or paste outside a field"
        >
          <Plus size={15} /> Add <kbd className="mono ml-auto text-[11px] text-ink-4">c</kbd>
        </button>
        <button
          onClick={() => {
            onClose();
            onSearch();
          }}
          className="mb-5 flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-ink-2 hover:bg-paper-warm hover:text-ink"
        >
          <Search size={15} /> Search <kbd className="mono ml-auto text-[11px] text-ink-4">⌘K</kbd>
        </button>
        <nav aria-label="Sections" className="relative flex flex-1 flex-col gap-1">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={modes.map((m) => m.key)} strategy={verticalListSortingStrategy}>
              {modes.map((m) => (
                <SortableTab key={m.key} m={m} isActive={active === m.key} href={tabHref(m.key)} onSelect={pick} />
              ))}
            </SortableContext>
          </DndContext>
        </nav>
        <div className="mt-4 flex items-center gap-1 border-t border-rule-light pt-3">{footer}</div>
      </aside>
    </>
  );
}
