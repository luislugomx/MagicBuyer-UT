import { getSettings } from "../core/settings";
import { loadJson, saveJson } from "../core/storage";
import { t } from "../i18n";
import { getUserPlatform } from "../utils/userUtil";
import { absoluteUrl, isPlausiblePrice } from "./futbinParse";
import {
  fetchFutbinPrice,
  futbinDirectPausedUntil,
  resetFutbinClientForTests,
  resolveFutbinLink,
} from "./futbinClient";

// FUTBIN prices kept up to date smartly:
// - bot targets and SBC purchases ("hot"): re-read every 60 to 120 s (configurable);
// - cards shown on screen ("visible"): re-read when older than ~2 min,
//   a bit less often when the price does not move (never beyond 6 min);
// - one FUTBIN request at a time, spaced out, with automatic slowdown when FUTBIN blocks;
// - an abnormal price jump is checked a second time before the bot uses it.

const LINKS_KEY = "futbinLinks";
const PRICES_KEY = "futbinPrices";
const PRIORITY = { hot: 0, request: 1, visible: 2 };
const MISS_RETRY = 30 * 60 * 1000;
const ERROR_RETRY = 90 * 1000;
const NO_PRICE_RETRY = 10 * 60 * 1000;
const SUSPECT_RECHECK = 20 * 1000;
const MAX_VISIBLE_AGE = 6 * 60 * 1000;
const STALE_GUARD = 30 * 60 * 1000;

let links = loadJson(LINKS_KEY, {}) || {};
const records = new Map();
const interest = new Map();
const queue = new Map();
const inflight = new Set();
const waiters = new Map();
const listeners = new Set();
const status = {
  state: "idle",
  requests: 0,
  lastError: "",
  lastSuccessAt: 0,
  blockedUntil: 0,
  backoffMs: 0,
};
let busy = false;
let lastRequestAt = 0;
let pumpTimer = null;
let saveTimer = null;
let tickTimer = null;

// Prices remembered from the last load (shown with their age).
(() => {
  const stored = loadJson(PRICES_KEY, {}) || {};
  Object.keys(stored).forEach((key) => {
    const value = stored[key];
    if (value && value.price && Date.now() - value.fetchedAt < 60 * 60 * 1000) {
      records.set(Number(key), Object.assign({ suspect: null, unchanged: 0, failures: 0 }, value));
    }
  });
})();

const settings = () => getSettings().prices;

export const pricePlatform = () => {
  const chosen = settings().platform;
  if (chosen === "pc" || chosen === "console") {
    return chosen;
  }
  return getUserPlatform() === "pc" ? "pc" : "console";
};

const emit = (definitionId) => {
  const record = records.get(definitionId) || null;
  listeners.forEach((fn) => {
    try {
      fn(definitionId, record);
    } catch (e) {}
  });
};

export const onPriceUpdate = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

// status.lastError holds a translation key; it is resolved here so the text follows the active language.
export const getFutbinStatus = () =>
  Object.assign({ queue: queue.size, tracked: interest.size }, status, {
    lastError: status.lastError ? t(status.lastError) : "",
  });

const persistSoon = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const out = {};
    const cutoff = Date.now() - 60 * 60 * 1000;
    Array.from(records.entries())
      .filter(([, record]) => record.price && record.fetchedAt > cutoff)
      .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
      .slice(0, 800)
      .forEach(([id, record]) => {
        out[id] = {
          definitionId: id,
          price: record.price,
          prices: record.prices,
          updatedAgoSec: record.updatedAgoSec,
          fetchedAt: record.fetchedAt,
          changedAt: record.changedAt,
          url: record.url,
          platform: record.platform,
        };
      });
    saveJson(PRICES_KEY, out);
    // FUTBIN links: only the 2,000 most recent.
    const keys = Object.keys(links);
    if (keys.length > 2000) {
      const kept = {};
      keys
        .sort((a, b) => (links[b].at || 0) - (links[a].at || 0))
        .slice(0, 2000)
        .forEach((key) => {
          kept[key] = links[key];
        });
      links = kept;
    }
    saveJson(LINKS_KEY, links);
  }, 3000);
};

export const getPriceRecord = (definitionId) => records.get(Number(definitionId)) || null;

