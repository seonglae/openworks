import { House, Pencil, Menu, Plus, Search } from "lucide-react";
import type { ReactNode } from "react";

export function TabBar({
  onHome,
  onMenu,
  onSearch,
  onCapture,
  onDraw,
  active,
}: {
  onHome: () => void;
  onMenu: () => void;
  onSearch?: () => void;
  onCapture: () => void;
  onDraw: () => void;
  active?: "home" | "draw";
}) {
  return (
    <nav
      aria-label="Tabs"
      className="glass-bar fixed inset-x-0 bottom-0 z-30 border-t border-rule sm:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto flex max-w-md items-stretch justify-around">
        <TabButton label="Home" onClick={onHome} current={active === "home"}>
          <House size={20} />
        </TabButton>
        {onSearch && (
          <TabButton label="Search" onClick={onSearch}>
            <Search size={20} />
          </TabButton>
        )}
        <TabButton label="Add" onClick={onCapture} accent>
          <Plus size={22} />
        </TabButton>
        <TabButton label="Draw" onClick={onDraw} current={active === "draw"}>
          <Pencil size={20} />
        </TabButton>
        <TabButton label="Menu" onClick={onMenu}>
          <Menu size={20} />
        </TabButton>
      </div>
    </nav>
  );
}

function TabButton({
  label,
  onClick,
  accent,
  current,
  children,
}: {
  label: string;
  onClick: () => void;
  accent?: boolean;
  current?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={current ? "page" : undefined}
      onClick={onClick}
      className={`flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] ${accent || current ? "text-rust" : "text-ink-3 hover:text-ink"}`}
    >
      {children}
      <span aria-hidden>{label}</span>
    </button>
  );
}
