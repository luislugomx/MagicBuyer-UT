import { VERSION } from "../config";
import { isFinalizing, isPaused, isRunning, isStopping, pauseBot, resumeBot, startBot, stopBot } from "../core/engine";
import { describeFilter, getActiveFilter, onFiltersChange, runnableFilters } from "../core/filters";
import { formatCoins } from "../core/prices";
import { formatDuration } from "../core/ranges";
import { getSettings, onSettingsChange, setSetting } from "../core/settings";
import {
  STATUS,
  clearLogs,
  getLogs,
  getState,
  getTransactions,
  onLog,
  onStateChange,
  searchesLastMinute,
  statusLabel,
} from "../core/state";
import { LANGUAGE_CHOICES, getLanguageChoice, numberLocale, onLanguageChange, setLanguageChoice, t } from "../i18n";
import { escapeHtml, formatTime, qs, qsa, setText, toggleClass } from "./dom";
import { bindFields, refreshFields } from "./fields";
import {
  alertsPageHtml,
  bindSettingsPages,
  buyPageHtml,
  refreshTransferStats,
  sellPageHtml,
  timingPageHtml,
  transferPageHtml,
} from "./pages/settingsPages";
import { bindFutbinPage, futbinPageHtml, refreshFutbinStatus } from "./pages/futbinPage";
import { bindTargetPage, sellExtra, targetPageHtml } from "./pages/target";
import { STYLES } from "./styles";

const TABS = [
  { id: "target", labelKey: "ui.tab.target", html: targetPageHtml },
  { id: "buy", labelKey: "ui.tab.buy", html: buyPageHtml },
  { id: "sell", labelKey: "ui.tab.sell", html: sellPageHtml },
  { id: "timing", labelKey: "ui.tab.timing", html: timingPageHtml },
  { id: "transfer", labelKey: "ui.tab.transfer", html: transferPageHtml },
  { id: "futbin", labelKey: "ui.tab.futbin", html: futbinPageHtml },
  { id: "alerts", labelKey: "ui.tab.alerts", html: alertsPageHtml },
];

const LOG_ICONS = { search: "🔎", buy: "✅", success: "✔️", warning: "⚠️", error: "⛔", info: "•" };
const LOG_FILTERS = [
  ["all", "ui.log.filter.all"],
  ["quiet", "ui.log.filter.quiet"],
  ["buys", "ui.log.filter.buys"],
  ["alerts", "ui.log.filter.alerts"],
];

// Language names are always shown in their own language.
const LANGUAGE_NAMES = { en: "English", es: "Español" };

let root = null;
let ticker = null;
// Global panel subscriptions: replaced (never stacked) when the panel is rebuilt.
let unsubscribers = [];
let languageWatched = false;

export const injectStyles = () => {
  if (document.getElementById("mb-styles")) {
    return;
  }
  const style = document.createElement("style");
  style.id = "mb-styles";
  style.textContent = STYLES;
  (document.head || document.documentElement).appendChild(style);
};

const languageSelectHtml = () => {
  const current = getLanguageChoice();
  const label = escapeHtml(t("ui.language.label"));
  const options = LANGUAGE_CHOICES.map((choice) => {
    const name = choice === "auto" ? t("ui.language.auto") : LANGUAGE_NAMES[choice] || choice;
    const lang = choice === "auto" ? "" : ` lang="${choice}"`;
    return `<option value="${choice}"${lang}${choice === current ? " selected" : ""}>${escapeHtml(name)}</option>`;
  }).join("");
  return `<select class="mb-lang" data-language aria-label="${label}" title="${label}">${options}</select>`;
};

