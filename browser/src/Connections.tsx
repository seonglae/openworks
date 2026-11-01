import { useAction, useMutation, useQuery } from "convex/react";
import { Check, Loader2, Plug, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { connectorsFor, type ConnectorDirection, type ConnectorType } from "@openworks/domain";
import { api } from "../../convex/_generated/api";

// Each connector type's own way in: Notion through its sign-in or a pasted
// token, a vault by its folder, Gmail and GitHub through the CLI the worker
// runs. Settings and the onboarding draw the same cards.

type Tone = "on" | "off" | "busy" | "bad";

const TONE: Record<Tone, string> = {
  on: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  off: "bg-ink/5 text-ink-3",
  busy: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  bad: "bg-red-500/15 text-red-700 dark:text-red-300",
};

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`mono text-[11px] rounded-full px-2 py-0.5 ${TONE[tone]}`}>{children}</span>;
}

const button =
  "mono text-[11px] rounded-full px-2.5 py-1 border border-ink/15 text-ink-2 hover:text-ink hover:border-ink/30 disabled:text-ink-4 flex items-center gap-1";

function Field({
  placeholder,
  action,
  onSubmit,
  secret,
}: {
  placeholder: string;
  action: string;
  onSubmit: (value: string) => Promise<unknown>;
  secret?: boolean;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value.trim());
      setValue("");
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^.*Uncaught Error: /, "").split("\n")[0] : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <input
          type={secret ? "password" : "text"}
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          className="flex-1 min-w-0 rounded-lg bg-paper-warm/40 border border-ink/10 px-2 py-1 mono text-[12px] text-ink outline-none focus:border-ink/40"
        />
        <button onClick={() => void submit()} disabled={busy || !value.trim()} className={button}>
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Plug size={11} />}
          {action}
        </button>
      </div>
      {error && <div className="text-[12px] text-red-600 dark:text-red-400">{error}</div>}
    </div>
  );
}

function NotionConnect({ returnTo }: { returnTo: string }) {
  const rows = useQuery(api.connectors.list, {});
  const begin = useAction(api.connectors.beginNotionOAuth);
  const paste = useAction(api.connectors.connectNotionToken);
  const setConfig = useMutation(api.connectors.setNotionConfig);
  const remove = useMutation(api.connectors.remove);
  const [noOAuth, setNoOAuth] = useState(false);
  const [starting, setStarting] = useState(false);
  const row = rows?.find((r) => r.type === "notion");

  const signIn = async () => {
    setStarting(true);
    const started = await begin({ returnTo }).catch(() => null);
    if (started) window.location.assign(started.url);
    else {
      setNoOAuth(true);
      setStarting(false);
    }
  };

  const connect = (
    <div className="space-y-2">
      <button onClick={() => void signIn()} disabled={starting} className={button}>
        {starting ? <Loader2 size={11} className="animate-spin" /> : <Plug size={11} />}
        Sign in with Notion
      </button>
      {noOAuth && (
        <div className="text-[12px] text-ink-3">
          This deployment has no Notion OAuth client yet (NOTION_OAUTH_CLIENT_ID). Connect with an integration token
          below.
        </div>
      )}
      <Labelled
        label="Integration token"
        hint="Create an internal integration at notion.so/profile/integrations, then add it to the pages it should write to"
      >
        <Field placeholder="ntn_…" action="Connect" secret onSubmit={(token) => paste({ token })} />
      </Labelled>
    </div>
  );

  if (row?.status !== "connected") return connect;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[13px] text-ink-2">
        <Check size={13} className="text-emerald-600" />
        {row.name}
        <span className="mono text-[11px] text-ink-4">
          {row.auth === "oauth" ? "OAuth" : row.auth === "token" ? "integration token" : "deployment env"}
        </span>
        {row.auth !== "env" && (
          <button onClick={() => void remove({ id: row._id })} className={`${button} ml-auto`}>
            <Trash2 size={11} /> Disconnect
          </button>
        )}
      </div>
      <Labelled
        label="Root page id"
        hint={
          row.config?.rootPageId
            ? `Now ${row.config.rootPageId}; keeps Notion search and inserts under this page`
            : "Keeps Notion search and inserts under this page"
        }
      >
        <Field placeholder="page id" action="Save" onSubmit={(rootPageId) => setConfig({ rootPageId })} />
      </Labelled>
      {row.auth === "env" && (
        <details className="text-[12px] text-ink-3">
          <summary className="cursor-pointer hover:text-ink">
            Connect with OAuth or a token instead of the deployment env
          </summary>
          <div className="mt-2">{connect}</div>
        </details>
      )}
    </div>
  );
}