// Usable price: known, for the right platform, confirmed less than maxAgeMs ago.
// While a price jump is being checked, stay cautious: to buy, the lower of the two prices;
// to sell, the higher (never overpay or undersell on a wrong price).
export const currentPrice = (definitionId, maxAgeMs = 5 * 60 * 1000, use = "display") => {
  const record = getPriceRecord(definitionId);
  if (!record || !record.price || record.platform !== pricePlatform()) {
    return 0;
  }
  if (Date.now() - record.fetchedAt > maxAgeMs) {
    return 0;
  }
  const suspect = record.suspect && record.suspect.price;
  if (suspect && use === "buy") {
    return Math.min(record.price, suspect);
  }
  if (suspect && use === "sell") {
    return Math.max(record.price, suspect);
  }
  return record.price;
};

export const priceAgeMs = (definitionId) => {
  const record = getPriceRecord(definitionId);
  return record && record.fetchedAt ? Date.now() - record.fetchedAt : Infinity;
};

// ------------------------------------------------------------- subscription

// Declares interest in a card. kind: "hot" (bot, SBC purchase) or "visible" (label).
export const trackPrice = (definitionId, hint, kind = "visible") => {
  const id = Number(definitionId) || 0;
  if (!id) {
    return () => {};
  }
  const entry = interest.get(id) || { hot: 0, visible: 0, hint: {} };
  entry[kind === "hot" ? "hot" : "visible"] += 1;
  entry.hint = Object.assign({}, entry.hint, hint || {});
  interest.set(id, entry);
  ensureTicker();
  schedule(id);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const current = interest.get(id);
    if (!current) {
      return;
    }
    current[kind === "hot" ? "hot" : "visible"] = Math.max(0, current[kind === "hot" ? "hot" : "visible"] - 1);
    if (!current.hot && !current.visible) {
      interest.delete(id);
    }
  };
};

// Explicit request (e.g. listing for sale): resolves the record once the read is done.
export const requestPrice = (definitionId, hint) => {
  const id = Number(definitionId) || 0;
  if (!id) {
    return Promise.resolve(null);
  }
  const entry = interest.get(id);
  if (entry) {
    entry.hint = Object.assign({}, entry.hint, hint || {});
  }
  return new Promise((resolve) => {
    const list = waiters.get(id) || [];
    list.push(resolve);
    waiters.set(id, list);
    enqueue(id, PRIORITY.request, hint);
  });
};

const settle = (id) => {
  const list = waiters.get(id);
  if (!list) {
    return;
  }
  waiters.delete(id);
  const record = records.get(id) || null;
  list.forEach((resolve) => resolve(record));
};

// ------------------------------------------------------------- scheduling

const hotInterval = () => Math.min(120, Math.max(60, Number(settings().hotInterval) || 90)) * 1000;
const visibleInterval = () => Math.min(600, Math.max(60, Number(settings().visibleInterval) || 120)) * 1000;

const dueIn = (id, entry, now) => {
  const record = records.get(id);
  if (record && record.nextRetryAt && record.nextRetryAt > now) {
    return record.nextRetryAt - now;
  }
  if (!record || !record.fetchedAt || record.platform !== pricePlatform()) {
    return 0;
  }
  if (record.suspect) {
    // Price jump awaiting confirmation: rechecked quickly, whatever the use.
    return Math.max(0, SUSPECT_RECHECK - (now - record.suspect.at));
  }
  const age = now - record.fetchedAt;
  let maxAge;
  if (entry.hot) {
    maxAge = hotInterval();
  } else {
    const hidden = typeof document !== "undefined" && document.hidden;
    if (hidden) {
      return Infinity;
    }
    const factor = [1, 1, 1.5, 2, 3][Math.min(record.unchanged || 0, 4)];
    maxAge = Math.min(visibleInterval() * factor, MAX_VISIBLE_AGE);
  }
  return Math.max(0, maxAge - age);
};

const schedule = (id) => {
  const entry = interest.get(id);
  if (!entry) {
    return;
  }
  if (dueIn(id, entry, Date.now()) <= 0) {
    enqueue(id, entry.hot ? PRIORITY.hot : PRIORITY.visible, entry.hint);
  }
};

const ensureTicker = () => {
  if (tickTimer) {
    return;
  }
  tickTimer = setInterval(() => {
    interest.forEach((entry, id) => schedule(id));
  }, 1000);
};

