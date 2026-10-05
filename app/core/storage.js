// Persistent storage: GM_setValue (invisible to the EA page) with a localStorage fallback.

const PREFIX = "mb5.";

const gmGet = typeof GM_getValue === "function" ? GM_getValue : null;
const gmSet = typeof GM_setValue === "function" ? GM_setValue : null;

export const loadJson = (key, fallback) => {
  try {
    if (gmGet) {
      const raw = gmGet(PREFIX + key, null);
      if (raw != null) {
        return typeof raw === "string" ? JSON.parse(raw) : raw;
      }
    }
  } catch (e) {}
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw != null) {
      return JSON.parse(raw);
    }
  } catch (e) {}
  return fallback;
};

export const saveJson = (key, value) => {
  const raw = JSON.stringify(value);
  let ok = false;
  try {
    if (gmSet) {
      gmSet(PREFIX + key, raw);
      ok = true;
    }
  } catch (e) {}
  if (!ok) {
    try {
      window.localStorage.setItem(PREFIX + key, raw);
      ok = true;
    } catch (e) {}
  }
  return ok;
};

// Raw read of an old localStorage key (migration from previous versions).
export const loadLegacy = (key) => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
};
