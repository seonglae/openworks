import { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id, Doc } from "../../../convex/_generated/dataModel";
import { Check, ChevronDown, ChevronRight, Circle, MapPin } from "lucide-react";
import { DaySyncButton } from "../DaySyncButton";
import { localDate, dateParts, addDays } from "../shared/date";
import { useCachedQuery } from "../shared/hooks";
import { BlockSkeleton } from "../shared/ui";

const TIER_STYLES: Record<number, string> = {
  0: "border-l-4 border-rust bg-rust/5",
  1: "border-l-4 border-sage bg-sage/5",
  2: "border-l-4 border-ink-3",
  3: "border-l-4 border-rule-light",
};

export function PlansView() {
  const allPlansRaw = useQuery(api.plans.listAll, {});
  const allPlans = useCachedQuery("cache:plans:listAll", allPlansRaw);
  // null = default "all" view (every plan's events merged). A tab selects one.
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  // "Recent Calendar" is a derived outlook-only plan; its events already merge
  // into the default all-calendar, so the separate tab is just noise. Drop it.
  const sortedPlans = [...(allPlans ?? [])]
    .filter((p) => p.slug !== "recent-calendar")
    .sort((a, b) => (a.firstDate ?? "").localeCompare(b.firstDate ?? ""));

  const selData = useQuery(api.plans.getBySlug, selectedSlug ? { slug: selectedSlug } : "skip");
  // Always load the merged set: the calendar shows every event continuously
  // regardless of the selected tab (a plan is just a date-range anchor).
  const allData = useQuery(api.plans.allItems, {});
  const toggleDone = useMutation(api.plans.toggleDone);

  if (allPlans === undefined) {
    return <BlockSkeleton rows={4} className="py-8" />;
  }
  if (allPlans.length === 0) {
    return (
      <div className="text-ink-4 mono text-xs py-8">
        No plans found. Run <code className="text-ink-2">node scripts/sync-plans.mjs</code> to sync from ../PR/**/plan.md
      </div>
    );
  }

  const isOffline = allPlansRaw === undefined;
  // The calendar always renders every plan's events (a plan is just a date
  // range); selecting a tab only re-anchors the start week to that plan's first
  // day so past plans (e.g. ICLR Rio in April) reveal their own range.
  const selectedPlan = selectedSlug ? sortedPlans.find((p) => p.slug === selectedSlug) : null;
  const anchorDate = selectedPlan?.firstDate ?? undefined;
  const calendarItems = allData?.items ?? [];
  const detailData: { plan: Doc<"plans">; days: Doc<"planDays">[]; items: Doc<"planItems">[] } | null = selectedSlug
    ? (selData ?? null)
    : allData
      ? {
          plan: { slug: "__all__", title: "All plans", rawMarkdown: "", syncedAt: 0 } as unknown as Doc<"plans">,
          days: allData.days,
          items: allData.items,
        }
      : null;

  const tripList = sortedPlans.map((p) => ({
    slug: p.slug,
    title: p.title,
    firstDate: p.firstDate,
    lastDate: p.lastDate,
    location: p.location,
  }));

  return (
    <div>
      {isOffline && (
        <div className="mono text-[10px] text-ink-4 mb-2 flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-ochre" /> offline (cached)
        </div>
      )}
      {detailData ? (
        <PlanDetail
          data={detailData}
          calendarItems={calendarItems}
          plans={tripList}
          selectedSlug={selectedSlug}
          onSelect={(slug) => setSelectedSlug((cur) => (cur === slug ? null : slug))}
          anchorDate={anchorDate}
          onToggle={(id) => toggleDone({ itemId: id })}
        />
      ) : (
        <BlockSkeleton rows={4} className="py-8" />
      )}
    </div>
  );
}

type TripMeta = { slug: string; title: string; firstDate: string | null; lastDate: string | null; location?: string };

