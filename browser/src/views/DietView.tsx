import { useState, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { localDate, addDays } from "../shared/date";
import { BlockSkeleton } from "../shared/ui";

// Diet tab: log a food photo (worker agent identifies it + estimates calories
// and macros), see the day's running totals, and a recent-days kcal trend.
export function DietView() {
  const [date, setDate] = useState(() => localDate(new Date()));
  const dayData = useQuery(api.diet.listByDate, { date });
  const trend = useQuery(api.diet.dailyTotals, { from: addDays(date, -13), to: date });
  const genUrl = useMutation(api.diet.generateUploadUrl);
  const createEntry = useMutation(api.diet.createEntry);
  const removeEntry = useMutation(api.diet.remove);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [nameInput, setNameInput] = useState("");

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const url = await genUrl({});
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": file.type }, body: file });
      const { storageId } = await res.json();
      await createEntry({ imageId: storageId, date });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // Log by name (no photo): the worker estimates kcal/macros from the name.
  const logByName = async () => {
    if (!nameInput.trim()) return;
    await createEntry({ date, name: nameInput.trim() });
    setNameInput("");
  };

  // undefined is the query in flight, not an empty day: showing the zeroed
  // totals and "no food logged" for it flashes a wrong answer before the real
  // one lands. The trend is a second query with its own arrival time, so it
  // needs its own flag or it claims "no history yet" while still loading.
  const loading = dayData === undefined;
  const trendLoading = trend === undefined;
  const totals = dayData?.totals ?? { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  const entries = dayData?.entries ?? [];
  const days = trend ?? [];
  const maxKcal = Math.max(1, ...days.map((d) => d.kcal));

  return (
    <div className="panel anim d2">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="bg-paper-warm/40 border border-rule-light rounded px-2 py-1.5 text-[12px] text-ink focus:border-rust outline-none"
        />
        <button
          onClick={() => setDate(localDate(new Date()))}
          className="mono text-[10px] uppercase tracking-wider text-ink-4 hover:text-rust"
        >
          today
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
        />
        <input
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && logByName()}
          placeholder="or type a food name…"
          className="ml-auto bg-paper-warm/40 border border-rule-light rounded px-2 py-1.5 text-[12px] text-ink focus:border-rust outline-none min-w-[160px]"
        />
        <button
          onClick={logByName}
          disabled={!nameInput.trim()}
          className="mono text-[10px] uppercase tracking-wider text-ink-4 hover:text-rust disabled:opacity-40"
        >
          + log
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="droplet px-3 py-1.5 mono text-[10px] uppercase tracking-wider text-rust disabled:opacity-40"
        >
          {busy ? "uploading..." : "+ photo"}
        </button>
      </div>

      <div className="flex flex-wrap gap-4 mb-5">
        {(
          [
            ["kcal", Math.round(totals.kcal), "kcal"],
            ["protein", Math.round(totals.protein), "g protein"],
            ["carbs", Math.round(totals.carbs), "g carbs"],
            ["fat", Math.round(totals.fat), "g fat"],
          ] as const
        ).map(([k, val, label]) => (
          <div key={k} className="flex-1 min-w-[100px] border border-rule-light rounded p-3 bg-paper-warm/30">
            <div className="text-[22px] font-bold text-ink leading-none">{loading ? "…" : val}</div>
            <div className="mono text-[9px] uppercase tracking-wider text-ink-4 mt-1">{label}</div>
          </div>
        ))}
      </div>

      {loading && <BlockSkeleton rows={3} className="mb-6" />}

      <ul className="flex flex-col gap-2 list-none m-0 p-0 mb-6">
        {loading ? null : entries.length === 0 ? (
          <li className="mono text-[11px] text-ink-4 italic py-4">no food logged for this day.</li>
        ) : (
          entries.map((e) => <DietEntryRow key={e._id} entry={e} onRemove={() => removeEntry({ entryId: e._id })} />)
        )}
      </ul>

      <div className="mono text-[10px] uppercase tracking-wider text-ink-4 mb-2">last 14 days · kcal</div>
      <div className="flex items-end gap-1 h-24">
        {trendLoading ? (
          <BlockSkeleton rows={2} className="w-full self-center" />
        ) : days.length === 0 ? (
          <span className="mono text-[10px] text-ink-4 italic">no history yet.</span>
        ) : (
          days.map((d) => (
            <div
              key={d.date}
              className="flex-1 flex flex-col items-center gap-1"
              title={`${d.date}: ${Math.round(d.kcal)} kcal`}
            >
              <div
                className="w-full rounded-t bg-rust/60"
                style={{ height: `${Math.max(2, (d.kcal / maxKcal) * 80)}px` }}
              />
              <span className="mono text-[7px] text-ink-4">{d.date.slice(5)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function DietEntryRow({ entry, onRemove }: { entry: Doc<"foodEntries">; onRemove: () => void }) {
  const img = useQuery(api.diet.imageUrl, entry.imageId ? { entryId: entry._id } : "skip");
  return (
    <li className="group flex gap-3 items-center border border-rule-light rounded p-2.5 bg-paper-warm/30">
      {img ? (
        <img src={img} alt="" className="w-12 h-12 rounded object-cover shrink-0" />
      ) : (
        <div className="w-12 h-12 rounded bg-paper-warm/60 shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-[12px] font-bold text-ink truncate">
          {entry.name ?? (entry.status === "done" ? "Unknown food" : "…")}
          {entry.status !== "done" && <span className="mono text-[9px] text-sage ml-2 uppercase">{entry.status}</span>}
        </div>
        <div className="text-[11px] text-ink-2">
          {entry.kcal != null ? `${Math.round(entry.kcal)} kcal` : "analyzing…"}
          {entry.protein != null && ` · P ${Math.round(entry.protein)}g`}
          {entry.carbs != null && ` · C ${Math.round(entry.carbs)}g`}
          {entry.fat != null && ` · F ${Math.round(entry.fat)}g`}
        </div>
        {entry.notes && <div className="text-[10px] text-ink-4 mt-0.5 line-clamp-2">{entry.notes}</div>}
      </div>
      <button
        onClick={onRemove}
        className="mono text-[9px] uppercase tracking-wider text-ink-4 hover:text-rust opacity-0 group-hover:opacity-100 transition-opacity"
      >
        delete
      </button>
    </li>
  );
}
