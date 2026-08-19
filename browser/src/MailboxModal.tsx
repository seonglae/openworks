// MailboxModal — shows unread newsletter mail (subjects only) and lets the
// user process each one as a newsletter job. worker.mts picks up requests
// from the mailboxRequests queue and runs gws on its behalf.

import { useEffect, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { X, Mail, Loader2, Plus, RefreshCw } from "lucide-react";

type Entry = { id: string; from: string; subject: string; date?: string };

export function MailboxModal({ onClose }: { onClose: () => void }) {
  const requestList = useMutation(api.mailbox.requestList);
  const requestMarkRead = useMutation(api.mailbox.requestMarkRead);
  const createJob = useMutation(api.jobs.create);
  const [reqId, setReqId] = useState<Id<"mailboxRequests"> | null>(null);
  const myReq = useQuery(api.mailbox.getRequest, reqId ? { id: reqId } : "skip");
  const [adding, setAdding] = useState<Set<string>>(new Set());
  const [addedLocally, setAddedLocally] = useState<Set<string>>(new Set());

  // Always start a fresh request on open — never rely on a stale prior result.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await requestList({});
      if (!cancelled) setReqId(r.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [requestList]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const refresh = async () => {
    setAddedLocally(new Set());
    setReqId(null);
    const r = await requestList({});
    setReqId(r.id);
  };

  const loading = !reqId || myReq === undefined || myReq?.status === "pending" || myReq?.status === "running";
  const done = myReq?.status === "done";
  const errored = myReq?.status === "error";

  const entries: Entry[] = (() => {
    if (!done || !myReq?.result) return [];
    try {
      return JSON.parse(myReq.result) as Entry[];
    } catch {
      return [];
    }
  })();

  const visible = entries.filter((e) => !addedLocally.has(e.id));

  const handleAdd = async (entry: Entry) => {
    if (adding.has(entry.id)) return;
    setAdding((s) => new Set(s).add(entry.id));
    try {
      await createJob({
        url: `https://mail.google.com/mail/u/0/#inbox/${entry.id}`,
        title: entry.subject || "(no subject)",
        type: "newsletter",
        emailId: entry.id,
      });
      await requestMarkRead({ emailId: entry.id });
      setAddedLocally((s) => new Set(s).add(entry.id));
    } finally {
      setAdding((s) => {
        const n = new Set(s);
        n.delete(entry.id);
        return n;
      });
    }
  };

  const fromLabel = (from: string) => {
    const m = from.match(/^([^<]+?)\s*</);
    return (m?.[1] ?? from).trim().slice(0, 28);
  };

  const [processingAll, setProcessingAll] = useState(false);
  const handleProcessAll = async () => {
    if (processingAll) return;
    setProcessingAll(true);
    try {
      for (const e of visible) {
        if (adding.has(e.id)) continue;
        await handleAdd(e);
      }
    } finally {
      setProcessingAll(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/15 p-4" onClick={onClose}>
      <div
        className="glass-strong rounded-2xl max-w-2xl w-full max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-ink/10">
          <div className="flex items-center gap-2">
            <Mail size={14} className="text-ink-3" />
            <span className="serif text-base text-ink">Inbox</span>
            <span className="mono text-[10px] text-ink-4">unread newsletters</span>
          </div>
          <div className="flex items-center gap-2">
            {!loading && visible.length > 0 && (
              <button
                onClick={handleProcessAll}
                disabled={processingAll}
                className="mono text-[10px] tracking-wider text-rust hover:bg-rust-dim disabled:text-ink-4 px-2 py-0.5 flex items-center gap-1 rounded-full"
              >
                {processingAll ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />}
                process all ({visible.length})
              </button>
            )}
            <button
              onClick={refresh}
              disabled={loading}
              className="mono text-[10px] tracking-wider text-ink-3 hover:text-ink-2 disabled:text-ink-4 px-2 py-0.5 flex items-center gap-1 rounded-full"
            >
              {loading ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
              refresh
            </button>
            <button onClick={onClose} className="text-ink-3 hover:text-ink-2">
              <X size={14} />
            </button>
          </div>
        </div>
        <div className="overflow-y-auto flex-1">
          {loading && (
            <div className="mono text-[11px] text-ink-4 py-8 px-4 flex items-center justify-center gap-2">
              <Loader2 size={14} className="animate-spin" />
              fetching unread newsletters...
            </div>
          )}
          {!loading && errored && <div className="mono text-[11px] text-red-500 py-6 px-4">error: {myReq?.error}</div>}
          {!loading && done && visible.length === 0 && (
            <div className="mono text-[11px] text-ink-4 py-8 px-4 italic text-center">no unread newsletters.</div>
          )}
          {!loading &&
            visible.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center gap-3 px-4 py-2 border-b border-ink/10 last:border-b-0 hover:bg-paper-warm/30"
              >
                <span className="mono text-[10px] text-ink-4 w-[110px] shrink-0 truncate">{fromLabel(entry.from)}</span>
                <span className="text-sm text-ink-2 flex-1 truncate">{entry.subject || "(no subject)"}</span>
                <button
                  onClick={() => handleAdd(entry)}
                  disabled={adding.has(entry.id)}
                  className="mono text-[10px] tracking-wider px-2 py-0.5 text-rust hover:bg-rust-dim disabled:text-ink-4 flex items-center gap-1 shrink-0 rounded-full"
                >
                  {adding.has(entry.id) ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />}
                  read &amp; process
                </button>
              </div>
            ))}
        </div>
        <div className="mono text-[10px] text-ink-4 px-4 py-2 border-t border-ink/10">
          read &amp; process → creates a newsletter job and marks the email read.
        </div>
      </div>
    </div>
  );
}
