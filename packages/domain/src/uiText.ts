// The app's own words in the owner's chosen language. Agent output keeps the
// language set apart from this one; this covers tab names and the few labels
// around them, so one screen never mixes two languages.

export const UI_LANGUAGES = ["ko", "en"] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

export const UI_LABELS = {
  settings: { ko: "설정", en: "Settings" },
  newsletter: { ko: "뉴스레터", en: "Newsletter" },
  paper: { ko: "논문", en: "Paper" },
  article: { ko: "아티클", en: "Article" },
  pr: { ko: "PR", en: "PRs" },
  plan: { ko: "계획", en: "Plans" },
  research: { ko: "연구", en: "Research" },
  diet: { ko: "식단", en: "Diet" },
  vocab: { ko: "단어", en: "Vocab" },
  insights: { ko: "인사이트", en: "Insights" },
  usage: { ko: "사용량", en: "Usage" },
  uiLanguage: { ko: "화면 언어", en: "Display language" },
} as const satisfies Record<string, Record<UiLanguage, string>>;

export type UiLabelKey = keyof typeof UI_LABELS;

export const asUiLanguage = (s: string | null | undefined): UiLanguage => (s === "ko" ? "ko" : "en");

export const uiLabel = (key: UiLabelKey, lang: UiLanguage) => UI_LABELS[key][lang];