const shellHtml = () => `
  <aside class="mb-panel" role="complementary" aria-label="MagicBuyer">
    <header class="mb-head">
      <div class="mb-logo">MB</div>
      <div class="mb-title"><strong>MagicBuyer</strong><small>${escapeHtml(t("ui.header.subtitle", { version: VERSION }))}</small></div>
      ${languageSelectHtml()}
      <button type="button" class="mb-icon-btn" data-action="close" aria-label="${escapeHtml(t("ui.header.close.aria"))}" title="${escapeHtml(t("ui.header.close.title"))}">×</button>
    </header>
    <div class="mb-bar">
      <div class="mb-state" data-state data-status="idle">
        <span class="mb-dot"></span>
        <span class="mb-state-text"><b data-state-label>${escapeHtml(statusLabel(STATUS.IDLE))}</b><small data-state-detail></small></span>
      </div>
      <button type="button" class="mb-btn mb-btn-start" data-action="start">${escapeHtml(t("ui.action.start"))}</button>
      <button type="button" class="mb-btn mb-btn-pause" data-action="pause" hidden>${escapeHtml(t("ui.action.pause"))}</button>
      <button type="button" class="mb-btn mb-btn-stop" data-action="stop" hidden>${escapeHtml(t("ui.action.stop"))}</button>
    </div>
    <div class="mb-kpis">
      <div class="mb-kpi"><span>${t("ui.kpi.searches")}</span><strong data-kpi="searches">0</strong></div>
      <div class="mb-kpi"><span>${t("ui.kpi.rate")}</span><strong data-kpi="rate">0</strong></div>
      <div class="mb-kpi is-good"><span>${t("ui.kpi.won")}</span><strong data-kpi="won">0</strong></div>
      <div class="mb-kpi"><span>${t("ui.kpi.missed")}</span><strong data-kpi="missed">0</strong></div>
      <div class="mb-kpi"><span>${t("ui.kpi.spent")}</span><strong data-kpi="spent">0</strong></div>
      <div class="mb-kpi"><span>${t("ui.kpi.profit")}</span><strong data-kpi="profit">0</strong></div>
      <div class="mb-kpi"><span>${t("ui.kpi.coins")}</span><strong data-kpi="coins">—</strong></div>
      <div class="mb-kpi"><span>${t("ui.kpi.time")}</span><strong data-kpi="time">00:00:00</strong></div>
    </div>
    <div class="mb-next" aria-hidden="true"><div class="mb-next-fill" data-next-fill></div><span class="mb-next-label" data-next-label>${t("ui.next.ready")}</span></div>
    <nav class="mb-tabs" role="tablist">
      ${TABS.map((tab) => `<button type="button" class="mb-tab" role="tab" data-tab="${tab.id}">${t(tab.labelKey)}</button>`).join("")}
    </nav>
    <div class="mb-body" data-body>
      ${TABS.map((tab) => `<div class="mb-page" role="tabpanel" data-page="${tab.id}">${tab.html()}</div>`).join("")}
    </div>
    <section class="mb-log" data-log>
      <div class="mb-log-resize" data-log-resize title="${escapeHtml(t("ui.log.resize"))}"></div>
      <div class="mb-log-head">
        <strong>${t("ui.log.title")}</strong>
        ${LOG_FILTERS.map(([id, key]) => `<button type="button" class="mb-log-filter" data-log-filter="${id}">${t(key)}</button>`).join("")}
        <button type="button" class="mb-icon-btn" data-action="export" title="${escapeHtml(t("ui.log.export.title"))}" aria-label="${escapeHtml(t("ui.log.export.aria"))}">⇩</button>
        <button type="button" class="mb-icon-btn" data-action="clear-log" title="${escapeHtml(t("ui.log.clear"))}" aria-label="${escapeHtml(t("ui.log.clear"))}">⌫</button>
        <button type="button" class="mb-icon-btn" data-action="collapse-log" title="${escapeHtml(t("ui.log.collapse.title"))}" aria-label="${escapeHtml(t("ui.log.collapse.aria"))}">▾</button>
      </div>
      <ol class="mb-log-list" data-log-list aria-live="polite"></ol>
    </section>
  </aside>
`;

// ------------------------------------------------------------------ log

const logMatches = (entry, filter) => {
  if (filter === "quiet") {
    return entry.type !== "search";
  }
  if (filter === "buys") {
    return entry.type === "buy" || entry.type === "success";
  }
  if (filter === "alerts") {
    return entry.type === "warning" || entry.type === "error";
  }
  return true;
};

const logEntryHtml = (entry) =>
  `<li class="mb-log-entry t-${entry.type}" data-log-id="${entry.id}"><time>${formatTime(entry.time)}</time><i>${LOG_ICONS[entry.type] || "•"}</i><p>${escapeHtml(entry.text)}</p></li>`;

const renderLogs = () => {
  const list = qs(root, "[data-log-list]");
  const filter = getSettings().ui.logFilter || "all";
  list.innerHTML = getLogs()
    .filter((entry) => logMatches(entry, filter))
    .slice(-250)
    .map(logEntryHtml)
    .join("");
  list.scrollTop = list.scrollHeight;
  qsa(root, "[data-log-filter]").forEach((btn) => toggleClass(btn, "is-active", btn.dataset.logFilter === filter));
};