function ObsidianConnect() {
  const rows = useQuery(api.connectors.list, {});
  const add = useMutation(api.connectors.addObsidian);
  const remove = useMutation(api.connectors.remove);
  const vaults = rows?.filter((r) => r.type === "obsidian") ?? [];
  return (
    <div className="space-y-2">
      {vaults.map((r) => (
        <div key={r._id} className="flex items-center gap-2 text-[13px] text-ink-2">
          {r.status === "connected" ? (
            <Check size={13} className="text-emerald-600" />
          ) : r.status === "checking" ? (
            <Loader2 size={13} className="animate-spin text-ink-3" />
          ) : null}
          <span className="truncate">{r.config?.vaultPath}</span>
          {r.status === "error" && <span className="text-[12px] text-red-600 dark:text-red-400">{r.error}</span>}
          <button onClick={() => void remove({ id: r._id })} className={`${button} ml-auto`} aria-label="Remove vault">
            <Trash2 size={11} />
          </button>
        </div>
      ))}
      <Labelled label="Vault folder" hint="The worker on this machine checks the folder and its .obsidian">
        <Field placeholder="~/Documents/Vault" action="Connect" onSubmit={(vaultPath) => add({ vaultPath })} />
      </Labelled>
    </div>
  );
}

function CliConnect({ cli }: { cli: "gh" | "gws" }) {
  const verifyKind = cli === "gh" ? "verify_gh" : "verify_gws";
  const latest = useQuery(api.setup.latestByKind, { kind: verifyKind });
  const request = useMutation(api.setup.request);
  const running = latest?.status === "pending" || latest?.status === "running";
  const result = latest?.result ? (JSON.parse(latest.result) as { installed?: boolean }) : null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => void request({ kind: verifyKind })} disabled={running} className={button}>
          {running ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          Check
        </button>
        {result?.installed === false && (
          <button
            onClick={() => void request({ kind: cli === "gh" ? "install_gh" : "install_gws" })}
            disabled={running}
            className={button}
          >
            Install {cli}
          </button>
        )}
        {cli === "gh" && (
          <button onClick={() => void request({ kind: "oauth_gh" })} disabled={running} className={button}>
            Sign in to GitHub
          </button>
        )}
      </div>
      <code className="block rounded-lg bg-paper-warm/40 px-2 py-1 mono text-[11px] text-ink-3 select-all">
        {cli === "gh" ? "gh auth login --web" : "gws auth login"}
      </code>
    </div>
  );
}

function Labelled({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="mono text-[11px] uppercase tracking-wider text-ink-4">{label}</div>
      {children}
      <div className="text-[12px] text-ink-4">{hint}</div>
    </div>
  );
}

// Whether a type is connected, from wherever its state lives: its row, the
// CLI login the worker last verified, or nothing to connect at all.
export function useConnectorState(): (type: ConnectorType) => { tone: Tone; label: string } {
  const rows = useQuery(api.connectors.list, {});
  const settings = useQuery(api.settings.get, {});
  return (type) => {
    if (type.auth.includes("none")) return { tone: "on", label: "Always on" };
    if (type.key === "iphone") return { tone: "off", label: "Sign in on the app" };
    if (type.key === "gmail" || type.key === "github") {
      const cli = type.key === "gmail" ? settings?.google : settings?.github;
      return cli?.loggedIn ? { tone: "on", label: "Connected" } : { tone: "off", label: "Not connected" };
    }
    const mine = rows?.filter((r) => r.type === type.key) ?? [];
    if (mine.some((r) => r.status === "connected"))
      return { tone: "on", label: type.connectOnly ? "Connected · read and write coming" : "Connected" };
    if (mine.some((r) => r.status === "checking")) return { tone: "busy", label: "Checking" };
    if (mine.some((r) => r.status === "error")) return { tone: "bad", label: "Check failed" };
    return { tone: "off", label: "Not connected" };
  };
}

export function ConnectorCard({
  type,
  returnTo,
  open: initiallyOpen = false,
}: {
  type: ConnectorType;
  returnTo: string;
  open?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const state = useConnectorState()(type);
  const body =
    type.key === "notion" ? (
      <NotionConnect returnTo={returnTo} />
    ) : type.key === "obsidian" ? (
      <ObsidianConnect />
    ) : type.key === "gmail" ? (
      <CliConnect cli="gws" />
    ) : type.key === "github" ? (
      <CliConnect cli="gh" />
    ) : type.key === "iphone" ? (
      <div className="text-[12px] text-ink-3">
        Sign in on the iPhone app and screenshots and the share sheet come in.
      </div>
    ) : null;
  return (
    <div className="rounded-xl border border-ink/10 bg-paper/60">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={!body}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="text-[14px] text-ink">{type.label}</div>
          <div className="text-[12px] text-ink-3 truncate">{type.blurb.en}</div>
        </div>
        <Pill tone={state.tone}>{state.label}</Pill>
      </button>
      {open && body && <div className="px-3 pb-3 pt-1 border-t border-ink/5">{body}</div>}
    </div>
  );
}

export function ConnectionsSection() {
  const returnTo = `${window.location.origin}${window.location.pathname}?settings=connections`;
  const group = (direction: ConnectorDirection, title: string) => (
    <div className="space-y-2">
      <div className="mono text-[11px] uppercase tracking-wider text-ink-4">{title}</div>
      {connectorsFor(direction).map((t) => (
        <ConnectorCard key={`${direction}:${t.key}`} type={t} returnTo={returnTo} />
      ))}
    </div>
  );
  return (
    <div className="px-3 py-3 border-b border-ink/10 space-y-3">
      <div>
        <div className="serif text-sm text-ink">Connections</div>
        <div className="mono text-[11px] text-ink-4">where content comes in and where it goes</div>
      </div>
      {group("input", "Input")}
      {group("output", "Output")}
    </div>
  );
}
