import { useMutation, useQuery } from "convex/react";
import { ArrowLeft, ArrowRight, Check, Languages, Link2, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import {
  UI_LABELS,
  asUiLanguage,
  connectorType,
  connectorsFor,
  uiLabel,
  type ConnectorDirection,
  type UiLabelKey,
  type UiLanguage,
} from "@openworks/domain";
import { api } from "../../convex/_generated/api";
import { ConnectorBadge, ConnectorCard } from "./Connections";
import { MODES } from "./shared/modes";

// A fresh deployment's first screen. The language comes first, since every
// word after it is in that language; then what comes in and what goes out,
// since every other screen is made of them; the connections those need; then
// which tabs to keep. The answers are saved at every step, so a Notion sign-in
// that leaves the page comes back to the connect step.

const STEPS = ["language", "input", "output", "connect", "tabs"] as const;
type Step = (typeof STEPS)[number];

const WORDS = {
  en: {
    language: { title: "Language", sub: "For the app, and for what agents write" },
    input: { title: "What comes in?", sub: "Pick where you read and collect from" },
    output: { title: "Where does it go?", sub: "Pick where what you work through should land" },
    connect: { title: "Connect", sub: "Once for each place you picked. Settings can do it later too" },
    tabs: { title: "What do you want to use?", sub: "The tabs to keep in the sidebar" },
    display: "App language",
    output_language: "Agents write in",
    connectOnly: "Connects only; read and write coming",
    nothing: "Nothing to connect.",
    back: "Back",
    next: "Next",
    start: "Start",
  },
  ko: {
    language: { title: "언어", sub: "앱 화면과 agent가 쓰는 글의 언어" },
    input: { title: "무엇이 들어오나요?", sub: "Input · 읽고 모으는 곳을 고르세요" },
    output: { title: "어디로 내보내나요?", sub: "Output · 정리한 것이 쌓일 곳을 고르세요" },
    connect: { title: "연결하기", sub: "고른 곳마다 한 번씩 연결합니다. 나중에 설정에서 해도 됩니다" },
    tabs: { title: "무엇을 쓰나요?", sub: "사이드바에 둘 탭을 고르세요" },
    display: "앱 언어",
    output_language: "Agent가 쓰는 언어",
    connectOnly: "연결까지만 · 읽기/쓰기는 준비 중",
    nothing: "따로 연결할 것이 없습니다.",
    back: "이전",
    next: "다음",
    start: "시작하기",
  },
};

const APP_LANGUAGES: { code: UiLanguage; label: string }[] = [
  { code: "en", label: "English" },
  { code: "ko", label: "한국어" },
];
const OUTPUT_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "ko", label: "한국어" },
  { code: "ja", label: "日本語" },
  { code: "zh", label: "中文" },
];

const tabIcon = (key: string): LucideIcon => MODES.find((m) => m.key === key)?.icon ?? Link2;
const tabLabel = (key: string, lang: UiLanguage) =>
  key in UI_LABELS ? uiLabel(key as UiLabelKey, lang) : (MODES.find((m) => m.key === key)?.label ?? key);

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

const tile = (Icon: LucideIcon) => (
  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-ink/10 bg-paper text-ink-2">
    <Icon size={16} />
  </span>
);

export function Onboarding() {
  const settings = useQuery(api.settings.get, {});
  const save = useMutation(api.settings.saveOnboarding);
  const setTabs = useMutation(api.settings.setTabs);
  const setUiLanguage = useMutation(api.settings.setUiLanguage);
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

  const lang = asUiLanguage(settings.uiLanguage);
  const t = WORDS[lang];
  const index = STEPS.indexOf(step);
  // The step changes at once; the answers are saved behind it.
  const go = (next: Step) => {
    setStep(next);
    void save({ inputs, outputs });
  };
  const toConnect = [...new Set([...inputs, ...outputs])]
    .map((key) => connectorType(key))
    .filter((c) => c && !c.auth.includes("none"));
  const returnTo = `${window.location.origin}${window.location.pathname}`;

  const finish = async () => {
    setFinishing(true);
    await save({ inputs, outputs, done: true });
  };

  const picker = (direction: ConnectorDirection, chosen: string[], set: (next: string[]) => void) => (
    <div className="grid gap-2 sm:grid-cols-2">
      {connectorsFor(direction).map((c) => {
        const on = chosen.includes(c.key);
        return (
          <Choice
            key={c.key}
            on={on}
            onClick={() => set(on ? chosen.filter((k) => k !== c.key) : [...chosen, c.key])}
            icon={<ConnectorBadge type={c.key} />}
            title={c.label}
            detail={c.blurb[lang]}
            note={c.connectOnly ? t.connectOnly : undefined}
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
        <h1 className="serif text-2xl text-ink">{t[step].title}</h1>
        <p className="mt-1 mb-5 text-[14px] text-ink-3">{t[step].sub}</p>

        {step === "language" && (
          <div className="space-y-5">
            <div className="space-y-2">
              <div className="mono text-[11px] uppercase tracking-wider text-ink-4">{t.display}</div>
              <div className="grid gap-2 sm:grid-cols-2">
                {APP_LANGUAGES.map((l) => (
                  <Choice
                    key={l.code}
                    on={lang === l.code}
                    onClick={() => void setUiLanguage({ uiLanguage: l.code })}
                    icon={tile(Languages)}
                    title={l.label}
                  />
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <div className="mono text-[11px] uppercase tracking-wider text-ink-4">{t.output_language}</div>
              <div className="grid gap-2 sm:grid-cols-2">
                {OUTPUT_LANGUAGES.map((l) => (
                  <Choice
                    key={l.code}
                    on={(settings.language ?? "en") === l.code}
                    onClick={() => void setLanguage({ language: l.code })}
                    icon={tile(Languages)}
                    title={l.label}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
        {step === "input" && picker("input", inputs, setInputs)}
        {step === "output" && picker("output", outputs, setOutputs)}
        {step === "connect" && (
          <div className="space-y-2">
            {toConnect.length === 0 && <p className="text-[14px] text-ink-3">{t.nothing}</p>}
            {toConnect.map((c) => (
              <ConnectorCard key={c!.key} type={c!} lang={lang} returnTo={returnTo} open />
            ))}
          </div>
        )}
        {step === "tabs" && (
          <div className="grid gap-2 sm:grid-cols-2">
            {settings.tabs.map((tab) => (
              <Choice
                key={tab.key}
                on={tab.enabled}
                onClick={() =>
                  void setTabs({
                    tabs: settings.tabs.map((x) => (x.key === tab.key ? { ...x, enabled: !x.enabled } : x)),
                  })
                }
                icon={tile(tabIcon(tab.key))}
                title={tabLabel(tab.key, lang)}
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
              <ArrowLeft size={14} /> {t.back}
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
              {t.start} <Check size={14} />
            </button>
          ) : (
            <button
              onClick={() => void go(STEPS[index + 1])}
              className="flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[14px] text-paper"
            >
              {t.next} <ArrowRight size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