const enqueue = (id, priority, hint) => {
  if (inflight.has(id)) {
    return;
  }
  const existing = queue.get(id);
  if (existing) {
    existing.priority = Math.min(existing.priority, priority);
    existing.hint = Object.assign({}, existing.hint, hint || {});
  } else {
    queue.set(id, { id, priority, hint: Object.assign({}, hint || {}), at: Date.now() });
  }
  pump();
};

const nextJob = () => {
  let best = null;
  queue.forEach((job) => {
    if (!best || job.priority < best.priority || (job.priority === best.priority && job.at < best.at)) {
      best = job;
    }
  });
  return best;
};

const gapMs = () => {
  const base = Math.max(0.8, Number(settings().minGap) || 1.5) * 1000;
  return base + Math.random() * 500 + status.backoffMs;
};

const pump = () => {
  if (busy || pumpTimer || !queue.size) {
    return;
  }
  const now = Date.now();
  const waitBlocked = status.blockedUntil > now ? status.blockedUntil - now : 0;
  const waitGap = Math.max(0, lastRequestAt + gapMs() - now);
  const wait = Math.max(waitBlocked, waitGap);
  if (wait > 0) {
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      pump();
    }, wait);
    return;
  }
  const job = nextJob();
  if (!job) {
    return;
  }
  queue.delete(job.id);
  inflight.add(job.id);
  busy = true;
  status.state = "fetching";
  processJob(job)
    .catch(() => {})
    .finally(() => {
      inflight.delete(job.id);
      busy = false;
      lastRequestAt = Date.now();
      status.state = queue.size ? "queued" : status.blockedUntil > Date.now() ? "blocked" : "idle";
      settle(job.id);
      pump();
    });
};

const markBlocked = (message) => {
  status.backoffMs = Math.min(Math.max(status.backoffMs * 2, 5000), 60000);
  status.blockedUntil = Date.now() + Math.min(status.backoffMs * 4, 5 * 60 * 1000);
  status.lastError = message;
  status.state = "blocked";
};

const markSuccess = () => {
  status.backoffMs = Math.max(0, Math.floor(status.backoffMs / 2));
  status.lastError = "";
  status.lastSuccessAt = Date.now();
};

const baseRecord = (id) =>
  records.get(id) || { definitionId: id, price: 0, prices: [], fetchedAt: 0, unchanged: 0, failures: 0, suspect: null };

const BLOCKED_MESSAGE = "prices.status.blocked";

const setRecord = (id, record, patch) => {
  records.set(id, Object.assign(record, patch));
  emit(id);
};

// Failed read: retry tuned to the cause (never "not found" for a plain network error).
const handleFailure = (id, record, result, now, link) => {
  if (result.deferred) {
    // Direct request refused recently: displayed cards wait without sending anything.
    setRecord(id, record, { status: "paused", nextRetryAt: Math.max(futbinDirectPausedUntil(), now + ERROR_RETRY) });
  } else if (result.blocked) {
    markBlocked(BLOCKED_MESSAGE);
    setRecord(id, record, { status: "error", nextRetryAt: status.blockedUntil });
  } else if (result.noPrice) {
    setRecord(id, record, { status: "miss", url: link ? link.url : record.url, nextRetryAt: now + NO_PRICE_RETRY });
  } else {
    record.failures = (record.failures || 0) + 1;
    setRecord(id, record, { status: "error", nextRetryAt: now + ERROR_RETRY });
  }
};

const processJob = async (job) => {
  const id = job.id;
  const now = Date.now();
  const record = baseRecord(id);
  // The hidden FUTBIN page (fallback) is reserved for the bot, SBCs and explicit requests.
  const options = { allowIframe: job.priority !== PRIORITY.visible };
  let link = links[id];
  if (link && link.miss && link.until > now) {
    setRecord(id, record, { status: "miss", nextRetryAt: link.until });
    return;
  }
  if (!link || link.miss) {
    status.requests += 1;
    const resolved = await resolveFutbinLink(Object.assign({ definitionId: id }, job.hint), options);
    if (!resolved.ok) {
      if (resolved.notFound) {
        links[id] = { miss: true, until: now + MISS_RETRY, at: now };
        setRecord(id, record, { status: "miss", nextRetryAt: now + MISS_RETRY });
        persistSoon();
      } else {
        handleFailure(id, record, resolved, now, null);
      }
      return;
    }
    link = Object.assign({}, resolved.link, { at: now });
    links[id] = link;
    persistSoon();
  }
  status.requests += 1;
  const platform = pricePlatform();
  const result = await fetchFutbinPrice(link, platform, options);
  if (!result.ok) {
    if (result.notFound) {
      delete links[id];
      setRecord(id, record, { status: "error", nextRetryAt: now + ERROR_RETRY });
    } else {
      handleFailure(id, record, result, now, link);
    }
    return;
  }
  // The page read must belong to the requested card (EA id declared by FUTBIN, when present).
  if (result.pageEaId && result.pageEaId !== id && (result.pageEaId & 0xffffff) !== (id & 0xffffff)) {
    delete links[id];
    persistSoon();
    setRecord(id, record, { status: "error", nextRetryAt: now + ERROR_RETRY });
    return;
  }
  markSuccess();
  applyPrice(id, record, result, link, platform);
};