// Log rendering is batched to the next frame: writing a log costs the engine nothing
// (no forced layout between a search and the purchase that follows).
let pendingLogs = [];
let logFrame = 0;

const flushLogs = () => {
  logFrame = 0;
  if (!root) {
    pendingLogs = [];
    return;
  }
  const entries = pendingLogs;
  pendingLogs = [];
  if (entries.includes(null)) {
    renderLogs();
    return;
  }
  const filter = getSettings().ui.logFilter || "all";
  const html = entries.filter((entry) => logMatches(entry, filter)).map(logEntryHtml).join("");
  if (!html) {
    return;
  }
  const list = qs(root, "[data-log-list]");
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  list.insertAdjacentHTML("beforeend", html);
  while (list.children.length > 250) {
    list.removeChild(list.firstChild);
  }
  if (nearBottom) {
    list.scrollTop = list.scrollHeight;
  }
};

const appendLog = (entry) => {
  pendingLogs.push(entry);
  if (!logFrame) {
    logFrame =
      typeof requestAnimationFrame === "function" && !document.hidden
        ? requestAnimationFrame(flushLogs)
        : setTimeout(flushLogs, 50);
  }
};

const exportCsv = () => {
  const rows = [
    [
      t("ui.csv.time"),
      t("ui.csv.type"),
      t("ui.csv.card"),
      t("ui.csv.rating"),
      t("ui.csv.price"),
      t("ui.csv.profit"),
      t("ui.csv.filter"),
    ],
  ];
  const locale = numberLocale();
  getTransactions().forEach((tx) =>
    rows.push([
      new Date(tx.time).toLocaleString(locale),
      tx.type,
      tx.name,
      tx.rating || "",
      tx.price || "",
      tx.profit || "",
      tx.filter || "",
    ])
  );
  const stats = getState().stats;
  rows.push([]);
  rows.push([
    t("ui.csv.searches"),
    stats.searches,
    t("ui.csv.buys"),
    stats.won,
    t("ui.csv.spent"),
    stats.spent,
    t("ui.csv.estProfit"),
    stats.estProfit,
  ]);
  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell == null ? "" : cell).replace(/"/g, '""')}"`).join(";"))
    .join("\n");
  const link = document.createElement("a");
  link.href = `data:text/csv;charset=utf-8,%EF%BB%BF${encodeURIComponent(csv)}`;
  link.download = `magicbuyer-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
};

// --------------------------------------------------------------- display

const stateDetail = (state) => {
  if (state.status === STATUS.IDLE || state.status === STATUS.STOPPED) {
    if (state.detail) {
      return state.detail;
    }
    const filters = runnableFilters();
    return filters.length > 1 ? t("ui.state.filtersReady", { count: filters.length }) : describeFilter(getActiveFilter());
  }
  if (state.status === STATUS.PAUSED) {
    return t("ui.state.pausedHint");
  }
  return state.filterName || describeFilter(getActiveFilter());
};

const nextLabel = (state, now) => {
  const remaining = Math.max(0, (state.nextSearchAt || 0) - now);
  if (state.status === STATUS.AUTO_PAUSE) {
    return t("ui.next.autoPause", { duration: formatDuration(remaining) });
  }
  if (state.status === STATUS.COOLDOWN) {
    return t("ui.next.cooldown", { duration: formatDuration(remaining) });
  }
  if (state.status === STATUS.PAUSED) {
    return t("ui.next.paused");
  }
  if (state.status === STATUS.STOPPING) {
    return isFinalizing() ? t("ui.next.finalizing") : t("ui.next.stopping");
  }
  if (state.status === STATUS.RUNNING) {
    return state.nextSearchAt
      ? t("ui.next.nextSearch", {
          seconds: (remaining / 1000).toLocaleString(numberLocale(), {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          }),
        })
      : t("ui.next.searching");
  }
  if (state.status === STATUS.STARTING) {
    return t("ui.next.syncing");
  }
  return t("ui.next.ready");
};

