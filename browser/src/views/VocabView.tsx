import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { localDate } from "../shared/date";

// The browser reaches for the Web Notifications API and nothing else. There
// used to be a second branch here for the Tauri shell; the phone client is a
// native app now (ios/), so the shell and its plugin are gone.
async function ensureNotifyPermission(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  return (await Notification.requestPermission()) === "granted";
}

async function fireNotification(title: string, body: string): Promise<void> {
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    new Notification(title, { body, tag: "vocab-due" });
  }
}

// Vocab tab: EN/JP expression study with spaced repetition. Review the due
// queue (flip to reveal, grade again/good/easy), add new phrases, browse all.
export function VocabView({ focusId }: { focusId?: string | null }) {
  // The scheduler's day boundary has to be the one the user is living in: the
  // Convex server would otherwise answer on its UTC day, which is still
  // yesterday for the first nine hours of every KST day.
  const today = localDate(new Date());
  const dueData = useQuery(api.expressions.due, { today });
  const all = useQuery(api.expressions.list, {});
  const addExpr = useMutation(api.expressions.add);
  const reviewExpr = useMutation(api.expressions.review);
  const removeExpr = useMutation(api.expressions.remove);
  const settings = useQuery(api.settings.get, {});
  const setNotion = useMutation(api.settings.setNotion);
  const exportVocab = useAction(api.notion.exportVocab);
  const importFromNotion = useAction(api.notion.importVocabFromNotion);

  const [reviewing, setReviewing] = useState(false);
  const [flipped, setFlipped] = useState(false);
  // A word tapped in the digest has to land on its own row. The deck runs to
  // hundreds of entries, so the row is scrolled to and marked; without the
  // mark the reader arrives somewhere in a list and has to search again for
  // the word they just tapped.
  const focusRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!focusId || !all) return;
    focusRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusId, all]);
  const [form, setForm] = useState({ en: "", jp: "", reading: "", meaning: "", example: "" });
  const [dbId, setDbId] = useState("");
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  useEffect(() => {
    if (settings?.notion?.databaseId != null) setDbId(settings.notion.databaseId);
  }, [settings?.notion?.databaseId]);

  const doExport = async () => {
    if (!dbId.trim()) return;
    setExportMsg("exporting...");
    try {
      await setNotion({ databaseId: dbId.trim() });
      const r = await exportVocab({ databaseId: dbId.trim() });
      setExportMsg(`exported ${r.count} to Notion`);
    } catch (e) {
      setExportMsg(`error: ${String((e as Error).message).slice(0, 60)}`);
    }
  };

  // Memorization reminders: fire a local notification when cards are due (on
  // mount + hourly). Native (Tauri iOS) notifications in the native client,
  // Web Notifications in the browser / installed PWA.
  const [remind, setRemind] = useState(() => localStorage.getItem("vocab:remind") === "1");
  const dueCount = dueData?.dueCount ?? 0;
  useEffect(() => {
    if (!remind || dueCount === 0) return;
    const fire = () => fireNotification("Openworks vocab", `${dueCount} expressions due for review`);
    fire();
    const t = setInterval(fire, 60 * 60_000);
    return () => clearInterval(t);
  }, [remind, dueCount]);

  const toggleRemind = async () => {
    if (!remind && !(await ensureNotifyPermission())) return;
    const next = !remind;
    setRemind(next);
    localStorage.setItem("vocab:remind", next ? "1" : "0");
  };

  const dueCards = dueData?.due ?? [];
  const card = reviewing ? dueCards[0] : undefined;

  const grade = async (g: "again" | "good" | "easy") => {
    if (!card) return;
    await reviewExpr({ id: card._id, grade: g, today });
    setFlipped(false);
  };

  const submit = async () => {
    if (!form.en.trim()) return;
    await addExpr({
      en: form.en.trim(),
      jp: form.jp.trim() || undefined,
      reading: form.reading.trim() || undefined,
      meaning: form.meaning.trim() || undefined,
      example: form.example.trim() || undefined,
      today,
    });
    setForm({ en: "", jp: "", reading: "", meaning: "", example: "" });
  };

  // Bulk import: one expression per line. "en" alone auto-enriches; or use
  // "en | jp | meaning" to supply fields. Empty lines skipped.
  const [bulk, setBulk] = useState("");
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const bulkImport = async () => {
    const lines = bulk
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return;
    setBulkMsg(`importing ${lines.length}…`);
    let imported = 0;
    for (const line of lines) {
      const [en, jp, meaning] = line.split("|").map((s) => s.trim());
      if (!en) continue;
      await addExpr({ en, jp: jp || undefined, meaning: meaning || undefined, today });
      imported += 1;
    }
    setBulk("");
    // Lines with no English side are dropped, so report the rows that landed
    // rather than the rows that were read.
    const skipped = lines.length - imported;
    setBulkMsg(`imported ${imported}${skipped ? `, skipped ${skipped} with no English side` : ""}`);
  };

  // Import every expression from a Notion page (all databases inside it) or a
  // single database. Titles land as expressions and the worker enriches them.
  const [notionPage, setNotionPage] = useState("");
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const doNotionImport = async () => {
    if (!notionPage.trim()) return;
    setImportMsg("importing…");
    try {
      const r = await importFromNotion({ pageId: notionPage.trim() });
      setImportMsg(
        `imported ${r.imported} new from ${r.databases} db${r.databases === 1 ? "" : "s"} (${r.found} found${r.truncated ? ", truncated" : ""})`,
      );
      setNotionPage("");
    } catch (e) {
      setImportMsg(`error: ${String((e as Error).message).slice(0, 80)}`);
    }
  };

  const field =
    "bg-paper-warm/40 border border-rule-light rounded px-2 py-1.5 text-[12px] text-ink focus:border-rust outline-none";

  return (
    <div className="panel anim d2">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <span className="mono text-[11px] tracking-wider text-rust">
          {dueData?.dueCount ?? 0} due · {dueData?.total ?? 0} total
        </span>
        <button
          onClick={toggleRemind}
          title="Notify when expressions are due (PWA / home-screen app)"
          className={`mono text-[10px] tracking-wider ${remind ? "text-rust" : "text-ink-4 hover:text-rust"}`}
        >
          {remind ? "🔔 reminders on" : "remind me"}
        </button>
        {!reviewing ? (
          <button
            onClick={() => {
              setReviewing(true);
              setFlipped(false);
            }}
            disabled={(dueData?.dueCount ?? 0) === 0}
            className="droplet ml-auto px-3 py-1.5 mono text-[10px] tracking-wider text-rust disabled:opacity-40"
          >
            start review
          </button>
        ) : (
          <button
            onClick={() => setReviewing(false)}
            className="ml-auto mono text-[10px] tracking-wider text-ink-4 hover:text-rust"
          >
            end review
          </button>
        )}
      </div>

      {reviewing && (
        <div className="border border-rule-light rounded p-6 bg-paper-warm/30 mb-6 text-center">
          {!card ? (
            <div className="mono text-[12px] text-sage py-6">All caught up. Nothing due.</div>
          ) : (
            <>
              <div className="text-[24px] font-bold text-ink mb-1">{card.jp || card.en}</div>
              {flipped ? (
                <div className="mt-3 space-y-1">
                  {card.jp && <div className="text-[15px] text-ink">{card.en}</div>}
                  {card.reading && <div className="text-[12px] text-sage mono">{card.reading}</div>}
                  {card.meaning && <div className="text-[12px] text-ink-2 mt-1">{card.meaning}</div>}
                  {card.example && <div className="text-[11px] text-ink-4 italic mt-1">{card.example}</div>}
                  <div className="flex justify-center gap-2 mt-4">
                    {(["again", "good", "easy"] as const).map((g) => (
                      <button
                        key={g}
                        onClick={() => grade(g)}
                        className="droplet px-3 py-1.5 mono text-[10px] tracking-wider text-rust"
                      >
                        {g}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setFlipped(true)}
                  className="mt-4 mono text-[10px] tracking-wider text-ink-4 hover:text-rust"
                >
                  show answer
                </button>
              )}
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
        <input
          className={field}
          placeholder="English"
          value={form.en}
          onChange={(e) => setForm({ ...form, en: e.target.value })}
        />
        <input
          className={field}
          placeholder="日本語 (optional)"
          value={form.jp}
          onChange={(e) => setForm({ ...form, jp: e.target.value })}
        />
        <input
          className={field}
          placeholder="reading / romaji"
          value={form.reading}
          onChange={(e) => setForm({ ...form, reading: e.target.value })}
        />
        <input
          className={field}
          placeholder="meaning / note"
          value={form.meaning}
          onChange={(e) => setForm({ ...form, meaning: e.target.value })}
        />
        <input
          className={`${field} sm:col-span-2`}
          placeholder="example sentence"
          value={form.example}
          onChange={(e) => setForm({ ...form, example: e.target.value })}
        />
      </div>
      <button
        onClick={submit}
        disabled={!form.en.trim()}
        className="droplet px-3 py-1.5 mono text-[10px] tracking-wider text-rust disabled:opacity-40 mb-4"
      >
        + add expression
      </button>

      <details className="mb-6">
        <summary className="mono text-[10px] tracking-wider text-ink-4 hover:text-rust cursor-pointer">
          bulk import
        </summary>
        <textarea
          className={`${field} w-full resize-none mt-2`}
          rows={4}
          placeholder={"one per line — just English (auto-fills), or  en | jp | meaning"}
          value={bulk}
          onChange={(e) => setBulk(e.target.value)}
        />
        <div className="flex items-center gap-2 mt-1">
          <button
            onClick={bulkImport}
            disabled={!bulk.trim()}
            className="mono text-[10px] tracking-wider text-ink-4 hover:text-rust disabled:opacity-40"
          >
            import
          </button>
          {bulkMsg && <span className="mono text-[9px] text-sage">{bulkMsg}</span>}
        </div>
      </details>

      <details className="mb-6">
        <summary className="mono text-[10px] tracking-wider text-ink-4 hover:text-rust cursor-pointer">
          import from notion
        </summary>
        <input
          className={`${field} w-full mt-2`}
          placeholder="Notion page or database UUID — a page pulls in every database inside it"
          value={notionPage}
          onChange={(e) => setNotionPage(e.target.value)}
        />
        <div className="flex items-center gap-2 mt-1">
          <button
            onClick={doNotionImport}
            disabled={!notionPage.trim()}
            className="mono text-[10px] tracking-wider text-ink-4 hover:text-rust disabled:opacity-40"
          >
            import
          </button>
          {importMsg && <span className="mono text-[9px] text-sage">{importMsg}</span>}
        </div>
      </details>

      <ul className="flex flex-col gap-1.5 list-none m-0 p-0">
        {(all ?? []).map((x) => (
          <li
            key={x._id}
            ref={x._id === focusId ? focusRef : undefined}
            className={`group flex gap-3 items-center border rounded p-2 text-[12px] ${
              x._id === focusId ? "border-rust/50 bg-rust/10" : "border-rule-light bg-paper-warm/20"
            }`}
          >
            {/* `en` is the entry and `jp` is generated from it by the worker,
                so leading with the Japanese put a derived field above the row
                it was derived from and made an English deck read as a
                Japanese one. */}
            <span className="font-bold text-ink shrink-0">{x.en}</span>
            {x.jp && <span className="text-ink-3">{x.jp}</span>}
            {x.meaning && <span className="text-ink-4 truncate">{x.meaning}</span>}
            {x.pendingEnrich && <span className="mono text-[9px] text-sage shrink-0">enriching…</span>}
            <span className="mono text-[9px] text-ink-4 ml-auto shrink-0">due {x.due.slice(5)}</span>
            <button
              onClick={() => removeExpr({ id: x._id })}
              className="mono text-[9px] tracking-wider text-ink-4 hover:text-rust opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
            >
              del
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-6 pt-4 border-t border-rule-light flex items-center gap-2 flex-wrap">
        <span className="mono text-[9px] tracking-wider text-ink-4">Notion DB</span>
        <input
          className={`${field} flex-1 min-w-[180px]`}
          placeholder="Notion database id"
          value={dbId}
          onChange={(e) => setDbId(e.target.value)}
        />
        <button
          onClick={doExport}
          disabled={!dbId.trim()}
          className="mono text-[10px] tracking-wider text-ink-4 hover:text-rust disabled:opacity-40"
        >
          export to Notion
        </button>
        {exportMsg && <span className="mono text-[9px] text-sage">{exportMsg}</span>}
      </div>
    </div>
  );
}
