import { t } from "../i18n";
import { pageGlobal, toPageArray } from "./page";
import { ceilPrice, floorPrice, priceAbove, toInt } from "./prices";
import { loadJson, loadLegacy, saveJson } from "./storage";

// A filter = a snipe target (player / criteria) + its buy and sell prices.
// Its default name ("New filter") is translated in normalizeFilter, when the filter is created.
export const DEFAULT_FILTER = {
  id: "",
  name: "",
  enabled: true,
  type: "player",
  player: null, // { id: baseId, name, rating }
  definitionId: 0, // exact version of a card (optional)
  level: "any",
  rarities: [],
  position: "any",
  zone: -1,
  nation: -1,
  league: -1,
  club: -1,
  playStyle: -1,
  category: "any",
  minRating: 0,
  maxRating: 0,
  minBuy: 0,
  maxBuy: 0, // max buy price (BIN); in FUTBIN mode, optional absolute cap
  priceMode: "fixed", // "fixed" | "futbin" (buy at X% of the FUTBIN price)
  futbinPercent: 90,
  sellMode: "global", // "global" (Sell tab) | "fixed" | "futbin"
  sellPrice: 0,
  sellPercent: "",
  maxBid: 0,
};

const STORAGE_KEY = "filters";
const listeners = new Set();

