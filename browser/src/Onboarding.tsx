import { useMutation, useQuery } from "convex/react";
import { ArrowLeft, ArrowRight, Check, Languages, Link2, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { connectorType, connectorsFor, type ConnectorDirection } from "@openworks/domain";
import { api } from "../../convex/_generated/api";
import { ConnectorBadge, ConnectorCard } from "./Connections";
import { MODES } from "./shared/modes";

// A fresh deployment's first screen. The language agents write in comes
// first; then what comes in and what goes out, since every other screen is
// made of them; the connections those need; then which tabs to keep. The
// answers are saved at every step, so a Notion sign-in that leaves the page
// comes back to the connect step.

const STEPS = ["language", "input", "output", "connect", "tabs"] as const;
type Step = (typeof STEPS)[number];

const TITLE: Record<Step, { title: string; sub: string }> = {
  language: { title: "Language", sub: "What summaries, notes and drafts are written in" },
  input: { title: "What comes in?", sub: "Pick where you read and collect from" },
  output: { title: "Where does it go?", sub: "Pick where what you work through should land" },
  connect: { title: "Connect", sub: "Once for each place you picked. Settings can do it later too" },
  tabs: { title: "What do you want to use?", sub: "The tabs to keep in the sidebar" },
};

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "ko", label: "한국어" },
  { code: "ja", label: "日本語" },
  { code: "zh", label: "中文" },
];

const tile = (Icon: LucideIcon) => (
  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-ink/10 bg-paper text-ink-2">
    <Icon size={16} />
  </span>
);

function Choice({
  on,
  onClick,
  icon,
  title,
  detail,
  note,
}: {
  on: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  detail?: string;
  note?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-start gap-3 rounded-xl border px-3 py-3 text-left transition-colors ${
        on ? "border-ink/50 bg-ink/5" : "border-ink/10 hover:border-ink/25"
      }`}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] text-ink">{title}</span>
        {detail && <span className="block text-[13px] text-ink-3">{detail}</span>}
        {note && <span className="block text-[12px] text-ink-4">{note}</span>}
      </span>
      <span
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
          on ? "border-ink bg-ink text-paper" : "border-ink/30"
        }`}
      >
        {on && <Check size={11} />}
      </span>
    </button>
  );
}

export function Onboarding() {
  const settings = useQuery(api.settings.get, {});
  const save = useMutation(api.settings.saveOnboarding);
  const setTabs = useMutation(api.settings.setTabs);
  const setLanguage = useMutation(api.settings.setLanguage);
  const [inputs, setInputs] = useState<string[] | null>(null);
  const [outputs, setOutputs] = useState<string[]>([]);
  const [step, setStep] = useState<Step>("language");
  const [finishing, setFinishing] = useState(false);

  // Seeded once from the saved answers; back from a Notion sign-in, straight
  // to the connect step.
  useEffect(() => {
    if (!settings || inputs !== null) return;
    setInputs(settings.onboarding?.inputs.length ? settings.onboarding.inputs : ["links"]);
    setOutputs(settings.onboarding?.outputs ?? []);
    const params = new URLSearchParams(window.location.search);
    if (params.has("connector")) {
      setStep("connect");
      params.delete("connector");
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    }
  }, [settings, inputs]);

  if (!settings || inputs === null) return null;

  const index = STEPS.indexOf(step);
  const go = async (next: Step) => {
    await save({ inputs, outputs });
    setStep(next);
  };
  const toConnect = [...new Set([...inputs, ...outputs])]
    .map((key) => connectorType(key))
    .filter((t) => t && !t.auth.includes("none"));
  const returnTo = `${window.location.origin}${window.location.pathname}`;
  const mode = (key: string) => MODES.find((m) => m.key === key);

  const finish = async () => {
    setFinishing(true);
    await save({ inputs, outputs, done: true });
  };

  const picker = (direction: ConnectorDirection, chosen: string[], set: (next: string[]) => void) => (
    <div className="grid gap-2 sm:grid-cols-2">
      {connectorsFor(direction).map((t) => {
        const on = chosen.includes(t.key);
        return (
          <Choice
            key={t.key}
            on={on}
            onClick={() => set(on ? chosen.filter((k) => k !== t.key) : [...chosen, t.key])}
            icon={<ConnectorBadge type={t.key} />}
            title={t.label}
            detail={t.blurb.en}
            note={t.connectOnly ? "Connects only; read and write coming" : undefined}
          />
        );
      })}
    </div>
  );

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-paper p-4">
      <div className="w-full max-w-xl max-h-full overflow-y-auto">
        <div className="mb-6 flex gap-1.5">
          {STEPS.map((s, i) => (
            <span key={s} className={`h-1 flex-1 rounded-full ${i <= index ? "bg-ink" : "bg-ink/10"}`} />
          ))}
        </div>
        <h1 className="serif text-2xl text-ink">{TITLE[step].title}</h1>
        <p className="mt-1 mb-5 text-[14px] text-ink-3">{TITLE[step].sub}</p>

        {step === "language" && (
          <div className="grid gap-2 sm:grid-cols-2">
            {LANGUAGES.map((l) => (
              <Choice
                key={l.code}
                on={(settings.language ?? "en") === l.code}
                onClick={() => void setLanguage({ language: l.code })}
                icon={tile(Languages)}
                title={l.label}
              />
            ))}
          </div>
        )}
        {step === "input" && picker("input", inputs, setInputs)}
        {step === "output" && picker("output", outputs, setOutputs)}
        {step === "connect" && (
          <div className="space-y-2">
            {toConnect.length === 0 && <p className="text-[14px] text-ink-3">Nothing to connect.</p>}
            {toConnect.map((t) => (
              <ConnectorCard key={t!.key} type={t!} returnTo={returnTo} open />
            ))}
          </div>
        )}
        {step === "tabs" && (
          <div className="grid gap-2 sm:grid-cols-2">
            {settings.tabs.map((t) => (
              <Choice
                key={t.key}
                on={t.enabled}
                onClick={() =>
                  void setTabs({
                    tabs: settings.tabs.map((x) => (x.key === t.key ? { ...x, enabled: !x.enabled } : x)),
                  })
                }
                icon={tile(mode(t.key)?.icon ?? Link2)}
                title={mode(t.key)?.label ?? t.key}
              />
            ))}
          </div>
        )}

        <div className="mt-8 flex items-center justify-between">
          {index > 0 ? (
            <button
              onClick={() => void go(STEPS[index - 1])}
              className="flex items-center gap-1 text-[14px] text-ink-3 hover:text-ink"
            >
              <ArrowLeft size={14} /> Back
            </button>
          ) : (
            <span />
          )}
          {step === "tabs" ? (
            <button
              onClick={() => void finish()}
              disabled={finishing}
              className="flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[14px] text-paper disabled:opacity-50"
            >
              Start <Check size={14} />
            </button>
          ) : (
            <button
              onClick={() => void go(STEPS[index + 1])}
              className="flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[14px] text-paper"
            >
              Next <ArrowRight size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