const paintState = () => {
  if (!root) {
    return;
  }
  const state = getState();
  const now = Date.now();
  const stats = state.stats;
  const stateEl = qs(root, "[data-state]");
  if (stateEl.dataset.status !== state.status) {
    stateEl.dataset.status = state.status;
  }
  setText(qs(root, "[data-state-label]"), statusLabel(state.status));
  setText(qs(root, "[data-state-detail]"), stateDetail(state));
  const running = isRunning();
  const stopping = isStopping();
  const startBtn = qs(root, '[data-action="start"]');
  const pauseBtn = qs(root, '[data-action="pause"]');
  const stopBtn = qs(root, '[data-action="stop"]');
  startBtn.hidden = stopping || (running && !isPaused());
  setText(startBtn, isPaused() ? t("ui.action.resume") : t("ui.action.start"));
  pauseBtn.hidden = !running || isPaused() || stopping;
  stopBtn.hidden = !running;
  stopBtn.disabled = stopping && !isFinalizing();
  setText(qs(root, '[data-kpi="searches"]'), stats.searches);
  setText(qs(root, '[data-kpi="rate"]'), searchesLastMinute());
  setText(qs(root, '[data-kpi="won"]'), stats.won);
  setText(qs(root, '[data-kpi="missed"]'), stats.missed);
  setText(qs(root, '[data-kpi="spent"]'), formatCoins(stats.spent));
  setText(qs(root, '[data-kpi="profit"]'), `${stats.estProfit > 0 ? "+" : ""}${formatCoins(stats.estProfit)}`);
  setText(qs(root, '[data-kpi="coins"]'), state.coins ? formatCoins(state.coins) : "—");
  const elapsed = state.startedAt ? (running ? now : state.stoppedAt || now) - state.startedAt : 0;
  setText(qs(root, '[data-kpi="time"]'), formatDuration(elapsed));
  const fill = qs(root, "[data-next-fill]");
  let ratio = 0;
  if (state.nextSearchAt && state.waitStartedAt && state.nextSearchAt > state.waitStartedAt) {
    ratio = Math.min(1, Math.max(0, (now - state.waitStartedAt) / (state.nextSearchAt - state.waitStartedAt)));
  }
  if (state.status === STATUS.AUTO_PAUSE || state.status === STATUS.COOLDOWN) {
    ratio = 1 - Math.min(1, Math.max(0, (state.nextSearchAt - now) / Math.max(1, state.nextSearchAt - (state.waitStartedAt || now))));
  }
  const width = `${Math.round(ratio * 100)}%`;
  if (fill.style.width !== width) {
    fill.style.width = width;
  }
  setText(qs(root, "[data-next-label]"), nextLabel(state, now));
};

const showTab = (id) => {
  const tab = TABS.some((entry) => entry.id === id) ? id : "target";
  qsa(root, "[data-tab]").forEach((btn) => {
    const active = btn.dataset.tab === tab;
    toggleClass(btn, "is-active", active);
    btn.setAttribute("aria-selected", String(active));
  });
  qsa(root, "[data-page]").forEach((page) => toggleClass(page, "is-active", page.dataset.page === tab));
  if (getSettings().ui.activeTab !== tab) {
    setSetting("ui.activeTab", tab);
  }
  if (tab === "transfer") {
    refreshTransferStats(qs(root, "[data-body]"));
  }
  if (tab === "futbin") {
    refreshFutbinStatus(qs(root, "[data-body]"));
  }
};

const startTicker = () => {
  if (ticker) {
    return;
  }
  let beats = 0;
  ticker = setInterval(() => {
    if (root && root.classList.contains("is-open")) {
      paintState();
      beats += 1;
      if (beats % 8 === 0 && getSettings().ui.activeTab === "futbin") {
        refreshFutbinStatus(qs(root, "[data-body]"));
      }
    }
  }, 250);
};

// --------------------------------------------------------------- mounting