// Left rail listing each trip / itinerary. Selecting one anchors the calendar
// to its first day (and scopes the list view); clicking the active one returns
// to the merged all-trips view.
function TripsSidebar({
  plans,
  selectedSlug,
  onSelect,
}: {
  plans: TripMeta[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
}) {
  const fmt = (d: string | null) => (d ? d.slice(5).replace("-", "/") : "");
  return (
    <div className="shrink-0 w-full sm:w-44">
      <div className="mono text-[10px] uppercase tracking-wider text-ink-4 mb-2 px-1">Itineraries</div>
      <div className="flex flex-row flex-wrap sm:flex-col gap-1">
        {plans.map((p) => {
          const active = p.slug === selectedSlug;
          return (
            <button
              key={p.slug}
              onClick={() => onSelect(p.slug)}
              className={`text-left rounded px-2 py-1.5 transition-colors border ${
                active
                  ? "border-rust bg-rust/5 text-rust"
                  : "border-rule-light text-ink-3 hover:text-ink hover:border-rule"
              }`}
            >
              <div className="text-[11px] font-semibold leading-tight">{p.title}</div>
              <div className="mono text-[8px] text-ink-4 mt-0.5">
                {fmt(p.firstDate)}
                {p.lastDate ? ` – ${fmt(p.lastDate)}` : ""}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PlanDetail({
  data,
  calendarItems,
  plans,
  selectedSlug,
  onSelect,
  anchorDate,
  onToggle,
}: {
  data: { plan: Doc<"plans">; days: Doc<"planDays">[]; items: Doc<"planItems">[] };
  calendarItems: Doc<"planItems">[];
  plans: TripMeta[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
  anchorDate?: string;
  onToggle: (id: Id<"planItems">) => void;
}) {
  const { plan, items } = data;
  const allDays = [...data.days].sort((a, b) => a.date.localeCompare(b.date));
  // The merged all-trips list is an agenda around now (recent past + forward),
  // not the whole archive; a selected trip shows its own full span.
  const todayStr = localDate(new Date());
  const days = plan.slug === "__all__" ? allDays.filter((d) => d.date >= addDays(todayStr, -3)) : allDays;
  const themes = extractThemes(plan.theme);
  const [view, setViewState] = useState<"calendar" | "list" | "map">(() => {
    const v = new URLSearchParams(window.location.search).get("view");
    return v === "list" || v === "map" ? v : "calendar";
  });
  // Mirror the view in the URL so a shared / reloaded link keeps it.
  const setView = (v: "calendar" | "list" | "map") => {
    setViewState(v);
    const u = new URL(window.location.href);
    if (v === "calendar") u.searchParams.delete("view");
    else u.searchParams.set("view", v);
    window.history.replaceState(null, "", u.toString());
  };

  const toggleBtn = (v: "calendar" | "list" | "map", label: string) => (
    <button
      onClick={() => setView(v)}
      className={`mono text-[10px] uppercase tracking-wider px-3 py-0.5 rounded-full transition-colors relative z-10 ${view === v ? "droplet text-rust" : "text-ink-3 hover:text-ink"}`}
    >
      {label}
    </button>
  );

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <h1 className="font-serif text-xl text-ink">{plan.slug === "__all__" ? "Itineraries" : plan.title}</h1>
        <div className="glass rounded-full flex gap-1 px-1 py-1 relative">
          {toggleBtn("calendar", "calendar")}
          {toggleBtn("list", "list")}
          {toggleBtn("map", "map")}
        </div>
      </div>

      {view === "list" ? (
        <div className="space-y-6">
          {days.length === 0 ? (
            <div className="mono text-[11px] text-ink-4 italic py-6 text-center">no plan days yet.</div>
          ) : (
            days.map((day) => (
              <DayBlock
                key={day._id}
                day={day}
                items={items.filter((it) => it.date === day.date)}
                onToggle={onToggle}
                themes={themes}
                defaultExpanded
              />
            ))
          )}
        </div>
      ) : (
        <div
          style={{ marginLeft: "calc(50% - 50vw)", marginRight: "calc(50% - 50vw)" }}
          className="flex justify-center"
        >
          <div
            className="panel anim d2 flex flex-col sm:flex-row gap-4"
            style={{ width: "min(calc(100vw - 2rem - env(safe-area-inset-left) - env(safe-area-inset-right)), 84rem)" }}
          >
            <TripsSidebar plans={plans} selectedSlug={selectedSlug} onSelect={onSelect} />
            <div className="flex-1 min-w-0">
              {view === "calendar" ? (
                <PlanCalendar
                  items={calendarItems}
                  startDate={anchorDate}
                  defaultSlug={selectedSlug ?? plans[0]?.slug ?? "travel-history"}
                />
              ) : (
                <PlanMap items={calendarItems} plans={plans} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Emoji only for the few distinctive kinds; everything else gets none (the
// lantern-for-everything looked like spam). Empty string => caller renders no
// icon at all.
const KIND_EMOJI: Record<string, string> = {
  flight: "✈",
  match: "⚽",
  icml: "🎓",
  conference: "🎓",
  travel: "🚆",
};
function eventEmoji(it: { tags: string[] }): string {
  for (const t of it.tags) {
    const e = KIND_EMOJI[t.toLowerCase()];
    if (e) return e;
  }
  return "";
}

// City accent colors (left border + badge), mirroring travel/korea. Unknown
// locations (e.g. a conference room) fall back to a neutral tone.
// Single source of truth for per-city presentation + geo. Color drives the
// cell border/badge, flag shows on the badge, coords feed weather now and a
// statistics map later. Add a city here and everything downstream picks it up.
// `color` is the muted calendar accent (border/badge); `flagColor` is the
// national-flag color used on the map.
type CityMeta = { color: string; flagColor: string; flag: string; country: string; coords: [number, number] };
const CITY_META: Record<string, CityMeta> = {
  london: { color: "#3a4a5c", flagColor: "#012169", flag: "🇬🇧", country: "United Kingdom", coords: [51.5074, -0.1278] },
  seoul: { color: "#c4564a", flagColor: "#cd2e3a", flag: "🇰🇷", country: "South Korea", coords: [37.5665, 126.978] },
  tokyo: { color: "#d4a5a0", flagColor: "#bc002d", flag: "🇯🇵", country: "Japan", coords: [35.6762, 139.6503] },
  shenzhen: { color: "#8a9b7e", flagColor: "#de2910", flag: "🇨🇳", country: "China", coords: [22.5431, 114.0579] },
  "hong kong": {
    color: "#8a7e9b",
    flagColor: "#de2910",
    flag: "🇭🇰",
    country: "Hong Kong",
    coords: [22.3193, 114.1694],
  },
  rio: { color: "#2e8b57", flagColor: "#009c3b", flag: "🇧🇷", country: "Brazil", coords: [-22.9068, -43.1729] },
  "san francisco": {
    color: "#6b8aa5",
    flagColor: "#3c3b6e",
    flag: "🇺🇸",
    country: "United States",
    coords: [37.7749, -122.4194],
  },
  "new york": {
    color: "#6b8aa5",
    flagColor: "#3c3b6e",
    flag: "🇺🇸",
    country: "United States",
    coords: [40.7128, -74.006],
  },
  taipei: { color: "#7e9b8a", flagColor: "#fe0000", flag: "🇹🇼", country: "Taiwan", coords: [25.033, 121.5654] },
  copenhagen: { color: "#5a7a8c", flagColor: "#c8102e", flag: "🇩🇰", country: "Denmark", coords: [55.6761, 12.5683] },
  barcelona: { color: "#b08a5c", flagColor: "#aa151b", flag: "🇪🇸", country: "Spain", coords: [41.3874, 2.1686] },
  vienna: { color: "#9b8a7e", flagColor: "#ed2939", flag: "🇦🇹", country: "Austria", coords: [48.2082, 16.3738] },
  zurich: { color: "#8a9b9b", flagColor: "#d52b1e", flag: "🇨🇭", country: "Switzerland", coords: [47.3769, 8.5417] },
  venice: { color: "#7e9b8a", flagColor: "#008c45", flag: "🇮🇹", country: "Italy", coords: [45.4408, 12.3155] },
  singapore: { color: "#b08a8a", flagColor: "#ef3340", flag: "🇸🇬", country: "Singapore", coords: [1.3521, 103.8198] },
  sydney: { color: "#5c8ab0", flagColor: "#00247d", flag: "🇦🇺", country: "Australia", coords: [-33.8688, 151.2093] },
  melbourne: { color: "#5c8ab0", flagColor: "#00247d", flag: "🇦🇺", country: "Australia", coords: [-37.8136, 144.9631] },
  brisbane: { color: "#5c8ab0", flagColor: "#00247d", flag: "🇦🇺", country: "Australia", coords: [-27.4698, 153.0251] },
  uluru: { color: "#c08552", flagColor: "#00247d", flag: "🇦🇺", country: "Australia", coords: [-25.3444, 131.0369] },
  "los angeles": {
    color: "#6b8aa5",
    flagColor: "#3c3b6e",
    flag: "🇺🇸",
    country: "United States",
    coords: [34.0522, -118.2437],
  },
  "san diego": {
    color: "#6b8aa5",
    flagColor: "#3c3b6e",
    flag: "🇺🇸",
    country: "United States",
    coords: [32.7157, -117.1611],
  },
  riverside: {
    color: "#6b8aa5",
    flagColor: "#3c3b6e",
    flag: "🇺🇸",
    country: "United States",
    coords: [33.9806, -117.3755],
  },
  miami: { color: "#6b8aa5", flagColor: "#3c3b6e", flag: "🇺🇸", country: "United States", coords: [25.7617, -80.1918] },
  boston: { color: "#6b8aa5", flagColor: "#3c3b6e", flag: "🇺🇸", country: "United States", coords: [42.3601, -71.0589] },
  "las vegas": {
    color: "#6b8aa5",
    flagColor: "#3c3b6e",
    flag: "🇺🇸",
    country: "United States",
    coords: [36.1699, -115.1398],
  },
  osaka: { color: "#d4a5a0", flagColor: "#bc002d", flag: "🇯🇵", country: "Japan", coords: [34.6937, 135.5023] },
  kyoto: { color: "#d4a5a0", flagColor: "#bc002d", flag: "🇯🇵", country: "Japan", coords: [35.0116, 135.7681] },
  fukuoka: { color: "#d4a5a0", flagColor: "#bc002d", flag: "🇯🇵", country: "Japan", coords: [33.5904, 130.4017] },
  berlin: { color: "#7e7e7e", flagColor: "#dd0000", flag: "🇩🇪", country: "Germany", coords: [52.52, 13.405] },
  munich: { color: "#7e7e7e", flagColor: "#dd0000", flag: "🇩🇪", country: "Germany", coords: [48.1351, 11.582] },
  paris: { color: "#5c7ab0", flagColor: "#0055a4", flag: "🇫🇷", country: "France", coords: [48.8566, 2.3522] },
  lyon: { color: "#5c7ab0", flagColor: "#0055a4", flag: "🇫🇷", country: "France", coords: [45.764, 4.8357] },
  prague: { color: "#9b7e8a", flagColor: "#d7141a", flag: "🇨🇿", country: "Czechia", coords: [50.0755, 14.4378] },
  busan: { color: "#c4564a", flagColor: "#cd2e3a", flag: "🇰🇷", country: "South Korea", coords: [35.1796, 129.0756] },
  jeju: { color: "#c4564a", flagColor: "#cd2e3a", flag: "🇰🇷", country: "South Korea", coords: [33.4996, 126.5312] },
  incheon: { color: "#c4564a", flagColor: "#cd2e3a", flag: "🇰🇷", country: "South Korea", coords: [37.4563, 126.7052] },
  changwon: { color: "#c4564a", flagColor: "#cd2e3a", flag: "🇰🇷", country: "South Korea", coords: [35.228, 128.6811] },
  sokcho: { color: "#c4564a", flagColor: "#cd2e3a", flag: "🇰🇷", country: "South Korea", coords: [38.207, 128.5918] },
  gangneung: {
    color: "#c4564a",
    flagColor: "#cd2e3a",
    flag: "🇰🇷",
    country: "South Korea",
    coords: [37.7519, 128.8761],
  },
  pohang: { color: "#c4564a", flagColor: "#cd2e3a", flag: "🇰🇷", country: "South Korea", coords: [36.019, 129.3435] },
  tromso: { color: "#5a7a9b", flagColor: "#ef2b2d", flag: "🇳🇴", country: "Norway", coords: [69.6492, 18.9553] },
  jiufen: { color: "#7e9b8a", flagColor: "#fe0000", flag: "🇹🇼", country: "Taiwan", coords: [25.1097, 121.8443] },
  cambridge: {
    color: "#3a4a5c",
    flagColor: "#012169",
    flag: "🇬🇧",
    country: "United Kingdom",
    coords: [52.2053, 0.1218],
  },
  bath: { color: "#3a4a5c", flagColor: "#012169", flag: "🇬🇧", country: "United Kingdom", coords: [51.3811, -2.359] },
  brighton: {
    color: "#3a4a5c",
    flagColor: "#012169",
    flag: "🇬🇧",
    country: "United Kingdom",
    coords: [50.8225, -0.1372],
  },
  bettmeralp: { color: "#8a9b9b", flagColor: "#d52b1e", flag: "🇨🇭", country: "Switzerland", coords: [46.3917, 8.0697] },
  dublin: { color: "#7e9b7e", flagColor: "#169b62", flag: "🇮🇪", country: "Ireland", coords: [53.3498, -6.2603] },
  lisbon: { color: "#8a9b7e", flagColor: "#006600", flag: "🇵🇹", country: "Portugal", coords: [38.7223, -9.1393] },
};
// Alternate spellings resolve to a canonical key above (no duplicated objects).
const CITY_ALIASES: Record<string, string> = {
  hongkong: "hong kong",
  "rio de janeiro": "rio",
  brazil: "rio",
  sf: "san francisco",
  "san fran": "san francisco",
  nyc: "new york",
  "new york city": "new york",
  newyork: "new york",
  la: "los angeles",
  "l.a.": "los angeles",
  florida: "miami",
  orlando: "miami",
  "las vegas nv": "las vegas",
  vegas: "las vegas",
  "ayers rock": "uluru",
  yulara: "uluru",
};
const cityMeta = (city: string): CityMeta | undefined => {
  const k = city.toLowerCase();
  return CITY_META[k] ?? CITY_META[CITY_ALIASES[k] ?? ""];
};
// Arrival/departure airport codes -> canonical city key, for travel records.
const AIRPORT_CITY: Record<string, string> = {
  LHR: "london",
  LGW: "london",
  LCY: "london",
  ICN: "seoul",
  GMP: "seoul",
  NRT: "tokyo",
  HND: "tokyo",
  SZX: "shenzhen",
  HKG: "hong kong",
  GIG: "rio",
  GRU: "rio",
  SFO: "san francisco",
  JFK: "new york",
  EWR: "new york",
  LGA: "new york",
  TPE: "taipei",
  CPH: "copenhagen",
  BCN: "barcelona",
  VIE: "vienna",
  ZRH: "zurich",
  VCE: "venice",
  SIN: "singapore",
  SYD: "sydney",
  MEL: "melbourne",
  BNE: "brisbane",
  AYQ: "uluru",
  KIX: "osaka",
  ITM: "osaka",
  FUK: "fukuoka",
  BER: "berlin",
  MUC: "munich",
  CDG: "paris",
  ORY: "paris",
  LYS: "lyon",
  PRG: "prague",
  PUS: "busan",
  DUB: "dublin",
  LIS: "lisbon",
};
// Last airport code in a flight title is the destination.
function flightDestCity(title: string): string | undefined {
  const codes = title.match(/\b[A-Z]{3}\b/g);
  if (!codes) return undefined;
  for (let i = codes.length - 1; i >= 0; i--) if (AIRPORT_CITY[codes[i]]) return AIRPORT_CITY[codes[i]];
  return undefined;
}
const cityColor = (city: string): string => cityMeta(city)?.color ?? "#8a8a8a";
const cityFlag = (city: string): string => cityMeta(city)?.flag ?? "";
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function evKindCls(it: { tags: string[] }): string {
  const t = it.tags.map((x) => x.toLowerCase());
  if (t.includes("match")) return "text-rust font-semibold";
  if (t.includes("flight")) return "text-sage font-semibold";
  if (t.includes("icml") || t.includes("conference")) return "text-slate font-semibold";
  return "text-ink-2";
}

// Automated per-city weather via Open-Meteo (no API key, browser-CORS ok).
// Coords come from CITY_META; unknown cities just render no weather.
function wmoIcon(code: number): string {
  if (code === 0) return "☀";
  if (code <= 3) return "⛅";
  if (code <= 48) return "🌫";
  if (code <= 67) return "🌧";
  if (code <= 77) return "🌨";
  if (code <= 82) return "🌦";
  return "🌩";
}
type DayWx = { hi: number; lo: number; icon: string };
const weatherCache = new Map<string, Map<string, DayWx>>();

function useWeather(cities: string[]): Map<string, Map<string, DayWx>> {
  const [, bump] = useState(0);
  const key = [...new Set(cities.map((c) => c.toLowerCase()))].sort().join(",");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const c of new Set(cities.map((x) => x.toLowerCase()))) {
        if (weatherCache.has(c)) continue;
        const co = cityMeta(c)?.coords;
        if (!co) continue;
        try {
          const r = await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${co[0]}&longitude=${co[1]}&daily=temperature_2m_max,temperature_2m_min,weather_code&forecast_days=16&timezone=auto`,
          );
          const j = await r.json();
          const m = new Map<string, DayWx>();
          const t: string[] = j.daily?.time ?? [];
          for (let i = 0; i < t.length; i++) {
            m.set(t[i], {
              hi: Math.round(j.daily.temperature_2m_max[i]),
              lo: Math.round(j.daily.temperature_2m_min[i]),
              icon: wmoIcon(j.daily.weather_code[i]),
            });
          }
          weatherCache.set(c, m);
          if (!cancelled) bump((n) => n + 1);
        } catch {
          /* offline / rate-limited: just skip weather */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return weatherCache;
}

function dayOfWeek(dateStr: string): number {
  const [y, m, d] = dateParts(dateStr);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function startOfWeekSunday(dateStr: string): string {
  return addDays(dateStr, -dayOfWeek(dateStr));
}
function dayOfMonth(dateStr: string): number {
  return dateParts(dateStr)[2];
}
function monthIndex(dateStr: string): number {
  return dateParts(dateStr)[1] - 1;
}
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const dayDiff = (a: string, b: string): number => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
// Conference-program detail (every oral / poster / invited talk, expo, social,
// ceremony, reception) is too granular for the grid: cells show only headline
// events (flights, matches, the day's main marker, dinners, personal todos),
// and the full per-session agenda lives in the click/drag detail modal.
const PROGRAM_TAGS = new Set([
  "oral",
  "poster",
  "invited",
  "expo",
  "social",
  "networking",
  "reception",
  "ceremony",
  "spotlight",
  "keynote",
  "session",
  "talk",
  "buffer",
  "sponsor",
  "opening",
  "closing",
]);
const isProgramDetail = (it: Doc<"planItems">): boolean =>
  it.tags.some((t) => /^poster session/i.test(t) || PROGRAM_TAGS.has(t.toLowerCase())) || /^buffer\b/i.test(it.title);
const isArchived = (it: Doc<"planItems">): boolean => it.tags.some((t) => t.toLowerCase() === "archived");
const calendarWorthy = (it: Doc<"planItems">): boolean => !isProgramDetail(it) && !isArchived(it);
const WEEKS_INITIAL = 5;

// Calendar view, styled after travel/korea: a continuous 7-col grid of tall day
// cells anchored at the start week (this week by default, or a selected plan's
// first day) and scrolling forward forever (time doesn't stop — empty days
// render too). Each cell shows date + weekday + the day's city (flag badge,
// city-colored left border) + that city's weather + the important events.
function PlanCalendar({
  items,
  startDate,
  defaultSlug,
}: {
  items: Doc<"planItems">[];
  startDate?: string;
  defaultSlug: string;
}) {
  const todayStr = localDate(new Date());
  const anchor = startDate ?? todayStr;
  const weekStart = startOfWeekSunday(anchor);

  const createItem = useMutation(api.plans.createItem);
  const updateItem = useMutation(api.plans.updateItem);
  const setArchived = useMutation(api.plans.setArchived);
  const deleteItem = useMutation(api.plans.deleteItem);
  // Open the editor for a new event (no `item`) or an existing one.
  const [editor, setEditor] = useState<{ date: string; slug: string; item?: Doc<"planItems"> } | null>(null);

  const itemsByDate = useMemo(() => {
    const m = new Map<string, Doc<"planItems">[]>();
    for (const it of items) {
      if (!calendarWorthy(it)) continue;
      const arr = m.get(it.date) ?? [];
      arr.push(it);
      m.set(it.date, arr);
    }
    return m;
  }, [items]);

  // Default to 5 weeks; the bottom sentinel loads 4 more each time it nears the
  // viewport. Reset when the anchor (selected plan) changes.
  const [weeks, setWeeks] = useState(WEEKS_INITIAL);
  useEffect(() => {
    setWeeks(WEEKS_INITIAL);
  }, [weekStart]);
  const dates = useMemo(() => {
    const out: string[] = [];
    for (let i = 0; i < weeks * 7; i++) out.push(addDays(weekStart, i));
    return out;
  }, [weekStart, weeks]);

  // City per day from KNOWN cities only (room-name locations like "hall a" are
  // ignored), forward-filled within a trip so conference days still show the
  // city + weather. Carry caps at 12 days so trips don't bleed into each other.
  const cityByOwnDay = useMemo(() => {
    const m = new Map<string, string>();
    const byDateAll = new Map<string, Doc<"planItems">[]>();
    for (const it of items) {
      if (isArchived(it)) continue;
      const arr = byDateAll.get(it.date) ?? [];
      arr.push(it);
      byDateAll.set(it.date, arr);
    }
    for (const [date, its] of byDateAll) {
      const counts: Record<string, number> = {};
      for (const it of its) {
        const loc = it.location?.toLowerCase();
        if (loc && cityMeta(loc)) counts[loc] = (counts[loc] ?? 0) + 1;
      }
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (top) m.set(date, top);
    }
    return m;
  }, [items]);
  const cityDates = useMemo(() => [...cityByOwnDay.keys()].sort(), [cityByOwnDay]);
  const cityForDay = (date: string): string => {
    const own = cityByOwnDay.get(date);
    if (own) return own;
    let best = "";
    for (const cd of cityDates) {
      if (cd <= date) best = cd;
      else break;
    }
    if (!best || dayDiff(best, date) > 12) return "";
    return cityByOwnDay.get(best) ?? "";
  };
  const cities = useMemo(() => [...new Set(cityByOwnDay.values())], [cityByOwnDay]);
  const weather = useWeather(cities);
  const wxFor = (date: string, city: string): DayWx | undefined => weather.get(city.toLowerCase())?.get(date);

  const sortItems = (its: Doc<"planItems">[]) =>
    its.slice().sort((a, b) => (a.timeStart ?? "~").localeCompare(b.timeStart ?? "~") || a.order - b.order);

  // Unfiltered per-day items for the detail modal: the cells hide the poster
  // picks, but clicking / dragging a range reveals everything (picks + notes).
  const allByDate = useMemo(() => {
    const m = new Map<string, Doc<"planItems">[]>();
    for (const it of items) {
      const arr = m.get(it.date) ?? [];
      arr.push(it);
      m.set(it.date, arr);
    }
    return m;
  }, [items]);

  // Click a day or drag across a range -> detail modal. `sel` tracks the live
  // drag highlight; `modal` is the committed range shown in the overlay.
  const [sel, setSel] = useState<{ a: string; b: string } | null>(null);
  const [modal, setModal] = useState<{ a: string; b: string } | null>(null);
  const dragging = useRef(false);
  // Mirror the live selection in a ref so the window mouseup handler never reads
  // a stale closure (fast click = mousedown+mouseup in one tick).
  const selRef = useRef<{ a: string; b: string } | null>(null);
  const setSelection = (s: { a: string; b: string } | null) => {
    selRef.current = s;
    setSel(s);
  };
  useEffect(() => {
    const up = () => {
      if (dragging.current && selRef.current) setModal(selRef.current);
      dragging.current = false;
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);
  const rangeOf = (r: { a: string; b: string } | null): string[] => {
    if (!r) return [];
    const lo = r.a <= r.b ? r.a : r.b;
    const hi = r.a <= r.b ? r.b : r.a;
    const out: string[] = [];
    for (let d = lo; d <= hi; d = addDays(d, 1)) out.push(d);
    return out;
  };
  const highlight = modal ?? sel;
  const inHi = (date: string): boolean => {
    if (!highlight) return false;
    const lo = highlight.a <= highlight.b ? highlight.a : highlight.b;
    const hi = highlight.a <= highlight.b ? highlight.b : highlight.a;
    return date >= lo && date <= hi;
  };
  const modalDates = rangeOf(modal);

  // No auto-loading: start at 5 weeks and only extend when the user presses
  // "load more weeks".
  // Scroll the anchor week (today, or a selected plan's start) into view.
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const t = (root.querySelector("[data-today]") ?? root.querySelector("[data-anchor]")) as HTMLElement | null;
    if (t) t.scrollIntoView({ block: "start", behavior: "auto" });
  }, [weekStart]);

  return (
    <div ref={containerRef}>
      <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-7 gap-1.5">
        {dates.map((date, i) => {
          const its = sortItems(itemsByDate.get(date) ?? []);
          const city = cityForDay(date);
          const color = cityColor(city);
          const flag = cityFlag(city);
          const wx = city ? wxFor(date, city) : undefined;
          const dow = dayOfWeek(date);
          const isToday = date === todayStr;
          const isMonthStart = dayOfMonth(date) === 1;
          return (
            <div
              key={date}
              data-today={isToday ? "1" : undefined}
              data-anchor={i === 0 ? "1" : undefined}
              onMouseDown={() => {
                dragging.current = true;
                setSelection({ a: date, b: date });
              }}
              onMouseEnter={() => {
                if (dragging.current) setSelection({ a: selRef.current?.a ?? date, b: date });
              }}
              className={`group relative cursor-pointer transition-colors border rounded p-2 min-h-[116px] text-[11px] overflow-hidden ${
                its.length ? "bg-paper-warm/40" : "bg-paper-warm/10"
              } ${inHi(date) ? "border-rust ring-1 ring-rust/60" : isToday ? "border-rust" : "border-rule-light"}`}
              style={{ borderLeft: `4px solid ${color}` }}
            >
              <button
                title="add event"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setEditor({ date, slug: allByDate.get(date)?.[0]?.planSlug ?? defaultSlug });
                }}
                className="absolute top-1 right-1 z-10 w-4 h-4 leading-none rounded-full text-[12px] text-ink-4 opacity-0 group-hover:opacity-100 hover:text-rust hover:bg-paper-warm transition-opacity"
              >
                +
              </button>
              <div className="flex items-center gap-1 mb-1.5 flex-wrap">
                {isMonthStart && (
                  <span className="mono text-[8px] uppercase tracking-wider text-rust mr-0.5">
                    {MONTH_ABBR[monthIndex(date)]}
                  </span>
                )}
                <span className={`font-bold ${isToday ? "text-rust" : "text-ink"}`}>
                  {date.slice(5).replace("-", "/")}
                </span>
                <span className={`text-[10px] ${dow === 0 ? "text-rust" : dow === 6 ? "text-slate" : "text-ink-4"}`}>
                  {WEEKDAY[dow]}
                </span>
                {city && (
                  <span
                    className="ml-auto text-[8px] tracking-wide font-bold text-white px-1.5 py-0.5 rounded whitespace-nowrap flex items-center gap-1"
                    style={{ background: color }}
                  >
                    {flag && <span>{flag}</span>}
                    {city.toUpperCase()}
                  </span>
                )}
              </div>
              {wx && (
                <div className="text-[10px] text-ink-3 mb-1.5">
                  {wx.icon} {wx.hi}°/{wx.lo}°
                </div>
              )}
              <ul className="flex flex-col gap-1 list-none m-0 p-0">
                {its.map((it) => (
                  <li
                    key={it._id}
                    title="double-click to edit"
                    onMouseDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setEditor({ date: it.date, slug: it.planSlug, item: it });
                    }}
                    className="flex gap-1 leading-snug hover:text-rust"
                  >
                    {eventEmoji(it) && <span className="shrink-0">{eventEmoji(it)}</span>}
                    <span className={`flex-1 min-w-0 ${evKindCls(it)}`}>
                      {it.time && <b className="text-ink">{it.time} </b>}
                      {it.title}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      <div className="flex justify-center mt-3">
        <button
          onClick={() => setWeeks((w) => w + 5)}
          className="mono text-[10px] uppercase tracking-wider px-3 py-1 text-ink-4 hover:text-rust transition-colors rounded-full"
        >
          load more weeks
        </button>
      </div>

      {modal &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: "rgba(0,0,0,0.45)" }}
            onClick={() => setModal(null)}
          >
            <div className="panel max-w-lg w-full max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-3">
                <span className="mono text-[11px] uppercase tracking-wider text-rust">
                  {modalDates[0]?.replace(/-/g, "/")}
                  {modalDates.length > 1 ? ` → ${modalDates[modalDates.length - 1].replace(/-/g, "/")}` : ""}
                </span>
                <button
                  onClick={() => setModal(null)}
                  className="mono text-[10px] uppercase tracking-wider text-ink-4 hover:text-rust"
                >
                  close
                </button>
              </div>
              <div className="space-y-4">
                {modalDates.map((date) => {
                  const its = sortItems(allByDate.get(date) ?? []);
                  const city = cityForDay(date);
                  return (
                    <div key={date}>
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="font-bold text-ink text-[13px]">{date.replace(/-/g, "/")}</span>
                        <span className="mono text-[9px] text-ink-4">{WEEKDAY[dayOfWeek(date)]}</span>
                        {city && (
                          <span className="mono text-[9px] text-ink-4">
                            {cityFlag(city)} {city}
                          </span>
                        )}
                        <button
                          title="add event"
                          onClick={() => setEditor({ date, slug: its[0]?.planSlug ?? defaultSlug })}
                          className="ml-auto mono text-[10px] uppercase tracking-wider text-ink-4 hover:text-rust"
                        >
                          + add
                        </button>
                      </div>
                      {its.length === 0 ? (
                        <div className="mono text-[10px] text-ink-4 italic pl-1">no events.</div>
                      ) : (
                        <ul className="flex flex-col gap-2 list-none m-0 p-0 pl-1">
                          {its.map((it) => {
                            const arch = isArchived(it);
                            return (
                              <li key={it._id} className="group/ev flex gap-2 leading-snug text-[11px]">
                                {eventEmoji(it) && <span className="shrink-0">{eventEmoji(it)}</span>}
                                <span className={`flex-1 min-w-0 ${arch ? "opacity-40 line-through" : ""}`}>
                                  <span className={evKindCls(it)}>
                                    {it.time && <b className="text-ink">{it.time} </b>}
                                    {it.title}
                                  </span>
                                  {it.notes && <div className="text-ink-3 text-[10px] mt-0.5">{it.notes}</div>}
                                </span>
                                <span className="shrink-0 flex items-center gap-2 opacity-0 group-hover/ev:opacity-100 transition-opacity">
                                  <button
                                    title="edit"
                                    onClick={() => setEditor({ date: it.date, slug: it.planSlug, item: it })}
                                    className="mono text-[9px] uppercase tracking-wider text-ink-4 hover:text-rust"
                                  >
                                    edit
                                  </button>
                                  <button
                                    title={arch ? "restore" : "archive"}
                                    onClick={() => setArchived({ itemId: it._id, archived: !arch })}
                                    className="mono text-[9px] uppercase tracking-wider text-ink-4 hover:text-rust"
                                  >
                                    {arch ? "restore" : "archive"}
                                  </button>
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>,
          document.body,
        )}

      {editor && (
        <EventEditor
          state={editor}
          onClose={() => setEditor(null)}
          onCreate={createItem}
          onUpdate={updateItem}
          onDelete={deleteItem}
          onArchive={setArchived}
        />
      )}
    </div>
  );
}

// Add / edit a single calendar event. New when `state.item` is absent, else
// editing — which also exposes archive + delete.
function EventEditor({
  state,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
  onArchive,
}: {
  state: { date: string; slug: string; item?: Doc<"planItems"> };
  onClose: () => void;
  onCreate: (a: {
    slug: string;
    date: string;
    title: string;
    time?: string;
    location?: string;
    notes?: string;
  }) => Promise<unknown>;
  onUpdate: (a: {
    itemId: Id<"planItems">;
    title?: string;
    date?: string;
    time?: string;
    location?: string;
    notes?: string;
  }) => Promise<unknown>;
  onDelete: (a: { itemId: Id<"planItems"> }) => Promise<unknown>;
  onArchive: (a: { itemId: Id<"planItems">; archived: boolean }) => Promise<unknown>;
}) {
  const it = state.item;
  const [title, setTitle] = useState(it?.title ?? "");
  const [date, setDate] = useState(it?.date ?? state.date);
  const [time, setTime] = useState(it?.time ?? "");
  const [location, setLocation] = useState(it?.location ?? "");
  const [notes, setNotes] = useState(it?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const archived = it ? isArchived(it) : false;

  const save = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    const common = {
      title: title.trim(),
      date,
      time: time.trim() || undefined,
      location: location.trim() || undefined,
      notes: notes.trim() || undefined,
    };
    if (it) await onUpdate({ itemId: it._id, ...common });
    else await onCreate({ slug: state.slug, ...common });
    onClose();
  };

  const field =
    "w-full bg-paper-warm/40 border border-rule-light rounded px-2 py-1.5 text-[12px] text-ink focus:border-rust outline-none";
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onClick={onClose}
    >
      <div className="panel max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <span className="mono text-[11px] uppercase tracking-wider text-rust">{it ? "edit event" : "new event"}</span>
          <button onClick={onClose} className="mono text-[10px] uppercase tracking-wider text-ink-4 hover:text-rust">
            close
          </button>
        </div>
        <div className="flex flex-col gap-2">
          <input
            className={field}
            placeholder="title"
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="flex gap-2">
            <input className={field} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <input
              className={field}
              placeholder="time (e.g. 19:00)"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </div>
          <input
            className={field}
            placeholder="location (city)"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
          <textarea
            className={`${field} resize-none`}
            rows={3}
            placeholder="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-3 mt-4">
          <button
            onClick={save}
            disabled={!title.trim() || busy}
            className="droplet px-3 py-1.5 mono text-[10px] uppercase tracking-wider text-rust disabled:opacity-40"
          >
            {it ? "save" : "add"}
          </button>
          {it && (
            <>
              <button
                onClick={async () => {
                  await onArchive({ itemId: it._id, archived: !archived });
                  onClose();
                }}
                className="mono text-[10px] uppercase tracking-wider text-ink-4 hover:text-rust"
              >
                {archived ? "restore" : "archive"}
              </button>
              <button
                onClick={async () => {
                  await onDelete({ itemId: it._id });
                  onClose();
                }}
                className="ml-auto mono text-[10px] uppercase tracking-wider text-ink-4 hover:text-rust"
              >
                delete
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Lazily load Leaflet (free, no API key) from CDN once, shared across mounts.
let leafletPromise: Promise<unknown> | null = null;
function loadLeaflet(): Promise<unknown> {
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    if ((window as { L?: unknown }).L) {
      resolve((window as { L?: unknown }).L);
      return;
    }
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(css);
    const s = document.createElement("script");
    s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    s.onload = () => resolve((window as { L?: unknown }).L);
    s.onerror = () => reject(new Error("leaflet load failed"));
    document.head.appendChild(s);
  });
  return leafletPromise;
}
// Parse a plan's free-form `location` ("Seoul / Shenzhen / Tokyo") into the
// known cities it names.
function citiesFromText(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(/[\/,·]/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => cityMeta(s));
}

// Map of visited places: one flag marker per visited known city. Cities come
// from item locations AND each plan's location field, so conferences whose
// items only carry room names (e.g. ICLR Rio) still register. The map auto-loads
// and fits all markers (whole-world view); two-finger / wheel zoom is enabled.
// Below it, travel records (flights) list as cards with the destination flag.
function PlanMap({ items, plans }: { items: Doc<"planItems">[]; plans: { location?: string }[] }) {
  const divRef = useRef<HTMLDivElement>(null);

  const visited = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) {
      const loc = it.location?.toLowerCase();
      if (loc && cityMeta(loc)) set.add(loc);
    }
    for (const p of plans) for (const c of citiesFromText(p.location)) set.add(c);
    // Collapse alias keys (hongkong / hong kong) by canonical coords+flag.
    const seen = new Map<string, { city: string; meta: CityMeta }>();
    for (const city of set) {
      const meta = cityMeta(city)!;
      const key = `${meta.coords[0]},${meta.coords[1]}`;
      if (!seen.has(key)) seen.set(key, { city, meta });
    }
    return [...seen.values()];
  }, [items, plans]);

  const flights = useMemo(
    () =>
      items
        .filter((it) => it.tags.some((t) => t.toLowerCase() === "flight"))
        .slice()
        .sort((a, b) => a.date.localeCompare(b.date) || (a.timeStart ?? "").localeCompare(b.timeStart ?? "")),
    [items],
  );

  // Re-init only when the SET of cities changes, not on every parent re-render
  // (selecting an itinerary recreates the plans array, which would otherwise
  // tear down and rebuild the whole map = a visible flash).
  const visitedKey = visited.map((v) => v.city).join(",");

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let map: any = null;
    let cancelled = false;
    let ro: ResizeObserver | null = null;
    loadLeaflet()
      .then((L: unknown) => {
        if (cancelled || !divRef.current) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const Lx = L as any;
        // World bounds (web-mercator clamps latitude at ~85.05). Used for the
        // min-zoom clamp + fit fallback.
        const world = Lx.latLngBounds([
          [-85.05113, -180],
          [85.05113, 180],
        ]);
        // Clamp ONLY latitude (no gray top/bottom) while leaving longitude
        // effectively unbounded, so the map repeats infinitely left-right.
        const latClamp = Lx.latLngBounds([
          [-85.05113, -100000],
          [85.05113, 100000],
        ]);
        map = Lx.map(divRef.current, {
          scrollWheelZoom: true,
          attributionControl: false,
          worldCopyJump: true,
          maxBounds: latClamp,
          maxBoundsViscosity: 1,
        });
        Lx.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
          maxZoom: 20,
          subdomains: "abcd",
          detectRetina: true,
        }).addTo(map);
        const latlngs: [number, number][] = [];
        for (const v of visited) {
          const [lat, lng] = v.meta.coords;
          latlngs.push([lat, lng]);
          const icon = Lx.divIcon({
            html: `<span style="font-size:20px;filter:drop-shadow(0 1px 1px rgba(0,0,0,.35))">${v.meta.flag}</span>`,
            className: "",
            iconSize: [24, 24],
            iconAnchor: [12, 12],
          });
          Lx.marker([lat, lng], { icon }).addTo(map).bindTooltip(`${v.meta.flag} ${v.city}`, { permanent: false });
        }
        const clamp = () => {
          if (!map) return;
          // Smallest zoom whose viewport still fits INSIDE the world = no gray.
          map.setMinZoom(map.getBoundsZoom(world, true));
        };
        const fit = () => {
          if (!map) return;
          clamp();
          if (latlngs.length === 1) map.setView(latlngs[0], 4);
          else if (latlngs.length > 1) map.fitBounds(latlngs, { padding: [50, 50] });
          else map.fitBounds(world);
        };
        fit();
        // Leaflet renders a broken tile grid if the container had no size at
        // init (panel / flex / anim layout): recompute across a few frames and
        // again whenever the container resizes.
        for (const d of [50, 250, 600]) setTimeout(() => map && (map.invalidateSize(), fit()), d);
        if (divRef.current && "ResizeObserver" in window) {
          ro = new ResizeObserver(() => map && (map.invalidateSize(), clamp()));
          ro.observe(divRef.current);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (ro) ro.disconnect();
      if (map) map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visitedKey]);

  return (
    <div>
      <div
        ref={divRef}
        className="w-full rounded overflow-hidden bg-paper-warm/20"
        style={{ height: "min(70vh, 560px)" }}
      />
      <div className="flex flex-wrap gap-3 mt-3">
        {visited.map((v) => (
          <span key={v.city} className="mono text-[10px] text-ink-3 flex items-center gap-1">
            <span className="w-2 h-2 rounded-full inline-block" style={{ background: v.meta.flagColor }} />
            {v.meta.flag} {v.city}
          </span>
        ))}
      </div>

      {flights.length > 0 && (
        <div className="mt-5">
          <div className="mono text-[10px] uppercase tracking-wider text-ink-4 mb-2">
            travel records · {flights.length} flights
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {flights.map((f) => {
              const dest = flightDestCity(f.title) ?? (f.location && cityMeta(f.location) ? f.location : undefined);
              const flag = dest ? cityFlag(dest) : "";
              const endTag = f.tags.find((t) => /^end:/i.test(t));
              const end = endTag ? endTag.slice(4) : undefined;
              const range =
                end && end !== f.date
                  ? `${f.date.replace(/-/g, "/")} – ${end.replace(/-/g, "/")}`
                  : f.date.replace(/-/g, "/");
              return (
                <div key={f._id} className="border border-rule-light rounded p-2.5 bg-paper-warm/30">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="shrink-0">{flag || "✈"}</span>
                    <span className="font-bold text-ink text-[12px]">{range}</span>
                    {f.time && <span className="mono text-[10px] text-sage">{f.time}</span>}
                  </div>
                  <div className="text-[11px] text-ink-2">{f.title}</div>
                  {f.notes && <div className="text-[10px] text-ink-4 mt-0.5">{f.notes}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function extractThemes(theme?: string): string[] {
  if (!theme) return [];
  return theme
    .split(/[·,\s\/]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => (s.length > 2 && s !== "interp" ? s.length > 2 : true))
    .filter((s, i, arr) => arr.indexOf(s) === i);
}

function toMinutes(t?: string): number | null {
  if (!t) return null;
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1]) * 60 + parseInt(m[2]);
}

function scoreEvent(event: Doc<"planItems">, themes: string[]): number {
  const text = `${event.title} ${event.tags.join(" ")} ${event.notes ?? ""}`.toLowerCase();
  let score = 0;
  for (const t of themes) {
    if (text.includes(t)) score += 1;
  }
  if (event.tier === 0) score += 100;
  else if (event.tier === 1) score += 10;
  else if (event.tier === 2) score += 3;
  return score;
}

function DayBlock({
  day,
  items,
  onToggle,
  themes,
  city,
  wx,
  defaultExpanded,
}: {
  day: Doc<"planDays">;
  items: Doc<"planItems">[];
  onToggle: (id: Id<"planItems">) => void;
  themes: string[];
  city?: string;
  wx?: DayWx;
  defaultExpanded?: boolean;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [expanded, setExpanded] = useState(defaultExpanded ?? day.date === today);
  const events = items
    .filter((it) => it.kind === "event")
    .sort((a, b) => {
      if (a.timeStart && b.timeStart) return a.timeStart.localeCompare(b.timeStart);
      if (a.timeStart) return -1;
      if (b.timeStart) return 1;
      return a.order - b.order;
    });
  const todos = items.filter((it) => it.kind === "todo");
  const doneCount = events.filter((e) => e.done).length;

  // Detect time-overlapping event groups and pick recommended (highest score)
  const groupByOverlap: { group: number; recommended: boolean }[] = new Array(events.length).fill(null).map(() => ({
    group: -1,
    recommended: false,
  }));
  {
    let groupId = 0;
    const assigned = new Set<number>();
    for (let i = 0; i < events.length; i++) {
      if (assigned.has(i)) continue;
      const e = events[i];
      const start = toMinutes(e.timeStart);
      if (start === null) continue;
      const groupMembers = [i];
      for (let j = i + 1; j < events.length; j++) {
        if (assigned.has(j)) continue;
        const e2 = events[j];
        const s2 = toMinutes(e2.timeStart);
        if (s2 === null) continue;
        const e2End = toMinutes(e2.timeEnd) ?? s2 + 60;
        // check overlap against any current member
        const overlaps = groupMembers.some((mi) => {
          const mStart = toMinutes(events[mi].timeStart)!;
          const mEnd = toMinutes(events[mi].timeEnd) ?? mStart + 60;
          return s2 < mEnd && mStart < e2End;
        });
        if (overlaps) groupMembers.push(j);
      }
      if (groupMembers.length > 1) {
        const scored = groupMembers.map((mi) => ({ mi, score: scoreEvent(events[mi], themes) }));
        scored.sort((a, b) => b.score - a.score);
        const recIdx = scored[0].mi;
        for (const mi of groupMembers) {
          groupByOverlap[mi] = { group: groupId, recommended: mi === recIdx };
          assigned.add(mi);
        }
        groupId++;
      }
    }
  }

  return (
    <div className="pb-4 border-b border-rule-light">
      <div className="flex items-baseline gap-3 mb-2">
        <h2 className="font-serif text-lg text-ink">{day.date}</h2>
        {day.dayLabel && <span className="mono text-xs text-ink-3">{day.dayLabel}</span>}
        {city && <span className="mono text-[10px] uppercase tracking-wide text-ink-3">{city}</span>}
        {wx && (
          <span className="mono text-[10px] text-ink-3">
            {wx.icon} {wx.hi}°/{wx.lo}°
          </span>
        )}
        <DaySyncButton planSlug={day.planSlug} date={day.date} />
      </div>
      {day.summary && <div className="text-ink-3 text-xs italic mb-3">{day.summary}</div>}

      {todos.length > 0 && (
        <div className="mb-3">
          <div className="space-y-0.5">
            {todos.map((it) => (
              <div key={it._id} className="flex items-start gap-2 pl-1">
                <button
                  onClick={() => onToggle(it._id)}
                  className="mt-0.5 text-ink-3 hover:text-rust transition-colors"
                >
                  {it.done ? <Check size={12} /> : <Circle size={12} />}
                </button>
                <span className={`text-xs ${it.done ? "line-through text-ink-4" : "text-ink-2"}`}>{it.title}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {events.length > 0 && (
        <div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1.5 mono text-[10px] text-ink-4 hover:text-ink-2 uppercase tracking-wider mb-1 transition-colors"
          >
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            <span>
              Events {events.length} · done {doneCount}
            </span>
          </button>
          {expanded && (
            <div className="space-y-1">
              {events.map((it, idx) => {
                const conf = groupByOverlap[idx];
                const inConflict = conf.group >= 0;
                const isRecommended = conf.recommended;
                return (
                  <div
                    key={it._id}
                    className={`pl-3 py-1.5 pr-2 flex items-start gap-2 ${TIER_STYLES[it.tier ?? 3] || ""} ${
                      isRecommended ? "ring-1 ring-sage" : ""
                    }`}
                  >
                    <button
                      onClick={() => onToggle(it._id)}
                      className="mt-0.5 text-ink-3 hover:text-rust transition-colors"
                      title={it.done ? "Mark as not done" : "Mark as done"}
                    >
                      {it.done ? <Check size={12} /> : <Circle size={12} />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        {eventEmoji(it) && <span className="shrink-0">{eventEmoji(it)}</span>}
                        {it.time && <span className="mono text-[11px] text-ink-2 shrink-0">{it.time}</span>}
                        <span className={`text-sm ${it.done ? "line-through text-ink-4" : "text-ink"}`}>
                          {it.title}
                        </span>
                        {it.tier !== undefined && <span className="mono text-[9px] text-ink-4">T{it.tier}</span>}
                        {inConflict && (
                          <span
                            className={`mono text-[9px] px-1 rounded ${
                              isRecommended ? "bg-sage text-paper" : "text-ink-4"
                            }`}
                          >
                            {isRecommended ? "★ pick" : "conflict"}
                          </span>
                        )}
                        {it.location && (
                          <span className="mono text-[10px] text-ink-4 flex items-center gap-0.5">
                            <MapPin size={8} /> {it.location}
                          </span>
                        )}
                      </div>
                      {it.notes && <div className="mono text-[10px] text-ink-3 mt-0.5">{it.notes}</div>}
                      {it.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {it.tags.map((t) => (
                            <span key={t} className="mono text-[9px] text-ink-4 bg-paper-warm px-1 rounded">
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
