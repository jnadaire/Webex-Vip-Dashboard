const DEFAULT_LANG = "en";
const STORAGE_KEY = "webex-dashboard.lang";

const bundles = {};

export function detectLanguage() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    return saved;
  }
  const nav = (navigator.language || DEFAULT_LANG).split("-")[0];
  return nav || DEFAULT_LANG;
}

export async function loadLanguage(lang) {
  const shortLang = (lang || DEFAULT_LANG).split("-")[0];
  if (!bundles[shortLang]) {
    const [app, labels] = await Promise.all([
      fetch(`/i18n/${shortLang}/app.json`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/i18n/${shortLang}/labels.json`).then((r) => (r.ok ? r.json() : null))
    ]);

    if (!app || !labels) {
      if (shortLang !== DEFAULT_LANG) {
        return loadLanguage(DEFAULT_LANG);
      }
      throw new Error("Missing i18n bundles");
    }

    bundles[shortLang] = { ...app, ...labels };
  }

  localStorage.setItem(STORAGE_KEY, shortLang);
  return { lang: shortLang, t: makeTranslator(bundles[shortLang]) };
}

function makeTranslator(bundle) {
  return (key, fallback = key) => {
    const value = key.split(".").reduce((acc, part) => acc?.[part], bundle);
    return typeof value === "string" ? value : fallback;
  };
}
