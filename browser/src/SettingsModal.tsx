// Deployment-level settings UI. Self-hosted OSS: each user runs their own
// Convex deployment, so there's no per-user auth — settings are a singleton
// row in `appSettings`. Phase 1 scope is tab on/off + drag-reorder + static
// per-tab requirement explainer. Auto-install / auto-login flows land in
// later phases.

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import {
  X,
  GripVertical,
  Newspaper,
  BookOpen,
  ScrollText,
  GitPullRequest,
  GitBranch,
  Calendar,
  Apple,
  Languages,
  Quote,
  Info,
  Settings as SettingsIcon,
  Check,
  Loader2,
  AlertCircle,
  Download,
  RefreshCw,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { reflectiveSupported, isReflectiveOn, applyReflective } from "./reflective.ts";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

type TabKey = "newsletter" | "paper" | "article" | "pr" | "research" | "plan" | "diet" | "vocab" | "insights";

type TabMeta = {
  key: TabKey;
  label: string;
  icon: LucideIcon;
  blurb: string;
  requirements: { label: string; detail: string }[];
};

// Static metadata. Worker-side install / verify status lands in a later phase
// and will be merged in via a separate query.
const TAB_META: Record<TabKey, TabMeta> = {
  newsletter: {
    key: "newsletter",
    label: "Newsletter",
    icon: Newspaper,
    blurb: "Korean summaries of AI newsletters (AlphaSignal, TLDR, alphaXiv) with optional Notion suggestion drops.",
    requirements: [
      { label: "Agent CLI", detail: "claude, codex, or gemini on PATH (one is enough)." },
      {
        label: "Mailbox fetch (optional)",
        detail: "gws CLI authed to your Gmail to pull unread newsletters straight into the queue.",
      },
      { label: "Notion (optional)", detail: "NOTION_TOKEN env var on the worker for the suggestion-drop step." },
    ],
  },
  paper: {
    key: "paper",
    label: "Paper",
    icon: BookOpen,
    blurb: "Per-paper Korean summary with peer-review fields, paper-grounded chat, and a 3-line takeaway block.",
    requirements: [{ label: "Agent CLI", detail: "claude, codex, or gemini on PATH (one is enough)." }],
  },
  article: {
    key: "article",
    label: "Article",
    icon: ScrollText,
    blurb: "Long-form article summarizer with claim / evidence / so-what hover tldr.",
    requirements: [{ label: "Agent CLI", detail: "claude, codex, or gemini on PATH (one is enough)." }],
  },
  pr: {
    key: "pr",
    label: "PRs",
    icon: GitPullRequest,
    blurb: "Open / review / auto-fix GitHub pull requests authored by you across your repos.",
    requirements: [
      { label: "gh CLI", detail: "GitHub CLI installed + logged in (gh auth login -w)." },
      { label: "GitHub username", detail: "Used to scope the PR list query." },
    ],
  },
  research: {
    key: "research",
    label: "Research",
    icon: GitBranch,
    blurb: "Co-managed research projects: memos, experiments, tables, figures, venues, sections, tex, refs, comments.",
    requirements: [{ label: "None", detail: "Works out of the box on the shared Convex deployment." }],
  },
  plan: {
    key: "plan",
    label: "Plans",
    icon: Calendar,
    blurb: "Daily / weekly plans synced with calendar + todos.",
    requirements: [
      { label: "Plan markdown source", detail: "Run plans:sync once with your plan markdown to seed the deployment." },
      { label: "Calendar (optional)", detail: "Google Calendar integration for two-way event sync." },
    ],
  },
  diet: {
    key: "diet",
    label: "Diet",
    icon: Apple,
    blurb: "Photograph a meal and log its calorie / macro estimate over time.",
    requirements: [{ label: "Agent CLI", detail: "claude, codex, or gemini on PATH for the food-image estimate." }],
  },
  vocab: {
    key: "vocab",
    label: "Vocab",
    icon: Languages,
    blurb: "EN / JP expression study with spaced-repetition review and due reminders.",
    requirements: [
      { label: "Notion (optional)", detail: "NOTION_TOKEN to export learned expressions to a Notion database." },
    ],
  },
  insights: {
    key: "insights",
    label: "Insights",
    icon: Quote,
    blurb:
      "Collect quotes / core ideas (paste text or a screenshot); each is enriched and filed into the best Notion page as a quote block.",
    requirements: [
      {
        label: "Agent CLI",
        detail: "codex / antigravity / claude on PATH to enrich each insight and pick its Notion home.",
      },
      { label: "NOTION_TOKEN", detail: "Convex env var; required to place a quote block into a Notion page." },
    ],
  },
};

const ALL_KEYS: TabKey[] = ["newsletter", "paper", "article", "pr", "research", "plan", "diet", "vocab", "insights"];

type TabStatus =
  | { kind: "ready"; label?: string }
  | { kind: "needs-setup"; label: string }
  | { kind: "installing"; label: string }
  | { kind: "error"; label: string };

function StatusDot({ status }: { status: TabStatus }) {
  if (status.kind === "ready") {
    return (
      <span title={status.label ?? "ready"} className="inline-flex items-center gap-1 text-emerald-600">
        <Check size={12} />
      </span>
    );
  }
  if (status.kind === "installing") {
    return (
      <span title={status.label} className="inline-flex items-center gap-1 text-ink-3">
        <Loader2 size={12} className="animate-spin" />
      </span>
    );
  }
  if (status.kind === "error") {
    return (
      <span title={status.label} className="inline-flex items-center gap-1 text-red-500">
        <AlertCircle size={12} />
      </span>
    );
  }
  return (
    <span title={status.label} className="inline-flex items-center gap-1 text-amber-600">
      <AlertCircle size={12} />
    </span>
  );
}

function SortableRow({
  tab,
  enabled,
  status,
  onToggle,
  onInfo,
}: {
  tab: TabMeta;
  enabled: boolean;
  status: TabStatus | null;
  onToggle: () => void;
  onInfo: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.key });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  const Icon = tab.icon;
  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-3 px-3 py-3 border-b border-ink/10">
      <span
        {...attributes}
        {...listeners}
        role="button"
        tabIndex={0}
        className="cursor-grab active:cursor-grabbing text-ink-4 hover:text-ink-3 touch-none select-none p-1 -ml-1 outline-none"
        title="Drag to reorder"
        aria-label={`Reorder ${tab.label}`}
      >
        <GripVertical size={14} />
      </span>
      <Icon size={14} className={enabled ? "text-ink" : "text-ink-4"} />
      <div className="flex-1 min-w-0">
        <div className={`serif text-sm flex items-center gap-1.5 ${enabled ? "text-ink" : "text-ink-3"}`}>
          {tab.label}
          {status && <StatusDot status={status} />}
        </div>
        <div className="mono text-[10px] text-ink-4 truncate">{status?.label ?? tab.blurb}</div>
      </div>
      <button
        onClick={onInfo}
        className="text-ink-4 hover:text-ink-3 p-1"
        title={`What ${tab.label} needs`}
        aria-label={`Show ${tab.label} requirements`}
      >
        <Info size={12} />
      </button>
      <button
        onClick={onToggle}
        className={`relative w-9 h-5 rounded-full transition-colors ${enabled ? "bg-rust" : "bg-rule"}`}
        aria-pressed={enabled}
        title={enabled ? "Disable" : "Enable"}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-paper shadow transition-transform ${
            enabled ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}

const LANGUAGES: { code: string; label: string }[] = [
  { code: "ko", label: "Korean" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "zh", label: "中文" },
];

function statusFor(key: TabKey, settings: any, latestGh: any, latestGws: any): TabStatus | null {
  if (key === "pr") {
    if (latestGh?.status === "pending" || latestGh?.status === "running") {
      const label =
        latestGh.kind === "install_gh"
          ? "installing gh..."
          : latestGh.kind === "oauth_gh"
            ? "waiting for github device login..."
            : "verifying gh...";
      return { kind: "installing", label };
    }
    if (settings?.github?.loggedIn) {
      return { kind: "ready", label: `signed in as ${settings.github.username ?? "?"}` };
    }
    if (latestGh?.status === "error") return { kind: "error", label: latestGh.error ?? "setup failed" };
    return { kind: "needs-setup", label: "gh CLI not verified yet" };
  }
  if (key === "newsletter") {
    if (latestGws?.status === "pending" || latestGws?.status === "running") {
      return { kind: "installing", label: latestGws.kind === "install_gws" ? "installing gws..." : "verifying gws..." };
    }
    if (settings?.google?.loggedIn) {
      return { kind: "ready", label: `signed in as ${settings.google.account ?? "?"}` };
    }
    // gws is optional — don't render a warning badge when it's just not set
    // up. Only escalate to "error" if a verify actually returned a hard fail
    // (versus the common "installed:false" success path).
    if (latestGws?.status === "error") return { kind: "error", label: latestGws.error ?? "gws verify failed" };
    return null;
  }
  return null;
}

// Backdrop blob intensity (0..1). Device-local like the theme toggle, so it
// lives in localStorage and applies live via the --gradient-strength var.
const GRADIENT_STRENGTH_KEY = "gradient-strength";

export function applyGradientStrength(v: number) {
  document.documentElement.style.setProperty("--gradient-strength", String(v));
}

export function bootGradientStrength() {
  const saved = parseFloat(localStorage.getItem(GRADIENT_STRENGTH_KEY) ?? "");
  if (!Number.isNaN(saved)) applyGradientStrength(saved);
}

function GradientStrengthRow() {
  const [value, setValue] = useState(() => {
    const saved = parseFloat(localStorage.getItem(GRADIENT_STRENGTH_KEY) ?? "");
    return Number.isNaN(saved) ? 0.45 : saved;
  });
  const onChange = (v: number) => {
    setValue(v);
    applyGradientStrength(v);
    localStorage.setItem(GRADIENT_STRENGTH_KEY, String(v));
  };
  return (
    <div className="flex items-center justify-between px-3 py-3 border-b border-ink/10">
      <div className="flex-1 min-w-0">
        <div className="serif text-sm text-ink">Background gradient</div>
        <div className="mono text-[10px] text-ink-4">backdrop blob intensity (this device)</div>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-28 accent-rust"
        />
        <span className="mono text-[10px] text-ink-3 w-7 text-right">{Math.round(value * 100)}%</span>
      </div>
    </div>
  );
}

// VAPID public keys are base64url; PushManager wants a Uint8Array.
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Enable / disable Web Push for this device, and a test-send. Subscriptions are
// stored in Convex; the worker / score trigger pushes recommended items with a
// deep link straight to ?item=<id>.
function NotificationRow() {
  const vapidKey = useQuery(api.push.vapidPublicKey, {});
  const subscribeMut = useMutation(api.push.subscribe);
  const unsubscribeMut = useMutation(api.push.unsubscribe);
  const sendTest = useAction(api.push.sendTest);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const supported =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;

  useEffect(() => {
    if (!supported) return;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setEndpoint(sub?.endpoint ?? null))
      .catch(() => {});
  }, [supported]);

  const enable = async () => {
    if (!vapidKey) {
      setMsg("VAPID key not configured on the server");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setMsg("Permission denied");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
      const json = sub.toJSON();
      await subscribeMut({
        endpoint: sub.endpoint,
        keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
        label: navigator.userAgent.slice(0, 80),
      });
      setEndpoint(sub.endpoint);
      setMsg("Notifications on");
    } catch (e) {
      setMsg((e as Error).message?.slice(0, 80) ?? "Failed");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await unsubscribeMut({ endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setEndpoint(null);
      setMsg("Notifications off");
    } catch (e) {
      setMsg((e as Error).message?.slice(0, 80) ?? "Failed");
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await sendTest({});
      setMsg(`Sent to ${r.sent} device${r.sent === 1 ? "" : "s"}`);
    } catch (e) {
      setMsg((e as Error).message?.slice(0, 80) ?? "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between px-3 py-3 border-b border-ink/10">
      <div className="flex-1 min-w-0">
        <div className="serif text-sm text-ink">Notifications</div>
        <div className="mono text-[10px] text-ink-4">
          {!supported ? "not supported on this browser" : msg ? msg : "push recommended reads to this device"}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {endpoint && (
          <button
            onClick={test}
            disabled={busy}
            className="mono text-[10px] tracking-wider px-2 py-0.5 rounded-full text-ink-4 hover:text-ink-3 disabled:opacity-40"
          >
            Test
          </button>
        )}
        <button
          onClick={endpoint ? disable : enable}
          disabled={!supported || busy}
          className={`mono text-[10px] tracking-wider px-2.5 py-0.5 rounded-full transition-colors disabled:opacity-40 ${
            endpoint ? "droplet text-rust" : "text-ink-3 hover:text-ink border border-ink/15"
          }`}
        >
          {endpoint ? "On" : "Enable"}
        </button>
      </div>
    </div>
  );
}

// Reflective UI toggle: blurred live front-camera behind the glass chrome. Hidden
// where getUserMedia is unavailable. Camera permission is requested on enable.
function ReflectiveRow() {
  const [on, setOn] = useState(() => isReflectiveOn());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (!reflectiveSupported()) return null;

  const toggle = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await applyReflective(!on);
      setOn(!on);
    } catch (e) {
      setMsg((e as Error).message?.slice(0, 60) ?? "Camera blocked");
      setOn(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between px-3 py-3 border-b border-ink/10">
      <div className="flex-1 min-w-0">
        <div className="serif text-sm text-ink flex items-center gap-1.5">
          <Sparkles size={13} className="text-rust" />
          Reflective UI
        </div>
        <div className="mono text-[10px] text-ink-4">{msg ?? "live front-camera behind the glass (this device)"}</div>
      </div>
      <button
        onClick={toggle}
        disabled={busy}
        className={`mono text-[10px] tracking-wider px-2.5 py-0.5 rounded-full transition-colors disabled:opacity-40 ${
          on ? "droplet text-rust" : "text-ink-3 hover:text-ink border border-ink/15"
        }`}
      >
        {on ? "On" : "Enable"}
      </button>
    </div>
  );
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useQuery(api.settings.get, {});
  const setTabs = useMutation(api.settings.setTabs);
  const setLanguage = useMutation(api.settings.setLanguage);
  const latestGhInstall = useQuery(api.setup.latestByKind, { kind: "install_gh" });
  const latestGhVerify = useQuery(api.setup.latestByKind, { kind: "verify_gh" });
  const latestGhOauth = useQuery(api.setup.latestByKind, { kind: "oauth_gh" });
  const latestGwsInstall = useQuery(api.setup.latestByKind, { kind: "install_gws" });
  const latestGwsVerify = useQuery(api.setup.latestByKind, { kind: "verify_gws" });
  const requestSetup = useMutation(api.setup.request);
  const setGithub = useMutation(api.settings.setGithub);
  const setNotion = useMutation(api.settings.setNotion);
  const [info, setInfo] = useState<TabKey | null>(null);

  // Auto-verify on open if we don't have a recent (≤5 min) result — keeps
  // "needs-setup" from sticking when the CLI is in fact installed.
  const STALE_MS = 5 * 60_000;
  useEffect(() => {
    if (latestGhVerify === undefined) return;
    const fresh = latestGhVerify && Date.now() - latestGhVerify.updatedAt < STALE_MS;
    if (!fresh && latestGhVerify?.status !== "pending" && latestGhVerify?.status !== "running") {
      void requestSetup({ kind: "verify_gh" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestGhVerify === undefined]);
  useEffect(() => {
    if (latestGwsVerify === undefined) return;
    const fresh = latestGwsVerify && Date.now() - latestGwsVerify.updatedAt < STALE_MS;
    if (!fresh && latestGwsVerify?.status !== "pending" && latestGwsVerify?.status !== "running") {
      void requestSetup({ kind: "verify_gws" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestGwsVerify === undefined]);

  // Pick whichever gh/gws row is most recently updated — that's the one the
  // UI badge should track ("installing" or "verifying" status takes
  // precedence over the more-stable verified state).
  const latestGh = useMemo(() => {
    const opts = [latestGhInstall, latestGhVerify, latestGhOauth].filter(Boolean) as any[];
    if (opts.length === 0) return null;
    return opts.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }, [latestGhInstall, latestGhVerify, latestGhOauth]);
  const latestGws = useMemo(() => {
    const opts = [latestGwsInstall, latestGwsVerify].filter(Boolean) as any[];
    if (opts.length === 0) return null;
    return opts.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }, [latestGwsInstall, latestGwsVerify]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (info) setInfo(null);
        else onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, info]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const orderedTabs = useMemo(() => {
    if (!settings) return [];
    const known = new Set(settings.tabs.map((t) => t.key));
    const ordered = settings.tabs
      .filter((t) => (ALL_KEYS as string[]).includes(t.key))
      .map((t) => ({ key: t.key as TabKey, enabled: t.enabled }));
    for (const k of ALL_KEYS) {
      if (!known.has(k)) ordered.push({ key: k, enabled: false });
    }
    return ordered;
  }, [settings]);

  // Optimistic order applied synchronously on drag end so dnd-kit settles in
  // place instead of snapping back for the frame before the Convex write
  // round-trips. Cleared once the server order matches.
  const [orderOverride, setOrderOverride] = useState<TabKey[] | null>(null);
  const displayTabs = useMemo(() => {
    if (!orderOverride) return orderedTabs;
    const byKey = new Map(orderedTabs.map((t) => [t.key, t] as const));
    const ordered = orderOverride
      .map((k) => byKey.get(k))
      .filter((t): t is { key: TabKey; enabled: boolean } => Boolean(t));
    const extra = orderedTabs.filter((t) => !orderOverride.includes(t.key));
    return ordered.length > 0 ? [...ordered, ...extra] : orderedTabs;
  }, [orderOverride, orderedTabs]);
  useEffect(() => {
    if (!orderOverride) return;
    if (orderedTabs.map((t) => t.key).join(",") === orderOverride.join(",")) {
      setOrderOverride(null);
    }
  }, [orderedTabs, orderOverride]);

  const handleDragEnd = async (e: DragEndEvent) => {
    if (!settings || !e.over || e.active.id === e.over.id) return;
    const oldIndex = displayTabs.findIndex((t) => t.key === e.active.id);
    const newIndex = displayTabs.findIndex((t) => t.key === e.over!.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(displayTabs, oldIndex, newIndex);
    setOrderOverride(next.map((t) => t.key));
    await setTabs({ tabs: next });
  };

  const handleToggle = async (key: TabKey) => {
    if (!settings) return;
    const next = displayTabs.map((t) => (t.key === key ? { ...t, enabled: !t.enabled } : t));
    await setTabs({ tabs: next });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/15 p-4" onClick={onClose}>
      <div
        className="glass-strong rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-ink/10">
          <div className="flex items-center gap-2">
            <SettingsIcon size={14} className="text-ink-3" />
            <span className="serif text-base text-ink">Settings</span>
            <span className="mono text-[10px] text-ink-4">tabs · drag to reorder</span>
          </div>
          <button onClick={onClose} className="text-ink-3 hover:text-ink-2" aria-label="Close settings">
            <X size={14} />
          </button>
        </div>
        <div className="overflow-y-auto flex-1">
          {!settings ? (
            <div className="mono text-[11px] text-ink-4 py-8 px-4 text-center">loading...</div>
          ) : (
            <>
              <div className="flex items-center justify-between px-3 py-3 border-b border-ink/10">
                <div className="flex-1 min-w-0">
                  <div className="serif text-sm text-ink">Output language</div>
                  <div className="mono text-[10px] text-ink-4">
                    used by summaries, tldr, and chat (applies to new runs)
                  </div>
                </div>
                <select
                  value={settings.language ?? "ko"}
                  onChange={(e) => void setLanguage({ language: e.target.value })}
                  className="glass border-ink/10 px-2 py-1 mono text-[11px] text-ink outline-none focus:border-rust rounded-full"
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </div>
              <GradientStrengthRow />
              <NotificationRow />
              <ReflectiveRow />
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={displayTabs.map((t) => t.key)} strategy={verticalListSortingStrategy}>
                  {displayTabs.map((t) => (
                    <SortableRow
                      key={t.key}
                      tab={TAB_META[t.key]}
                      enabled={t.enabled}
                      status={statusFor(t.key, settings, latestGh, latestGws)}
                      onToggle={() => handleToggle(t.key)}
                      onInfo={() => setInfo(t.key)}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            </>
          )}
        </div>
        <div className="mono text-[10px] text-ink-4 px-4 py-2 border-t border-ink/10">
          Self-hosted. One Convex deployment = one user. Settings sync across browsers on this deployment.
        </div>
      </div>
      {info && (
        <InfoPanel
          tab={TAB_META[info]}
          status={statusFor(info, settings, latestGh, latestGws)}
          settings={settings}
          ghLatest={latestGh}
          gwsLatest={latestGws}
          onInstallGh={() => void requestSetup({ kind: "install_gh" })}
          onVerifyGh={() => void requestSetup({ kind: "verify_gh" })}
          onOauthGh={() => void requestSetup({ kind: "oauth_gh" })}
          onInstallGws={() => void requestSetup({ kind: "install_gws" })}
          onVerifyGws={() => void requestSetup({ kind: "verify_gws" })}
          onSaveGithubScope={(orgs) => void setGithub({ orgs })}
          onSaveNotionRoot={(rootPageId) => void setNotion({ rootPageId, configured: rootPageId.length > 0 })}
          onClose={() => setInfo(null)}
        />
      )}
    </div>
  );
}

function InfoPanel({
  tab,
  status,
  settings,
  ghLatest,
  gwsLatest,
  onInstallGh,
  onVerifyGh,
  onOauthGh,
  onInstallGws,
  onVerifyGws,
  onSaveGithubScope,
  onSaveNotionRoot,
  onClose,
}: {
  tab: TabMeta;
  status: TabStatus | null;
  settings: any;
  ghLatest: any;
  gwsLatest: any;
  onInstallGh: () => void;
  onVerifyGh: () => void;
  onOauthGh: () => void;
  onInstallGws: () => void;
  onVerifyGws: () => void;
  onSaveGithubScope: (orgs: string) => void;
  onSaveNotionRoot: (rootPageId: string) => void;
  onClose: () => void;
}) {
  const Icon = tab.icon;
  const running = status?.kind === "installing";
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/20 p-4" onClick={onClose}>
      <div
        className="glass-strong rounded-2xl max-w-md w-full max-h-[70vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-ink/10">
          <div className="flex items-center gap-2">
            <Icon size={14} className="text-ink-3" />
            <span className="serif text-base text-ink">{tab.label}</span>
            {status && <StatusDot status={status} />}
          </div>
          <button onClick={onClose} className="text-ink-3 hover:text-ink-2" aria-label="Close info">
            <X size={14} />
          </button>
        </div>
        <div className="overflow-y-auto flex-1 px-4 py-3">
          <p className="text-sm text-ink-2 mb-4">{tab.blurb}</p>
          <div className="space-y-3 mb-5">
            {tab.requirements.map((r) => (
              <div key={r.label}>
                <div className="mono text-[10px] tracking-wider text-rust mb-0.5">{r.label}</div>
                <div className="text-sm text-ink-2">{r.detail}</div>
              </div>
            ))}
          </div>
          {tab.key === "pr" && (
            <>
              <TextSetting
                label="GitHub username / org(s)"
                placeholder="e.g. octocat,my-org"
                hint="comma-separated list of users/orgs to scope the open-PR query. Blank means no PRs, not all of them."
                initial={settings?.github?.orgs ?? ""}
                onSave={onSaveGithubScope}
              />
              <SetupActions
                cli="gh"
                latest={ghLatest}
                running={running}
                loginCommand="gh auth login --web"
                onInstall={onInstallGh}
                onVerify={onVerifyGh}
                onOauth={onOauthGh}
              />
            </>
          )}
          {tab.key === "newsletter" && (
            <>
              <SetupActions
                cli="gws"
                latest={gwsLatest}
                running={running}
                loginCommand="gws auth login"
                onInstall={onInstallGws}
                onVerify={onVerifyGws}
              />
              <TextSetting
                label="Notion root page id"
                placeholder="32-char page id from the page URL"
                hint="restricts Notion search/insert to this page subtree. NOTION_TOKEN must be set on the worker env."
                initial={settings?.notion?.rootPageId ?? ""}
                onSave={onSaveNotionRoot}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TextSetting({
  label,
  placeholder,
  hint,
  initial,
  onSave,
}: {
  label: string;
  placeholder: string;
  hint: string;
  initial: string;
  onSave: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  useEffect(() => setValue(initial), [initial]);
  const dirty = value !== initial;
  return (
    <div className="border-t border-ink/10 pt-3 mb-4">
      <div className="mono text-[10px] tracking-wider text-ink-4 mb-1">{label}</div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          className="flex-1 bg-paper-warm/40 border border-ink/10 px-2 py-1 mono text-[11px] text-ink outline-none focus:border-rust"
        />
        <button
          disabled={!dirty}
          onClick={() => {
            onSave(value.trim());
            setSavedAt(Date.now());
          }}
          className="mono text-[10px] tracking-wider px-2 py-1 text-rust hover:bg-rust-dim disabled:text-ink-4 rounded-full"
        >
          {savedAt && !dirty ? "saved" : "save"}
        </button>
      </div>
      <div className="mono text-[10px] text-ink-4 mt-1">{hint}</div>
    </div>
  );
}

function SetupActions({
  cli,
  latest,
  running,
  loginCommand,
  onInstall,
  onVerify,
  onOauth,
}: {
  cli: string;
  latest: any;
  running: boolean;
  loginCommand: string;
  onInstall: () => void;
  onVerify: () => void;
  onOauth?: () => void;
}) {
  const parsedResult = latest?.result ? safeJSON(latest.result) : null;
  const versionLine = parsedResult?.version as string | undefined;
  const lastErr = latest?.status === "error" ? latest.error : null;
  // OAuth device-code mid-flow result: the worker writes {stage: "device_code",
  // userCode, verificationUri, expiresIn} to setProgress while polling github.
  const oauthDevice =
    parsedResult?.stage === "device_code"
      ? {
          userCode: parsedResult.userCode as string,
          verificationUri: parsedResult.verificationUri as string,
        }
      : null;
  return (
    <div className="border-t border-ink/10 pt-3 space-y-3">
      <div className="mono text-[10px] tracking-wider text-ink-4">{cli} setup</div>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={onInstall}
          disabled={running}
          className="mono text-[10px] tracking-wider px-2 py-1 text-rust hover:bg-rust-dim disabled:text-ink-4 flex items-center gap-1 rounded-full"
        >
          {running ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
          install {cli}
        </button>
        <button
          onClick={onVerify}
          disabled={running}
          className="mono text-[10px] tracking-wider px-2 py-1 text-ink-2 hover:text-ink disabled:text-ink-4 flex items-center gap-1 rounded-full"
        >
          {running ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
          verify
        </button>
        {onOauth && (
          <button
            onClick={onOauth}
            disabled={running}
            className="mono text-[10px] tracking-wider px-2 py-1 text-rust hover:bg-rust-dim disabled:text-ink-4 flex items-center gap-1 rounded-full"
          >
            {running ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
            login (browser)
          </button>
        )}
      </div>
      {oauthDevice && (
        <div className="bg-paper-warm/40 border border-rust/30 px-3 py-2 space-y-1">
          <div className="mono text-[10px] tracking-wider text-rust">github oauth</div>
          <div className="text-sm text-ink-2">
            Open{" "}
            <a
              href={oauthDevice.verificationUri}
              target="_blank"
              rel="noopener noreferrer"
              className="text-rust hover:underline"
            >
              {oauthDevice.verificationUri}
            </a>{" "}
            and enter:
          </div>
          <code className="block bg-paper-warm/40 px-2 py-1 mono text-base tracking-widest text-rust select-all rounded-lg">
            {oauthDevice.userCode}
          </code>
          <div className="mono text-[10px] text-ink-4">worker polls until login completes — no terminal needed.</div>
        </div>
      )}
      <div>
        <div className="mono text-[10px] text-ink-4 mb-1">login (manual fallback)</div>
        <code className="block bg-paper-warm/40 px-2 py-1.5 text-[11px] text-ink-2 mono select-all">
          {loginCommand}
        </code>
      </div>
      {versionLine && <div className="mono text-[10px] text-ink-3 truncate">version: {versionLine}</div>}
      {lastErr && (
        <div className="mono text-[10px] text-red-500 break-words">last error: {String(lastErr).slice(0, 240)}</div>
      )}
      {latest?.stdout && (
        <details className="mono text-[10px] text-ink-4">
          <summary className="cursor-pointer hover:text-ink-3">stdout</summary>
          <pre className="mt-1 bg-paper-warm/40 p-2 max-h-40 overflow-auto whitespace-pre-wrap break-all">
            {latest.stdout}
          </pre>
        </details>
      )}
    </div>
  );
}

function safeJSON(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
