import { getSetting, onSettingsChange, setSetting } from "../core/settings";
import { services } from "../core/page";
import en from "./locales/en";
import es from "./locales/es";

// Interface translations. English is the reference dictionary: a key missing in Spanish
// falls back to English, and a key missing everywhere renders as the key itself.

export const LANGUAGES = ["en", "es"];
export const LANGUAGE_CHOICES = ["auto", ...LANGUAGES];

const DICTIONARIES = { en, es };
const NUMBER_LOCALES = { en: "en-US", es: "es-MX" };

const pickLanguage = (tag) => {
  const value = String(tag || "").toLowerCase();
  return value.startsWith("es") ? "es" : value ? "en" : null;
};

// Language of the EA web app, then of the browser. Unknown or unsupported locales use English.
const detectLanguage = () => {
  try {
    const localization = services() && services().Localization;
    const fromEa =
      localization &&
      (localization.locale ||
        (typeof localization.getLocale === "function" ? localization.getLocale() : null));
    const picked = pickLanguage(typeof fromEa === "string" ? fromEa : null);
    if (picked) {
      return picked;
    }
  } catch (e) {}
  try {
    const picked = pickLanguage(document.documentElement && document.documentElement.lang);
    if (picked) {
      return picked;
    }
  } catch (e) {}
  try {
    return pickLanguage(navigator.language) || "en";
  } catch (e) {
    return "en";
  }
};

/** Language preference as stored: "auto", "en" or "es". */
export const getLanguageChoice = () => {
  const choice = getSetting("ui.language");
  return LANGUAGE_CHOICES.includes(choice) ? choice : "auto";
};

/** Language actually used to render text: "en" or "es". */
export const getLanguage = () => {
  const choice = getLanguageChoice();
  return choice === "auto" ? detectLanguage() : choice;
};

export const setLanguageChoice = (choice) => {
  setSetting("ui.language", LANGUAGE_CHOICES.includes(choice) ? choice : "auto");
};

/** Intl locale for numbers, dates and times in the active language. */
export const numberLocale = () => NUMBER_LOCALES[getLanguage()] || NUMBER_LOCALES.en;

const interpolate = (text, params) =>
  params
    ? text.replace(/\{(\w+)\}/g, (match, name) =>
        params[name] === undefined || params[name] === null ? match : String(params[name])
      )
    : text;

/**
 * Translates a key into the active language.
 * Placeholders use braces: t("engine.bought", { name: "Mbappé", price: "45,000" }).
 */
export const t = (key, params) => {
  const dictionary = DICTIONARIES[getLanguage()] || en;
  const text = dictionary[key] !== undefined ? dictionary[key] : en[key];
  return interpolate(text === undefined ? key : String(text), params);
};

/** Calls fn whenever the language preference changes. Returns an unsubscribe function. */
export const onLanguageChange = (fn) =>
  onSettingsChange((settings, path) => {
    if (path === "ui.language" || path === "*") {
      fn(getLanguage());
    }
  });
