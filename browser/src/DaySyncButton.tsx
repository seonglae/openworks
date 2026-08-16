// DaySyncButton — per-day "sync" button that asks the worker to pull
// outlook calendar events for this date and fold them into planItems via
// the planner agent (gemini → codex → claude through actor.runActor).

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { RefreshCw, Loader2, Check, AlertCircle } from "lucide-react";

export function DaySyncButton({ planSlug, date }: { planSlug: string; date: string }) {
  const requestSync = useMutation(api.calendar.requestSyncDay);
  const latest = useQuery(api.calendar.latestForDay, { planSlug, date });
  const [submitting, setSubmitting] = useState(false);

  const pending = latest?.status === "pending";
  const errored = latest?.status === "error";

  const onClick = async () => {
    setSubmitting(true);
    try {
      await requestSync({ planSlug, date });
    } finally {
      setSubmitting(false);
    }
  };

  const tooltip = errored
    ? `last error: ${latest.error?.slice(0, 120)}`
    : pending
      ? "worker is syncing this day..."
      : "Pull outlook events for this day and add new ones to the plan";

  const inFlight = submitting || pending;

  return (
    <button
      onClick={onClick}
      disabled={inFlight}
      className={`mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 flex items-center gap-1 transition-colors ${
        errored ? "text-red-500 hover:text-red-600" : "text-ink-4 hover:text-ink-2 disabled:text-ink-3"
      }`}
      title={tooltip}
    >
      {inFlight ? (
        <Loader2 size={10} className="animate-spin" />
      ) : errored ? (
        <AlertCircle size={10} />
      ) : latest?.status === "done" ? (
        <Check size={10} />
      ) : (
        <RefreshCw size={10} />
      )}
      sync
    </button>
  );
}