const makeId = () =>
  `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export const normalizeFilter = (raw) => {
  const filter = Object.assign({}, DEFAULT_FILTER, raw || {});
  if (!raw || !Object.prototype.hasOwnProperty.call(raw, "name")) {
    filter.name = t("core.filter.newName");
  }
  filter.id = filter.id || makeId();
  filter.name = String(filter.name || "").trim() || t("core.filter.fallbackName");
  filter.enabled = filter.enabled !== false;
  filter.type = filter.type || "player";
  const player = filter.player;
  filter.player =
    player && toInt(player.id)
      ? {
          id: toInt(player.id) & 0xffffff,
          name: String(player.name || "").trim(),
          rating: toInt(player.rating),
        }
      : null;
  filter.definitionId = toInt(filter.definitionId);
  filter.rarities = (Array.isArray(filter.rarities) ? filter.rarities : [])
    .map((value) => parseInt(value, 10))
    .filter((value) => Number.isFinite(value) && value >= 0);
  // EA FC 27 zones: 130 defense, 131 midfield, 132 attack (-1 = none).
  ["nation", "league", "club", "playStyle", "zone"].forEach((key) => {
    const n = parseInt(filter[key], 10);
    filter[key] = Number.isFinite(n) && n > 0 ? n : -1;
  });
  ["minRating", "maxRating", "minBuy", "maxBuy", "sellPrice", "maxBid"].forEach(
    (key) => {
      filter[key] = toInt(filter[key]);
    }
  );
  ["level", "position", "category"].forEach((key) => {
    filter[key] = filter[key] ? String(filter[key]) : "any";
  });
  filter.priceMode = filter.priceMode === "futbin" ? "futbin" : "fixed";
  const percent = parseFloat(filter.futbinPercent);
  filter.futbinPercent = Number.isFinite(percent) ? Math.min(150, Math.max(10, percent)) : 90;
  // Filters saved before resale modes existed: an entered resale price keeps priority.
  const wantedSell = raw && raw.sellMode;
  filter.sellMode = ["global", "fixed", "futbin"].includes(wantedSell)
    ? wantedSell
    : filter.sellPrice > 0
    ? "fixed"
    : "global";
  filter.sellPercent = String(filter.sellPercent || "").trim();
  return filter;
};

// Card whose FUTBIN price is the filter's reference (exact version, otherwise the base card).
export const futbinKeyForFilter = (filter) =>
  (filter && (filter.definitionId || (filter.player && filter.player.id))) || 0;

// Migration of v4 filters (localStorage "mbSavedFilters").
const migrateLegacy = () => {
  const legacy = loadLegacy("mbSavedFilters");
  if (!Array.isArray(legacy) || !legacy.length) {
    return [];
  }
  return legacy
    .map((entry) => {
      const criteria = (entry && entry.criteria) || {};
      const player = entry && entry.player;
      return normalizeFilter({
        name: entry && entry.name,
        player:
          player && (player.eaId || player.id)
            ? {
                id: player.eaId || player.id,
                name: player.name,
                rating: player.rating,
              }
            : null,
        level: criteria.level === "special" ? "SP" : criteria.level,
        position: criteria.position,
        nation: criteria.nation || criteria.nationality,
        league: criteria.league,
        club: criteria.club,
        minBuy: criteria.minBuy,
        maxBuy: criteria.maxBuy,
        maxBid: criteria.maxBid,
      });
    })
    .filter((filter) => filter.player || filter.maxBuy);
};

const load = () => {
  const stored = loadJson(STORAGE_KEY, null);
  if (stored && Array.isArray(stored.list)) {
    return {
      list: stored.list.map(normalizeFilter),
      activeId: stored.activeId || null,
      rotation: Object.assign(
        { enabled: false, every: 3, random: false },
        stored.rotation || {}
      ),
      lastEaSearch: stored.lastEaSearch || null,
    };
  }
  const migrated = migrateLegacy();
  const list = migrated.length ? migrated : [normalizeFilter({ name: t("core.filter.myFilter") })];
  return {
    list,
    activeId: list[0].id,
    rotation: { enabled: false, every: 3, random: false },
    lastEaSearch: null,
  };
};

let data = load();

const emit = () => {
  saveJson(STORAGE_KEY, data);
  listeners.forEach((fn) => {
    try {
      fn(data);
    } catch (e) {}
  });
};

export const onFiltersChange = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const getFilters = () => data.list;
export const getRotation = () => data.rotation;

export const getActiveFilter = () =>
  data.list.find((filter) => filter.id === data.activeId) || data.list[0] || null;

export const setActiveFilter = (id) => {
  if (data.list.some((filter) => filter.id === id)) {
    data = Object.assign({}, data, { activeId: id });
    emit();
  }
};

export const updateFilter = (id, patch) => {
  data = Object.assign({}, data, {
    list: data.list.map((filter) =>
      filter.id === id ? normalizeFilter(Object.assign({}, filter, patch, { id })) : filter
    ),
  });
  emit();
};

export const addFilter = (raw, activate = true) => {
  const filter = normalizeFilter(Object.assign({}, raw, { id: "" }));
  data = Object.assign({}, data, {
    list: data.list.concat(filter),
    activeId: activate ? filter.id : data.activeId,
  });
  emit();
  return filter;
};

export const duplicateFilter = (id) => {
  const source = data.list.find((filter) => filter.id === id);
  if (!source) {
    return null;
  }
  return addFilter(Object.assign({}, source, { name: t("core.filter.copyName", { name: source.name }) }));
};

export const removeFilter = (id) => {
  let list = data.list.filter((filter) => filter.id !== id);
  if (!list.length) {
    list = [normalizeFilter({ name: t("core.filter.myFilter") })];
  }
  const activeId = list.some((filter) => filter.id === data.activeId)
    ? data.activeId
    : list[0].id;
  data = Object.assign({}, data, { list, activeId });
  emit();
};

export const setRotation = (patch) => {
  data = Object.assign({}, data, {
    rotation: Object.assign({}, data.rotation, patch),
  });
  emit();
};

export const setLastEaSearch = (snapshot) => {
  data = Object.assign({}, data, { lastEaSearch: snapshot });
  emit();
};

export const getLastEaSearch = () => data.lastEaSearch;

// Filters used by the bot: the rotation (checked filters) or the active filter alone.
export const runnableFilters = () => {
  if (data.rotation.enabled) {
    const enabled = data.list.filter((filter) => filter.enabled);
    if (enabled.length) {
      return enabled;
    }
  }
  const active = getActiveFilter();
  return active ? [active] : [];
};

// A target = a player, an exact version or at least one restrictive criterion.
// A price alone is not enough (otherwise the bot would buy any player under that price).
export const filterHasTarget = (filter) =>
  !!(
    filter &&
    ((filter.player && filter.player.id) ||
      filter.definitionId ||
      filter.rarities.length ||
      filter.level !== "any" ||
      filter.nation > 0 ||
      filter.league > 0 ||
      filter.club > 0 ||
      filter.playStyle > 0 ||
      filter.zone > 0 ||
      (filter.position && filter.position !== "any") ||
      filter.minRating ||
      filter.maxRating)
  );

export const describeFilter = (filter) => {
  if (!filter) {
    return t("core.filter.describe.none");
  }
  const parts = [];
  if (filter.player) {
    parts.push(
      `${filter.player.name || t("core.filter.describe.player")}${filter.player.rating ? ` ${filter.player.rating}` : ""}`
    );
  } else if (filter.definitionId) {
    parts.push(t("core.filter.describe.card", { id: filter.definitionId }));
  } else {
    parts.push(t("core.filter.describe.allPlayers"));
  }
  const levels = {
    bronze: "core.filter.level.bronze",
    silver: "core.filter.level.silver",
    gold: "core.filter.level.gold",
    SP: "core.filter.level.special",
  };
  if (levels[filter.level]) {
    parts.push(t(levels[filter.level]));
  }
  if (filter.rarities.length) {
    parts.push(t("core.filter.describe.rarity", { list: filter.rarities.join("/") }));
  }
  if (filter.position && filter.position !== "any") {
    parts.push(filter.position);
  }
  if (filter.minRating || filter.maxRating) {
    parts.push(
      t("core.filter.describe.rating", { min: filter.minRating || "…", max: filter.maxRating || "…" })
    );
  }
  if (filter.priceMode === "futbin") {
    parts.push(t("core.filter.describe.futbinBuy", { percent: filter.futbinPercent }));
  }
  return parts.join(" · ");
};

// "Empty" criteria outside the web app (tests): same defaults as UTSearchCriteriaDTO.
const plainCriteria = () => ({
  type: "any",
  category: "any",
  position: "any",
  zone: -1,
  level: "any",
  rarities: [],
  defId: [],
  maskedDefId: 0,
  nation: -1,
  league: -1,
  club: -1,
  playStyle: -1,
  minBid: 0,
  maxBid: 0,
  minBuy: 0,
  maxBuy: 0,
  offset: 0,
  count: 21,
  authenticity: "any",
  primaryColor: -1,
  secondaryColor: -1,
  icontraits: "any",
});

// Builds a real FC 27 UTSearchCriteriaDTO. Careful: the `type` setter resets
// nation/subtypes, so it must be assigned first.
export const buildCriteria = (filter, prices = {}) => {
  const Dto = pageGlobal("UTSearchCriteriaDTO");
  let criteria;
  try {
    criteria = typeof Dto === "function" ? new Dto() : plainCriteria();
  } catch (e) {
    criteria = plainCriteria();
  }
  criteria.type = filter.type || "player";
  if (filter.category && filter.category !== "any") {
    criteria.category = filter.category;
  }
  if (filter.level && filter.level !== "any") {
    criteria.level = filter.level;
  }
  if (filter.rarities.length) {
    criteria.rarities = toPageArray(filter.rarities);
  }
  if (filter.zone >= 0) {
    criteria.zone = filter.zone;
  } else if (filter.position && filter.position !== "any") {
    criteria.position = filter.position;
  }
  if (filter.nation > 0) {
    criteria.nation = filter.nation;
  }
  if (filter.league > 0) {
    criteria.league = filter.league;
  }
  if (filter.club > 0) {
    criteria.club = filter.club;
  }
  if (filter.playStyle > 0) {
    criteria.playStyle = filter.playStyle;
  }
  // On EA's side, defId (exact version) takes priority over maskedDefId (all versions).
  if (filter.definitionId > 0) {
    criteria.defId = toPageArray([filter.definitionId]);
  } else if (filter.player && filter.player.id > 0) {
    criteria.maskedDefId = filter.player.id;
  }
  const minBuy = toInt(prices.minBuy != null ? prices.minBuy : filter.minBuy);
  const maxBuy = toInt(prices.maxBuy != null ? prices.maxBuy : filter.maxBuy);
  const minBid = toInt(prices.minBid);
  const maxBid = toInt(prices.maxBid);
  // Max rounded down, min rounded up: never beyond what was entered.
  if (minBuy) {
    criteria.minBuy = ceilPrice(minBuy);
  }
  if (maxBuy) {
    criteria.maxBuy = floorPrice(maxBuy);
  }
  if (minBid) {
    criteria.minBid = ceilPrice(minBid);
  }
  if (maxBid) {
    criteria.maxBid = floorPrice(maxBid);
  }
  return criteria;
};

// EA cache buster: each search needs a different URL to get fresh results.
// "auto" mode varies the max bid ABOVE the max buy price: no buyable
// listing is ever excluded (bid < BIN ≤ max price).
export const cacheBusterPrices = (mode, step, { maxBuy, minBuy, maxBid, cap }) => {
  const out = { minBuy, maxBuy, maxBid, minBid: 0 };
  const variants = 20;
  const index = step % variants;
  const capped = Math.max(150, toInt(cap) || 1000);
  const ladder = (from, count) => {
    let value = ceilPrice(from) || 150;
    for (let i = 0; i < count; i += 1) {
      value = priceAbove(value);
    }
    return value;
  };
  let effective = mode;
  if (effective === "auto") {
    effective = maxBuy && !maxBid ? "maxBid" : "minBuy";
  }
  if (effective === "maxBid" && maxBuy) {
    out.maxBid = ladder(maxBuy, index);
    return out;
  }
  if (effective === "minBuy") {
    const ceiling = maxBuy ? Math.min(capped, Math.floor(maxBuy * 0.5)) : capped;
    if (ceiling >= 150 && !minBuy) {
      const choices = [];
      for (let v = 150; v <= ceiling && choices.length < 40; v = priceAbove(v)) {
        choices.push(v);
      }
      out.minBuy = choices.length ? choices[index % choices.length] : 0;
    }
    return out;
  }
  if (effective === "minBid") {
    const ceiling = Math.min(capped, maxBid ? Math.floor(maxBid * 0.5) : capped);
    const choices = [];
    for (let v = 150; v <= ceiling && choices.length < 40; v = priceAbove(v)) {
      choices.push(v);
    }
    out.minBid = choices.length ? choices[index % choices.length] : 0;
    return out;
  }
  return out;
};

// Serializable snapshot of an EA market search (import from the native UI).
export const snapshotFromEaCriteria = (criteria, playerData) => {
  if (!criteria) {
    return null;
  }
  const read = (key, fallback) => {
    try {
      const value = criteria[key];
      return value == null ? fallback : value;
    } catch (e) {
      return fallback;
    }
  };
  const defIds = read("defId", []);
  const rarities = read("rarities", []);
  let player = null;
  try {
    if (playerData) {
      const data = Array.isArray(playerData) ? playerData[0] : playerData;
      const id = toInt(
        data && (data.id || data.databaseId || data.assetId || data.definitionId)
      );
      if (id) {
        const name =
          (data.commonName || data.knownAs || "").trim() ||
          `${data.firstName || ""} ${data.lastName || ""}`.trim() ||
          data.name ||
          "";
        player = { id: id & 0xffffff, name, rating: toInt(data.rating) };
      }
    }
  } catch (e) {}
  const masked = toInt(read("maskedDefId", 0));
  if (!player && masked) {
    player = { id: masked & 0xffffff, name: "", rating: 0 };
  }
  const signed = (key) => {
    const n = parseInt(read(key, -1), 10);
    return Number.isFinite(n) && n > 0 ? n : -1;
  };
  return {
    type: read("type", "player") === "any" ? "player" : read("type", "player"),
    category: read("category", "any"),
    level: read("level", "any"),
    rarities: Array.from(rarities || []).map(Number),
    position: read("position", "any"),
    zone: signed("zone"),
    nation: signed("nation"),
    league: signed("league"),
    club: signed("club"),
    playStyle: signed("playStyle"),
    definitionId: defIds && defIds.length ? toInt(defIds[0]) : 0,
    player,
    minBuy: toInt(read("minBuy", 0)),
    maxBuy: toInt(read("maxBuy", 0)),
    maxBid: toInt(read("maxBid", 0)),
    capturedAt: Date.now(),
  };
};
