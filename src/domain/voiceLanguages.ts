export const VOICE_LANGUAGES = ["auto", "pt", "en", "es", "fr", "de", "it", "nl", "pl", "ru", "uk", "tr", "ar", "hi", "zh", "ja", "ko"] as const;

export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

export const DEFAULT_VOICE_LANGUAGE: VoiceLanguage = "auto";

export const VOICE_LANGUAGE_ENDONYMS: Readonly<Record<Exclude<VoiceLanguage, "auto">, string>> = {
  pt: "Português",
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
  nl: "Nederlands",
  pl: "Polski",
  ru: "Русский",
  uk: "Українська",
  tr: "Türkçe",
  ar: "العربية",
  hi: "हिन्दी",
  zh: "中文",
  ja: "日本語",
  ko: "한국어",
};

export function isVoiceLanguage(value: unknown): value is VoiceLanguage {
  return typeof value === "string" && (VOICE_LANGUAGES as readonly string[]).includes(value);
}
