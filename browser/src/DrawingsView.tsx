import { useState, useCallback, useRef, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Excalidraw, exportToBlob } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { Plus, Trash2, Pencil, ArrowLeft } from "lucide-react";
import "@excalidraw/excalidraw/index.css";

export function DrawingsView({
  activeId,
  onActiveIdChange,
  backHref,
}: {
  activeId: Id<"drawings"> | null;
  onActiveIdChange: (id: Id<"drawings"> | null) => void;
  backHref?: string;
}) {
  return activeId ? (
    <DrawingEditor id={activeId} onBack={() => onActiveIdChange(null)} backHref={backHref} />
  ) : (
    <DrawingsList onOpen={onActiveIdChange} />
  );
}

function DrawingsList({ onOpen }: { onOpen: (id: Id<"drawings">) => void }) {
  const drawings = useQuery(api.drawings.list, {});
  const createDrawing = useMutation(api.drawings.create);
  const removeDrawing = useMutation(api.drawings.remove);
  const renameDrawing = useMutation(api.drawings.rename);
  const [renamingId, setRenamingId] = useState<Id<"drawings"> | null>(null);
  const [renameVal, setRenameVal] = useState("");

  const handleCreate = async () => {
    const id = await createDrawing({});
    onOpen(id);
  };

  const startRename = (d: { _id: Id<"drawings">; title: string }) => {
    setRenamingId(d._id);
    setRenameVal(d.title);
  };

  const commitRename = async () => {
    if (renamingId && renameVal.trim()) {
      await renameDrawing({ id: renamingId, title: renameVal.trim() });
    }
    setRenamingId(null);
  };

  const relTime = (ts: number) => {
    const d = Date.now() - ts;
    if (d < 60_000) return "just now";
    if (d < 3600_000) return `${Math.floor(d / 60_000)}m ago`;
    if (d < 86400_000) return `${Math.floor(d / 3600_000)}h ago`;
    return `${Math.floor(d / 86400_000)}d ago`;
  };

  if (drawings === undefined) {
    return <div className="mono text-xs text-ink-4 py-12 text-center">loading drawings...</div>;
  }

  return (
    <div className="py-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
        <button
          onClick={handleCreate}
          className="aspect-[4/3] border-2 border-dashed border-rule hover:border-ink-3 rounded-2xl flex flex-col items-center justify-center gap-2 transition-colors group"
        >
          <Plus size={24} className="text-ink-4 group-hover:text-ink-2" />
          <span className="mono text-[10px] uppercase tracking-wider text-ink-4 group-hover:text-ink-2">
            New Drawing
          </span>
        </button>
        {drawings.map((d) => (
          <div
            key={d._id}
            className="aspect-[4/3] border border-rule hover:border-ink-3 rounded-2xl overflow-hidden flex flex-col cursor-pointer transition-colors group relative"
            onClick={() => onOpen(d._id)}
          >
            {d.thumbnail ? (
              <img src={d.thumbnail} alt="" className="flex-1 object-contain bg-white p-1" draggable={false} />
            ) : (
              <div className="flex-1 flex items-center justify-center bg-paper-warm">
                <Pencil size={20} className="text-ink-4" />
              </div>
            )}
            <div className="px-2 py-1.5 border-t border-rule-light flex items-center gap-1 min-w-0">
              {renamingId === d._id ? (
                <input
                  autoFocus
                  className="mono text-[11px] text-ink bg-transparent outline-none flex-1 min-w-0"
                  value={renameVal}
                  onChange={(e) => setRenameVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  onBlur={commitRename}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="mono text-[11px] text-ink truncate flex-1">{d.title}</span>
              )}
              <span className="mono text-[9px] text-ink-4 shrink-0">{relTime(d.updatedAt)}</span>
            </div>
            <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(d);
                }}
                className="p-1.5 bg-ink/80 text-paper hover:bg-ink rounded-full backdrop-blur-sm"
                title="Rename"
              >
                <Pencil size={10} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  removeDrawing({ id: d._id });
                }}
                className="p-1.5 bg-ink/80 text-paper hover:bg-rust rounded-full backdrop-blur-sm"
                title="Delete"
              >
                <Trash2 size={10} />
              </button>
            </div>
          </div>
        ))}
      </div>
      {drawings.length === 0 && (
        <div className="text-center py-16">
          <p className="serif text-xl text-ink-3">No drawings yet</p>
          <p className="mono text-xs text-ink-4 mt-2">Click + to create your first drawing</p>
        </div>
      )}
    </div>
  );
}

