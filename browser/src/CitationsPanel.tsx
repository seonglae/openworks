// CitationsPanel — per-research bib citations + per-row promote-to-paper.
// Worker.mts (handleCitations) reads each host's bib file, parses entries,
// and upserts them into researchCitations. Clicking + on a row asks the
// worker to extract PDF text (if pdfRelPath exists) and create a paper row.

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { RefreshCw, Plus, Loader2, FileText, ExternalLink } from "lucide-react";

export function CitationsPanel({ researchSlug }: { researchSlug: string }) {
  const citations = useQuery(api.researchCitations.list, { researchSlug });
  const latest = useQuery(api.researchCitations.latestForResearch, { researchSlug });
  const requestSync = useMutation(api.researchCitations.requestSync);
  const requestPromote = useMutation(api.researchCitations.requestPromote);
  const [promoting, setPromoting] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);

  const onSync = async () => {
    setSyncing(true);
    try {
      await requestSync({ researchSlug });
    } finally {
      setSyncing(false);
    }
  };

  const onPromote = async (key: string) => {
    setPromoting((s) => new Set(s).add(key));
    try {
      await requestPromote({ researchSlug, citationKey: key });
    } finally {
      // Leave optimistic-pending flag until the row gets re-rendered.
      setTimeout(() => {
        setPromoting((s) => {
          const n = new Set(s);
          n.delete(key);
          return n;
        });
      }, 1500);
    }
  };

  const workerBusy = latest?.status === "pending";

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="mono text-[10px] text-ink-4">
          citations {citations?.length !== undefined ? `(${citations.length})` : ""}
        </div>
        <button
          onClick={onSync}
          disabled={syncing || workerBusy}
          className="mono text-[10px] text-ink-3 hover:text-ink-2 disabled:text-ink-4 px-1.5 py-0.5 flex items-center gap-1"
          title="Re-read references.bib from this host"
        >
          {syncing || workerBusy ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
          sync bib
        </button>
      </div>
      {latest?.status === "error" && <div className="mono text-[10px] text-red-500 mb-1">{latest.error}</div>}
      {citations === undefined ? (
        <div className="space-y-1" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-2.5 bg-paper-warm/60 animate-pulse rounded"
              style={{ width: `${100 - i * 8}%` }}
            />
          ))}
        </div>
      ) : citations.length === 0 ? (
        <div className="mono text-[10px] text-ink-4 italic">
          no citations yet. set a host with bibRelPath, then sync.
        </div>
      ) : (
        <div className="space-y-0.5 max-h-64 overflow-y-auto">
          {citations.map((c) => (
            <div key={c._id} className="flex items-start gap-2 text-xs py-0.5">
              <button
                onClick={() => onPromote(c.key)}
                disabled={promoting.has(c.key)}
                className="mono text-[10px] text-rust hover:bg-rust-dim disabled:text-ink-4 shrink-0 px-1 mt-0.5"
                title={c.pdfRelPath ? `add as paper (with text from ${c.pdfRelPath})` : "add as paper"}
              >
                {promoting.has(c.key) ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />}
              </button>
              <span className="mono text-[10px] text-ink-4 w-[36px] shrink-0 truncate">{c.year ?? ""}</span>
              <span className="text-ink-2 flex-1 truncate" title={c.title}>
                {c.title || c.key}
              </span>
              {c.pdfRelPath && (
                <span className="mono text-[10px] text-ink-4 shrink-0" title={c.pdfRelPath}>
                  <FileText size={10} className="inline" />
                </span>
              )}
              {c.url && (
                <a
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mono text-[10px] text-ink-3 hover:text-rust shrink-0"
                >
                  <ExternalLink size={10} className="inline" />
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function HostSetup({ researchSlug }: { researchSlug: string }) {
  const hosts = useQuery(api.researchHosts.listHosts, { researchSlug });
  const setHost = useMutation(api.researchHosts.setHostForResearch);
  const removeHost = useMutation(api.researchHosts.removeHost);
  const [open, setOpen] = useState(false);
  const [machineId, setMachineId] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [bibRelPath, setBibRelPath] = useState("");
  const [saving, setSaving] = useState(false);

  const onSave = async () => {
    if (!machineId.trim() || !rootPath.trim()) return;
    setSaving(true);
    try {
      await setHost({
        researchSlug,
        machineId: machineId.trim(),
        rootPath: rootPath.trim(),
        bibRelPath: bibRelPath.trim() || undefined,
      });
      setMachineId("");
      setRootPath("");
      setBibRelPath("");
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="mono text-[10px] text-ink-4">
          hosts {hosts?.length !== undefined ? `(${hosts.length})` : ""}
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="mono text-[10px] text-ink-3 hover:text-ink-2 px-1.5 py-0.5"
        >
          {open ? "cancel" : "+ host"}
        </button>
      </div>
      <div className="space-y-1">
        {(hosts ?? []).map((h) => (
          <div key={h.machineId} className="flex items-center gap-2 text-xs">
            <span className="mono text-[10px] text-ink-3 w-[100px] truncate" title={h.machineId}>
              {h.machineId}
            </span>
            <span className="text-ink-2 flex-1 truncate mono text-[11px]" title={h.rootPath}>
              {h.rootPath}
            </span>
            {h.bibRelPath && (
              <span className="mono text-[10px] text-ink-4 shrink-0 truncate" title={h.bibRelPath}>
                bib: {h.bibRelPath}
              </span>
            )}
            <button
              onClick={() => removeHost({ researchSlug, machineId: h.machineId })}
              className="mono text-[10px] text-ink-4 hover:text-red-500"
            >
              remove
            </button>
          </div>
        ))}
        {open && (
          <div className="flex items-center gap-1 flex-wrap mt-1">
            <input
              type="text"
              placeholder="machineId (e.g. macbook)"
              value={machineId}
              onChange={(e) => setMachineId(e.target.value)}
              className="mono text-[11px] px-1.5 py-0.5 bg-transparent border-b border-rule-light outline-none focus:border-rust w-[140px]"
            />
            <input
              type="text"
              placeholder="rootPath (absolute)"
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              className="mono text-[11px] px-1.5 py-0.5 bg-transparent border-b border-rule-light outline-none focus:border-rust flex-1 min-w-[200px]"
            />
            <input
              type="text"
              placeholder="bibRelPath (optional)"
              value={bibRelPath}
              onChange={(e) => setBibRelPath(e.target.value)}
              className="mono text-[11px] px-1.5 py-0.5 bg-transparent border-b border-rule-light outline-none focus:border-rust w-[160px]"
            />
            <button
              onClick={onSave}
              disabled={saving || !machineId.trim() || !rootPath.trim()}
              className="mono text-[10px] uppercase tracking-wider px-2 py-0.5 text-rust hover:bg-rust-dim disabled:text-ink-4"
            >
              {saving ? "..." : "save"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
