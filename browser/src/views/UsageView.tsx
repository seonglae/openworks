import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { BlockSkeleton } from "../shared/ui";

// Usage tab: where the time went. Engaged time per view, a daily trend, and
// the moves between views, all from the app's own event stream.

const RANGES = [7, 30, 90] as const;

// Under a minute reads as seconds. Rounding a 40-second visit to "0m" says
// nothing happened, which is a different claim from "not long".
function hm(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="pr-8">
      <div className="serif text-[34px] leading-none text-ink">{value}</div>
      <div className="mono text-[10px] uppercase tracking-wider text-ink-4 pt-1.5">{label}</div>
    </div>
  );
}

export function UsageView() {
  const [days, setDays] = useState<number>(30);
  const [includeDev, setIncludeDev] = useState(false);
  const data = useQuery(api.usage.overview, { days, includeDev });
  const flow = useQuery(api.usage.flow, { days });

  // undefined is the query in flight, not an empty history: rendering the
  // zeroes for it flashes a wrong answer before the real one lands.
  if (data === undefined) {
    return (
      <div className="panel anim d2">
        <BlockSkeleton rows={6} />
      </div>
    );
  }

  const maxTabMs = Math.max(1, ...data.tabs.map((t) => t.activeMs));
  const maxDayMs = Math.max(1, ...data.days.map((d) => d.activeMs));
  const maxEdge = Math.max(1, ...(flow?.edges ?? []).map((e) => e.count));

  return (
    <div className="panel anim d2">
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        {RANGES.map((r) => (
          <button
            key={r}
            onClick={() => setDays(r)}
            className={`mono text-[10px] uppercase tracking-wider ${
              days === r ? "text-rust" : "text-ink-4 hover:text-ink"
            }`}
          >
            {r}d
          </button>
        ))}
        <div className="flex-1" />
        {data.devCount > 0 && (
          <button
            onClick={() => setIncludeDev((v) => !v)}
            className={`mono text-[10px] uppercase tracking-wider ${
              includeDev ? "text-rust" : "text-ink-4 hover:text-ink"
            }`}
            title="Sessions served from localhost are usually you building the app, not using it"
          >
            {includeDev ? "with" : "without"} dev ({data.devCount})
          </button>
        )}
      </div>

      {data.totals.visits === 0 ? (
        <div className="text-[13px] text-ink-3">
          Nothing recorded in this window yet. Usage is collected from this browser as you move between tabs.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-y-4 mb-7">
            <Stat value={hm(data.totals.activeMs)} label="engaged" />
            <Stat value={String(data.totals.visits)} label="visits" />
            <Stat value={String(data.totals.tabs)} label="tabs used" />
            <Stat value={String(data.totals.browsers)} label="browsers" />
          </div>

          <div className="mono text-[10px] uppercase tracking-wider text-ink-4 mb-2">time by tab</div>
          <div className="mb-7">
            {data.tabs.map((t) => (
              <div key={t.tab} className="flex items-center gap-3 py-[3px]">
                <div className="w-[84px] shrink-0 text-[13px] text-ink">{t.tab}</div>
                <div className="flex-1 h-[10px] bg-paper-warm/50 rounded-sm overflow-hidden">
                  <div className="h-full bg-rust/70" style={{ width: `${(t.activeMs / maxTabMs) * 100}%` }} />
                </div>
                <div className="mono text-[11px] text-ink-3 w-[62px] text-right shrink-0">{hm(t.activeMs)}</div>
                <div className="mono text-[11px] text-ink-4 w-[46px] text-right shrink-0">{t.visits}v</div>
              </div>
            ))}
          </div>

          <div className="mono text-[10px] uppercase tracking-wider text-ink-4 mb-2">per day</div>
          <div className="flex items-end gap-[3px] h-[72px] mb-1">
            {data.days.map((d) => (
              <div
                key={d.day}
                className="flex-1 bg-rust/60 rounded-t-sm min-h-[2px]"
                style={{ height: `${Math.max(2, (d.activeMs / maxDayMs) * 100)}%` }}
                title={`${d.day}: ${hm(d.activeMs)} over ${d.visits} visit${d.visits === 1 ? "" : "s"}`}
              />
            ))}
          </div>
          <div className="flex justify-between mono text-[10px] text-ink-4 mb-7">
            <span>{data.days[0]?.day ?? ""}</span>
            <span>{data.days[data.days.length - 1]?.day ?? ""}</span>
          </div>

          <div className="mono text-[10px] uppercase tracking-wider text-ink-4 mb-2">moves between tabs</div>
          {flow === undefined ? (
            <BlockSkeleton rows={3} />
          ) : flow.edges.length === 0 ? (
            <div className="text-[13px] text-ink-3 mb-6">
              No moves yet. A single tab open on one view has nowhere to go.
            </div>
          ) : (
            <div className="mb-6">
              {flow.edges.slice(0, 12).map((e) => (
                <div key={`${e.from}-${e.to}`} className="flex items-center gap-3 py-[3px]">
                  <div className="w-[170px] shrink-0 text-[13px] text-ink">
                    {e.from} <span className="text-ink-4">&rarr;</span> {e.to}
                  </div>
                  <div className="flex-1 h-[8px] bg-paper-warm/50 rounded-sm overflow-hidden">
                    <div className="h-full bg-slate/60" style={{ width: `${(e.count / maxEdge) * 100}%` }} />
                  </div>
                  <div className="mono text-[11px] text-ink-3 w-[36px] text-right shrink-0">{e.count}</div>
                </div>
              ))}
            </div>
          )}

          {(data.truncated || flow?.truncated) && (
            <div className="mono text-[10px] text-ink-4">
              capped at the per-window read limit; older rows in this range are not counted
            </div>
          )}
        </>
      )}
    </div>
  );
}