// Thumbnail re-render is ~20× the elements payload; gate it on its own
// interval so element saves stay snappy at 500 ms while bandwidth stays
// bounded during rapid drawing.
const ELEMENTS_DEBOUNCE_MS = 500;
const THUMBNAIL_INTERVAL_MS = 5000;

function DrawingEditor({ id, onBack, backHref }: { id: Id<"drawings">; onBack: () => void; backHref?: string }) {
  const drawing = useQuery(api.drawings.getById, { id });
  const updateDrawing = useMutation(api.drawings.update);
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef("");
  const lastThumbAtRef = useRef(0);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void (async () => {
        try {
          if (!excalidrawAPI) return;
          const elements = excalidrawAPI.getSceneElements();
          const appState = excalidrawAPI.getAppState();
          const elemStr = JSON.stringify(elements);
          if (elemStr === lastSavedRef.current) return;
          lastSavedRef.current = elemStr;
          const stateSubset = JSON.stringify({
            viewBackgroundColor: appState.viewBackgroundColor,
            zoom: appState.zoom,
            scrollX: appState.scrollX,
            scrollY: appState.scrollY,
          });
          let thumb: string | undefined;
          const now = Date.now();
          if (now - lastThumbAtRef.current >= THUMBNAIL_INTERVAL_MS) {
            try {
              const blob = await exportToBlob({
                elements,
                appState: { ...appState, exportWithDarkMode: false },
                maxWidthOrHeight: 320,
                files: excalidrawAPI.getFiles(),
              });
              thumb = await new Promise<string | undefined>((res) => {
                const r = new FileReader();
                r.onload = () => res(typeof r.result === "string" ? r.result : undefined);
                r.readAsDataURL(blob);
              });
              lastThumbAtRef.current = now;
            } catch (err) {
              console.warn("[drawing thumbnail] export failed:", err);
            }
          }
          await updateDrawing({ id, elements: elemStr, appState: stateSubset, thumbnail: thumb });
        } catch (err) {
          console.error("[drawing save] failed:", err);
        }
      })();
    }, ELEMENTS_DEBOUNCE_MS);
  }, [excalidrawAPI, id, updateDrawing]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBack();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onBack]);

  if (drawing === undefined) {
    return (
      <div className="fixed inset-0 z-50 bg-white flex items-center justify-center">
        <span className="mono text-xs text-ink-4">loading...</span>
      </div>
    );
  }
  if (drawing === null) {
    return (
      <div className="fixed inset-0 z-50 bg-white flex items-center justify-center">
        <span className="mono text-xs text-rust">drawing not found</span>
      </div>
    );
  }

  const initialElements = (() => {
    try {
      return JSON.parse(drawing.elements);
    } catch {
      return [];
    }
  })();

  const initialAppState = (() => {
    if (!drawing.appState) return {};
    try {
      return JSON.parse(drawing.appState);
    } catch {
      return {};
    }
  })();

  return (
    <div className="fixed inset-0 z-50 bg-white">
      <a
        href={backHref}
        onClick={(e) => {
          if (backHref && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)) return;
          e.preventDefault();
          onBack();
        }}
        className="absolute top-[16px] left-16 z-[60] flex items-center gap-1.5 bg-white/90 backdrop-blur-sm px-2.5 py-1.5 rounded-lg shadow-sm border border-gray-200 text-gray-500 hover:text-gray-800 transition-colors"
      >
        <ArrowLeft size={14} />
        <span className="text-xs">{drawing.title}</span>
      </a>
      <div className="w-full h-full">
        <Excalidraw
          excalidrawAPI={(api: ExcalidrawImperativeAPI) => setExcalidrawAPI(api)}
          initialData={{ elements: initialElements, appState: initialAppState }}
          onChange={scheduleSave}
        />
      </div>
    </div>
  );
}