const bindShell = () => {
  const body = qs(root, "[data-body]");
  const refreshAll = () => refreshFields(body);
  bindFields(body, {
    "f:maxBuy": (value) => (value ? formatCoins(value) : ""),
    "f:sellPrice": () => sellExtra(),
    "f:sellPercent": () => sellExtra(),
    "s:sell.defaultPrice": () => sellExtra(),
    "f:maxBid": (value) => (value ? formatCoins(value) : ""),
    "s:buy.coinsReserve": (value) => (value ? formatCoins(value) : ""),
  });
  bindTargetPage(qs(root, '[data-page="target"]'), refreshAll);
  bindSettingsPages(body, refreshAll);
  bindFutbinPage(qs(root, '[data-page="futbin"]'));
  unsubscribers.forEach((off) => off());
  unsubscribers = [
    onSettingsChange(() => refreshAll()),
    onFiltersChange(() => paintState()),
  ];

  root.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab]");
    if (tab) {
      showTab(tab.dataset.tab);
      return;
    }
    const logFilter = event.target.closest("[data-log-filter]");
    if (logFilter) {
      setSetting("ui.logFilter", logFilter.dataset.logFilter);
      renderLogs();
      return;
    }
    const action = event.target.closest("[data-action]");
    if (!action) {
      return;
    }
    switch (action.dataset.action) {
      case "close":
        closePanel();
        break;
      case "start":
        if (isPaused()) {
          resumeBot();
        } else {
          startBot();
        }
        break;
      case "pause":
        pauseBot();
        break;
      case "stop":
        stopBot(t("ui.stop.manual"), { manual: true });
        break;
      case "clear-log":
        clearLogs();
        break;
      case "export":
        exportCsv();
        break;
      case "collapse-log": {
        const logEl = qs(root, "[data-log]");
        logEl.classList.toggle("is-collapsed");
        setText(action, logEl.classList.contains("is-collapsed") ? "▴" : "▾");
        break;
      }
      default:
        break;
    }
    paintState();
  });

  qs(root, "[data-language]").addEventListener("change", (event) => {
    setLanguageChoice(event.target.value);
  });

  const logEl = qs(root, "[data-log]");
  const setLogHeight = (vh) => {
    const value = Math.max(12, Math.min(70, vh));
    root.style.setProperty("--mb-log-h", `${value}vh`);
    return value;
  };
  setLogHeight(Number(getSettings().ui.logHeight) || 34);
  qs(root, "[data-log-resize]").addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const onMove = (move) => {
      const vh = ((window.innerHeight - move.clientY) / window.innerHeight) * 100;
      logEl.dataset.height = String(setLogHeight(vh));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (logEl.dataset.height) {
        setSetting("ui.logHeight", Math.round(Number(logEl.dataset.height)));
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  unsubscribers.push(
    onLog((entry) => appendLog(entry)),
    onStateChange(() => {
      paintState();
      if (qs(root, '[data-page="transfer"]').classList.contains("is-active")) {
        refreshTransferStats(body);
      }
    })
  );
};

export const ensurePanel = () => {
  if (root && document.body && document.body.contains(root)) {
    return root;
  }
  if (!document.body) {
    return null;
  }
  injectStyles();
  watchLanguage();
  root = document.getElementById("mb-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "mb-root";
    root.innerHTML = shellHtml();
    document.body.appendChild(root);
    bindShell();
    showTab(getSettings().ui.activeTab);
    renderLogs();
    paintState();
    startTicker();
  }
  return root;
};

// Rebuilds the panel in the new language. The bot keeps running: only the DOM and the
// panel subscriptions are recreated.
const rebuildPanel = () => {
  const wasOpen = isPanelOpen();
  const focused = document.activeElement;
  const hadLanguageFocus = !!(root && focused && root.contains(focused) && focused.matches("[data-language]"));
  unsubscribers.forEach((off) => off());
  unsubscribers = [];
  pendingLogs = [];
  const old = root || document.getElementById("mb-root");
  if (old) {
    old.remove();
  }
  root = null;
  const el = ensurePanel();
  if (!el) {
    return;
  }
  if (wasOpen) {
    el.classList.add("is-open");
    document.body.classList.add("mb-open");
  }
  showTab(getSettings().ui.activeTab);
  if (hadLanguageFocus) {
    const select = qs(el, "[data-language]");
    if (select) {
      select.focus();
    }
  }
};

const watchLanguage = () => {
  if (languageWatched) {
    return;
  }
  languageWatched = true;
  onLanguageChange(() => {
    if (root) {
      rebuildPanel();
    }
  });
};

export const isPanelOpen = () => !!(root && root.classList.contains("is-open"));

export const openPanel = () => {
  const el = ensurePanel();
  if (!el) {
    return;
  }
  el.classList.add("is-open");
  document.body.classList.add("mb-open");
  setSetting("ui.panelOpen", true);
  paintState();
};

export const closePanel = () => {
  if (root) {
    root.classList.remove("is-open");
  }
  if (document.body) {
    document.body.classList.remove("mb-open");
  }
  setSetting("ui.panelOpen", false);
};

export const togglePanel = () => (isPanelOpen() ? closePanel() : openPanel());

export const showTargetTab = () => {
  openPanel();
  showTab("target");
};
