import { t } from "../i18n";

// Runtime state shared between the engine and the UI (not persisted).

export const STATUS = {
  IDLE: "idle",
  STARTING: "starting",
  RUNNING: "running",
  PAUSED: "paused",
  AUTO_PAUSE: "auto-pause",
  COOLDOWN: "cooldown",
  STOPPING: "stopping",
  STOPPED: "stopped",
};

/** Translated label of a bot status, resolved at render time so it follows the active language. */
export const statusLabel = (status) => {
  const key = `core.status.${status}`;
  const text = t(key);
  return text === key ? status : text;
};

const emptyStats = () => ({
  searches: 0,
  requests: 0,
  results: 0,
  deals: 0,
  attempts: 0,
  won: 0,
  missed: 0,
  bids: 0,
  bidsWon: 0,
  spent: 0,
  listed: 0,
  estProfit: 0,
  soldCount: 0,
  soldValue: 0,
  errors: 0,
  lastLatency: 0,
  avgLatency: 0,
});

const state = {
  status: STATUS.IDLE,
  detail: "",
  startedAt: 0,
  stoppedAt: 0,
  nextSearchAt: 0,
  waitStartedAt: 0,
  pauseUntil: 0,
  filterName: "",
  coins: 0,
  transfer: null,
  stats: emptyStats(),
};

const listeners = new Set();
let scheduled = false;

const flush = () => {
  scheduled = false;
  listeners.forEach((fn) => {
    try {
      fn(state);
    } catch (e) {}
  });
};

const notify = () => {
  if (scheduled) {
    return;
  }
  scheduled = true;
  Promise.resolve().then(flush);
};

export const getState = () => state;

export const updateState = (patch) => {
  Object.assign(state, patch);
  notify();
};

export const bumpStat = (key, amount = 1) => {
  state.stats[key] = (state.stats[key] || 0) + amount;
  notify();
};

export const setStat = (key, value) => {
  state.stats[key] = value;
  notify();
};

export const resetStats = () => {
  state.stats = emptyStats();
  searchTimes.length = 0;
  notify();
};

export const onStateChange = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

// Searches over the last minute (sliding window).
const searchTimes = [];

export const recordSearch = (latencyMs) => {
  const now = Date.now();
  searchTimes.push(now);
  while (searchTimes.length && now - searchTimes[0] > 60000) {
    searchTimes.shift();
  }
  const stats = state.stats;
  stats.searches += 1;
  stats.lastLatency = Math.round(latencyMs || 0);
  stats.avgLatency = stats.avgLatency
    ? Math.round(stats.avgLatency * 0.85 + stats.lastLatency * 0.15)
    : stats.lastLatency;
  notify();
};

export const searchesLastMinute = () => {
  const now = Date.now();
  return searchTimes.filter((t) => now - t <= 60000).length;
};

export const lastSearchAt = () =>
  searchTimes.length ? searchTimes[searchTimes.length - 1] : 0;

// ---------------------------------------------------------------- Journal

const MAX_LOGS = 400;
const logs = [];
const logListeners = new Set();
let logSeq = 0;

export const LOG_TYPES = ["info", "success", "warning", "error", "buy", "search"];

export const addLog = (type, text, meta) => {
  const entry = {
    id: (logSeq += 1),
    time: Date.now(),
    type: LOG_TYPES.includes(type) ? type : "info",
    text: String(text == null ? "" : text),
    meta: meta || null,
  };
  logs.push(entry);
  if (logs.length > MAX_LOGS) {
    logs.splice(0, logs.length - MAX_LOGS);
  }
  logListeners.forEach((fn) => {
    try {
      fn(entry, logs);
    } catch (e) {}
  });
  return entry;
};

export const getLogs = () => logs;

export const clearLogs = () => {
  logs.length = 0;
  logListeners.forEach((fn) => {
    try {
      fn(null, logs);
    } catch (e) {}
  });
};

export const onLog = (fn) => {
  logListeners.add(fn);
  return () => logListeners.delete(fn);
};

// Transaction history (CSV export).
const transactions = [];

export const recordTransaction = (entry) => {
  transactions.push(Object.assign({ time: Date.now() }, entry));
  if (transactions.length > 2000) {
    transactions.shift();
  }
};

export const getTransactions = () => transactions;