const applyPrice = (id, record, result, link, platform) => {
  const now = Date.now();
  const guard = Math.max(5, Number(settings().jumpGuard) || 35);
  // A price older than 30 min (e.g. reloaded at startup) is not used as the guard's reference.
  const previous = record.platform === platform && now - (record.fetchedAt || 0) < STALE_GUARD ? record.price : 0;
  const next = result.price;
  const jump = previous ? (Math.abs(next - previous) / previous) * 100 : 0;
  if (previous && jump > guard) {
    const suspect = record.suspect;
    const confirmed = suspect && Math.abs(next - suspect.price) / suspect.price <= 0.1;
    if (!confirmed) {
      // Abnormal jump: the confirmed price and its age are kept (it ages normally),
      // the new price is rechecked in 20 s before being adopted.
      setRecord(id, record, { status: "ok", failures: 0, nextRetryAt: 0, url: link.url, suspect: { price: next, at: now } });
      persistSoon();
      return;
    }
  }
  const changed = next !== previous;
  setRecord(id, record, {
    prices: result.prices,
    updatedAgoSec: result.updatedAgoSec,
    fetchedAt: now,
    url: link.url,
    name: link.name,
    platform,
    status: "ok",
    failures: 0,
    nextRetryAt: 0,
    price: next,
    previous: previous || record.previous || 0,
    changedAt: changed ? now : record.changedAt || now,
    unchanged: changed ? 0 : (record.unchanged || 0) + 1,
    suspect: null,
  });
  persistSoon();
};

// Price read elsewhere on FUTBIN (e.g. squad page JSON): same handling as a player page read
// (guard included). The provided FUTBIN link saves a search on the next refresh.
export const seedFutbinPrice = (definitionId, { price, platform, link }) => {
  const id = Number(definitionId) || 0;
  if (!id) {
    return;
  }
  if (link && link.futbinId && (!links[id] || links[id].miss)) {
    links[id] = { futbinId: link.futbinId, url: absoluteUrl(link.url), name: link.name || "", rating: link.rating || 0, at: Date.now() };
    persistSoon();
  }
  if (!isPlausiblePrice(Number(price)) || platform !== pricePlatform()) {
    return;
  }
  const record = baseRecord(id);
  if (record.fetchedAt && Date.now() - record.fetchedAt < 30 * 1000 && record.platform === platform) {
    return; // more recent player page read
  }
  const target = links[id] && !links[id].miss ? links[id] : { url: record.url || "", name: record.name || "" };
  applyPrice(id, record, { price: Number(price), prices: [Number(price)], updatedAgoSec: null }, target, platform);
};

export const clearFutbinCache = () => {
  links = {};
  records.clear();
  const pending = Array.from(queue.keys());
  queue.clear();
  // Pending requests are resolved (without a price) rather than left unanswered.
  pending.forEach((id) => settle(id));
  saveJson(LINKS_KEY, links);
  saveJson(PRICES_KEY, {});
  interest.forEach((entry, id) => emit(id));
};

// Used by tests.
export const resetPriceServiceForTests = () => {
  resetFutbinClientForTests();
  links = {};
  records.clear();
  queue.clear();
  inflight.clear();
  interest.clear();
  waiters.clear();
  busy = false;
  lastRequestAt = 0;
  clearTimeout(pumpTimer);
  pumpTimer = null;
  clearInterval(tickTimer);
  tickTimer = null;
  Object.assign(status, { state: "idle", requests: 0, lastError: "", lastSuccessAt: 0, blockedUntil: 0, backoffMs: 0 });
};
