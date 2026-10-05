import { isRunning } from "../core/engine";
import { errorMessage, log } from "../core/logger";
import { pageGlobal } from "../core/page";
import { floorPrice, formatCoins, parseCoinsInput } from "../core/prices";
import {
  applySession,
  buyMissing,
  entryPrice,
  formationLabel,
  loadSolution,
  maxPriceFor,
  priceStatus,
  releaseSession,
  sessionSummary,
  sourceLabel,
} from "../core/sbc";
import { beginTask, cancelTask, currentTask, endTask } from "../core/tasks";
import { onLanguageChange, t } from "../i18n";
import { onPriceUpdate } from "../prices/priceService";
import { escapeHtml, qs } from "./dom";
import { injectStyles } from "./panel";

// SBC squad screen: "FUTBIN solution" button → paste the link, preview the players
// (club / storage / to buy), place them in the squad, buy the missing ones at the FUTBIN price.
// Only two EA methods that do not call superclass() are intercepted (initWithSBCSet and
// getNavigationTitle): the other methods of this controller do not survive being wrapped.

let activeCtrl = null;
let hooked = false;
let fab = null;
let modal = null;
let session = null;
let running = null;
let loading = false;
let unwatchPrices = null;
let repaintTimer = null;
let languageWatched = false;
// Last status message, kept as a function so it can be rendered again in a new language.
let lastStatus = null;
const lastUrls = new Map();

const STATE_LABEL_KEYS = {
  owned: "ui.sbc.state.owned",
  missing: "ui.sbc.state.missing",
  searching: "ui.sbc.state.searching",
  bought: "ui.sbc.state.bought",
  failed: "ui.sbc.state.failed",
};

const stateLabel = (state) => (STATE_LABEL_KEYS[state] ? t(STATE_LABEL_KEYS[state]) : state);

const ctrlAlive = (ctrl) => {
  try {
    if (!ctrl || !ctrl._challenge) {
      return false;
    }
    const root = ctrl.getView().getRootElement();
    return !!(root && root.isConnected);
  } catch (e) {
    return false;
  }
};

const challengeKey = (ctrl) => {
  try {
    return String(ctrl._challenge.id);
  } catch (e) {
    return "";
  }
};

// ------------------------------------------------------------------ interception

export const hookSbc = () => {
  if (hooked) {
    return true;
  }
  const Ctrl = pageGlobal("UTSBCSquadOverviewViewController");
  if (typeof Ctrl !== "function" || !Ctrl.prototype) {
    return false;
  }
  const proto = Ctrl.prototype;
  if (!proto.__mbSbc) {
    ["initWithSBCSet", "getNavigationTitle"].forEach((name) => {
      const original = proto[name];
      if (typeof original !== "function") {
        return;
      }
      proto[name] = function () {
        activeCtrl = this;
        return original.apply(this, arguments);
      };
    });
    proto.__mbSbc = true;
  }
  hooked = true;
  return true;
};

// --------------------------------------------------------------- floating button

const paintFab = () => {
  if (!fab) {
    return;
  }
  fab.textContent = t("ui.sbc.fab.label");
  fab.title = t("ui.sbc.fab.title");
};

const ensureFab = () => {
  if (fab && fab.isConnected) {
    return fab;
  }
  fab = document.createElement("button");
  fab.type = "button";
  fab.id = "mb-sbc-fab";
  paintFab();
  ["pointerdown", "mousedown", "touchstart", "touchend", "mouseup", "pointerup"].forEach((type) =>
    fab.addEventListener(type, (event) => event.stopPropagation())
  );
  fab.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openModal();
  });
  document.body.appendChild(fab);
  return fab;
};

// Static texts are rendered again when the language changes.
const watchLanguage = () => {
  if (languageWatched) {
    return;
  }
  languageWatched = true;
  onLanguageChange(() => {
    paintFab();
    if (!modal) {
      return;
    }
    const input = qs(modal, "[data-sbc-url]");
    const url = input ? input.value : "";
    const title = modal.__ctrl && modal.__ctrl._challenge && modal.__ctrl._challenge.name;
    modal.innerHTML = modalHtml(title);
    qs(modal, "[data-sbc-url]").value = url;
    if (lastStatus) {
      paintStatus();
    }
    renderTable();
    paintSummary();
    if (loading) {
      qs(modal, "[data-sbc-load]").disabled = true;
    }
  });
};

export const tickSbc = () => {
  hookSbc();
  watchLanguage();
  const visible = ctrlAlive(activeCtrl);
  if (!visible && !modal) {
    if (fab) {
      fab.hidden = true;
    }
    return;
  }
  if (!document.body) {
    return;
  }
  injectStyles();
  const button = ensureFab();
  button.hidden = !visible || !!modal;
};

// -------------------------------------------------------------------- dialog

const modalHtml = (title) => `
  <div class="mb-sbc-backdrop" data-sbc-close></div>
  <div class="mb-sbc-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(t("ui.sbc.dialog.aria"))}">
    <header class="mb-sbc-head">
      <div><strong>${escapeHtml(t("ui.sbc.fab.label"))}</strong><small>${escapeHtml(title || t("ui.sbc.dialog.defaultTitle"))}</small></div>
      <button type="button" class="mb-sbc-x" data-sbc-close aria-label="${escapeHtml(t("ui.sbc.dialog.close"))}">×</button>
    </header>
    <div class="mb-sbc-url">
      <input type="url" data-sbc-url placeholder="https://www.futbin.com/27/squad/…" autocomplete="off" spellcheck="false" aria-label="${escapeHtml(t("ui.sbc.url.aria"))}" />
      <button type="button" class="mb-sbc-btn is-primary" data-sbc-load>${escapeHtml(t("ui.sbc.load"))}</button>
    </div>
    <p class="mb-sbc-status" data-sbc-status>${escapeHtml(t("ui.sbc.status.intro"))}</p>
    <div class="mb-sbc-body" data-sbc-body></div>
    <footer class="mb-sbc-foot">
      <span class="mb-sbc-summary" data-sbc-summary></span>
      <button type="button" class="mb-sbc-btn" data-sbc-apply disabled>${escapeHtml(t("ui.sbc.apply"))}</button>
      <button type="button" class="mb-sbc-btn is-primary" data-sbc-buy disabled>${escapeHtml(t("ui.sbc.buy"))}</button>
      <button type="button" class="mb-sbc-btn is-danger" data-sbc-stop hidden>${escapeHtml(t("ui.sbc.stop"))}</button>
    </footer>
  </div>`;

const paintStatus = () => {
  if (!modal || !lastStatus) {
    return;
  }
  const el = qs(modal, "[data-sbc-status]");
  el.textContent = lastStatus.render();
  el.dataset.kind = lastStatus.kind;
};

// `message` is either final text (e.g. an error already translated by the core) or a function
// that builds the text, so the message follows a language change while the dialog is open.
const setStatus = (message, kind = "") => {
  if (!modal) {
    return;
  }
  lastStatus = { render: typeof message === "function" ? message : () => message, kind };
  paintStatus();
};

const rowHtml = (entry, index) => {
  const editable = entry.state === "missing" || entry.state === "failed";
  const price = entryPrice(entry);
  const auto = maxPriceFor(Object.assign({}, entry, { manual: false }));
  const player = entry.player;
  const link = player.url
    ? ` <a href="${escapeHtml(player.url)}" target="_blank" rel="noopener" title="${escapeHtml(t("ui.sbc.row.futbinPage"))}">↗</a>`
    : "";
  return `<tr data-sbc-row="${index}" class="is-${entry.state}">
    <td class="mb-sbc-pos">${escapeHtml(entry.slotLabel || player.position || "—")}</td>
    <td><b>${escapeHtml(player.name || `#${player.eaId}`)}</b> <span class="mb-sbc-rating">${player.rating || ""}</span>${link}
      <small data-sbc-note>${escapeHtml(entry.note || (entry.source && entry.state === "owned" ? sourceLabel(entry.source) : ""))}</small></td>
    <td data-sbc-state>${escapeHtml(stateLabel(entry.state))}</td>
    <td class="is-num"><span data-sbc-price>${price ? formatCoins(price) : "—"}</span><small data-sbc-age>${escapeHtml(priceStatus(entry))}</small></td>
    <td class="is-num">${
      editable
        ? `<input class="mb-sbc-max" data-sbc-max="${index}" inputmode="text" autocomplete="off" value="${entry.manual ? entry.maxPrice : ""}" placeholder="${auto ? auto : escapeHtml(t("ui.sbc.row.enterPrice"))}" aria-label="${escapeHtml(t("ui.sbc.row.maxPriceAria", { name: player.name || "" }))}" />`
        : entry.boughtPrice
        ? formatCoins(entry.boughtPrice)
        : ""
    }</td>
  </tr>`;
};

const renderTable = () => {
  if (!modal) {
    return;
  }
  const body = qs(modal, "[data-sbc-body]");
  if (!session) {
    body.innerHTML = "";
    return;
  }
  const formation = session.formation
    ? escapeHtml(
        t("ui.sbc.meta.formation", {
          from: session.futbinFormation || formationLabel(session.formation),
          to: formationLabel(session.formation),
        })
      )
    : session.futbinFormation
    ? escapeHtml(t("ui.sbc.meta.formationNotFound", { formation: session.futbinFormation }))
    : escapeHtml(t("ui.sbc.meta.formationKept"));
  const title = session.challengeName ? `${escapeHtml(t("ui.sbc.meta.title", { name: session.challengeName }))} · ` : "";
  const players = escapeHtml(t("ui.sbc.meta.players", { count: session.entries.length }));
  const via = escapeHtml(session.via === "iframe" ? t("ui.sbc.meta.viaIframe") : t("ui.sbc.meta.viaDirect"));
  body.innerHTML = `<p class="mb-sbc-meta">${title}${formation} · ${players} · ${via}</p>
    <table class="mb-sbc-table">
      <thead><tr><th>${t("ui.sbc.col.position")}</th><th>${t("ui.sbc.col.player")}</th><th>${t("ui.sbc.col.status")}</th><th class="is-num">FUTBIN</th><th class="is-num">${t("ui.sbc.col.max")}</th></tr></thead>
      <tbody>${session.entries.map(rowHtml).join("")}</tbody>
    </table>`;
  paintSummary();
};

// Updates one row without touching the field being edited.
const paintRow = (index) => {
  if (!modal || !session) {
    return;
  }
  const row = qs(modal, `[data-sbc-row="${index}"]`);
  const entry = session.entries[index];
  if (!row || !entry) {
    return;
  }
  const input = qs(row, "[data-sbc-max]");
  const editable = entry.state === "missing" || entry.state === "failed";
  if (!!input !== editable) {
    const fresh = document.createElement("tbody");
    fresh.innerHTML = rowHtml(entry, index);
    row.replaceWith(fresh.firstElementChild);
    paintSummary();
    return;
  }
  row.className = `is-${entry.state}`;
  qs(row, "[data-sbc-state]").textContent = stateLabel(entry.state);
  qs(row, "[data-sbc-note]").textContent = entry.note || (entry.source && entry.state === "owned" ? sourceLabel(entry.source) : "");
  const price = entryPrice(entry);
  qs(row, "[data-sbc-price]").textContent = price ? formatCoins(price) : "—";
  qs(row, "[data-sbc-age]").textContent = priceStatus(entry);
  if (input && document.activeElement !== input) {
    const auto = maxPriceFor(Object.assign({}, entry, { manual: false }));
    input.placeholder = auto ? String(auto) : t("ui.sbc.row.enterPrice");
  }
  paintSummary();
};

const paintSummary = () => {
  if (!modal) {
    return;
  }
  const summaryEl = qs(modal, "[data-sbc-summary]");
  const applyBtn = qs(modal, "[data-sbc-apply]");
  const buyBtn = qs(modal, "[data-sbc-buy]");
  const stopBtn = qs(modal, "[data-sbc-stop]");
  if (!session) {
    summaryEl.textContent = "";
    applyBtn.disabled = true;
    buyBtn.disabled = true;
    return;
  }
  const summary = sessionSummary(session);
  summaryEl.innerHTML =
    t("ui.sbc.summary.available", { placed: summary.placed, total: summary.total, missing: summary.missing }) +
    (summary.missing
      ? ` · ${t("ui.sbc.summary.budget", { budget: formatCoins(summary.budget) })}${
          summary.unknown ? ` ${t("ui.sbc.summary.unknown", { count: summary.unknown })}` : ""
        }`
      : "") +
    (summary.coins ? ` · ${t("ui.sbc.summary.coins", { coins: formatCoins(summary.coins) })}` : "");
  summaryEl.classList.toggle("is-short", !!(summary.coins && summary.budget > summary.coins));
  const busy = !!running;
  applyBtn.disabled = busy;
  buyBtn.disabled = busy || !summary.missing;
  stopBtn.hidden = !busy;
  qs(modal, "[data-sbc-load]").disabled = busy;
};

const schedulePaint = () => {
  if (repaintTimer) {
    return;
  }
  repaintTimer = setTimeout(() => {
    repaintTimer = null;
    if (session) {
      session.entries.forEach((_, index) => paintRow(index));
    }
  }, 250);
};

const closeModal = () => {
  if (running) {
    setStatus(() => t("ui.sbc.status.closeWhileBuying"), "warn");
    return;
  }
  if (modal) {
    modal.remove();
    modal = null;
  }
  releaseSession(session);
  session = null;
  lastStatus = null;
  if (unwatchPrices) {
    unwatchPrices();
    unwatchPrices = null;
  }
};

const openModal = () => {
  if (modal) {
    return;
  }
  const ctrl = activeCtrl;
  if (!ctrlAlive(ctrl)) {
    return;
  }
  injectStyles();
  modal = document.createElement("div");
  modal.id = "mb-sbc";
  modal.innerHTML = modalHtml(ctrl._challenge && ctrl._challenge.name);
  ["pointerdown", "mousedown", "touchstart", "touchend", "mouseup", "pointerup", "keydown", "keyup"].forEach((type) =>
    modal.addEventListener(type, (event) => event.stopPropagation())
  );
  modal.addEventListener("click", onClick);
  modal.addEventListener("change", onChange);
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeModal();
    } else if (event.key === "Enter" && event.target.matches("[data-sbc-url]")) {
      load();
    } else if (event.key === "Enter" && event.target.matches("[data-sbc-max]")) {
      event.target.blur();
    }
  });
  document.body.appendChild(modal);
  modal.__ctrl = ctrl;
  const url = lastUrls.get(challengeKey(ctrl));
  const input = qs(modal, "[data-sbc-url]");
  if (url) {
    input.value = url;
  }
  input.focus();
  unwatchPrices = onPriceUpdate(() => schedulePaint());
  if (fab) {
    fab.hidden = true;
  }
};

// ---------------------------------------------------------------------- actions

const load = async () => {
  if (!modal || running || loading) {
    return;
  }
  const url = qs(modal, "[data-sbc-url]").value.trim();
  if (!url) {
    setStatus(() => t("ui.sbc.status.pasteFirst"), "warn");
    return;
  }
  const ctrl = modal.__ctrl;
  lastUrls.set(challengeKey(ctrl), url);
  releaseSession(session);
  session = null;
  renderTable();
  setStatus(() => t("ui.sbc.status.reading"));
  qs(modal, "[data-sbc-load]").disabled = true;
  loading = true;
  try {
    const result = await loadSolution(ctrl, url);
    if (!modal) {
      if (result.session) {
        releaseSession(result.session);
      }
      return;
    }
    if (!result.ok) {
      setStatus(result.message, "error");
      return;
    }
    session = result.session;
    renderTable();
    if (session.ownedErrors.length) {
      const reason = session.ownedErrors[0].label;
      setStatus(() => t("ui.sbc.status.clubSearchIncomplete", { reason }), "warn");
      return;
    }
    // Solution read from FUTBIN's JSON: reliable, the squad is filled right away. HTML parsing
    // (fallback): only if the whole squad was recognized.
    const open = (session.slots || []).filter((slot) => !slot.brick).length;
    const complete = session.source === "json" || session.entries.length >= Math.min(11, open || 11);
    if (!complete) {
      const count = session.entries.length;
      setStatus(() => t("ui.sbc.status.partialRead", { count }), "warn");
      return;
    }
    // Complete solution: the challenge squad is filled right away with the club players.
    setStatus(() => t("ui.sbc.status.placingClub"));
    const placed = await applySession(session);
    if (!modal) {
      return;
    }
    renderTable();
    const summary = sessionSummary(session);
    if (!placed.ok) {
      setStatus(placed.message, "error");
    } else {
      setStatus(
        () =>
          summary.missing
            ? t("ui.sbc.status.filledPartial", { placed: summary.placed, total: summary.total, missing: summary.missing })
            : t("ui.sbc.status.filledAll"),
        "ok"
      );
    }
  } catch (e) {
    const message = errorMessage(e);
    setStatus(() => t("ui.sbc.status.error", { message }), "error");
  } finally {
    loading = false;
    if (modal) {
      qs(modal, "[data-sbc-load]").disabled = false;
      paintSummary();
    }
  }
};

const apply = async () => {
  if (!session || running) {
    return;
  }
  setStatus(() => t("ui.sbc.status.saving"));
  const result = await applySession(session);
  if (!modal) {
    return;
  }
  renderTable();
  setStatus(result.ok ? () => t("ui.sbc.status.saved") : result.message, result.ok ? "ok" : "error");
};

const buy = async () => {
  if (!session || running) {
    return;
  }
  if (isRunning()) {
    setStatus(() => t("ui.sbc.status.botRunning"), "warn");
    return;
  }
  const summary = sessionSummary(session);
  if (summary.unknown) {
    setStatus(() => t("ui.sbc.status.missingPrices"), "warn");
    return;
  }
  if (summary.coins && summary.budget > summary.coins) {
    setStatus(
      () => t("ui.sbc.status.overBudget", { budget: formatCoins(summary.budget), coins: formatCoins(summary.coins) }),
      "warn"
    );
    return;
  }
  const task = beginTask(t("ui.sbc.taskLabel"));
  if (!task) {
    const other = currentTask();
    const label = other ? other.label : "?";
    setStatus(() => t("ui.sbc.status.otherTask", { label }), "warn");
    return;
  }
  running = task;
  paintSummary();
  setStatus(() => t("ui.sbc.status.buying"));
  log.info(t("ui.sbc.log.buying", { count: summary.missing, budget: formatCoins(summary.budget) }));
  let report;
  try {
    // Owned players are placed first: purchases complete the squad.
    await applySession(session);
    renderTable();
    report = await buyMissing(session, {
      token: task.token,
      onUpdate: (entry) => paintRow(session.entries.indexOf(entry)),
    });
  } catch (e) {
    report = { bought: 0, spent: 0, failed: 0, stopped: errorMessage(e) };
  } finally {
    endTask(task);
    running = null;
  }
  if (!modal) {
    return;
  }
  renderTable();
  const reportText = () =>
    t("ui.sbc.report.bought", { count: report.bought, spent: formatCoins(report.spent) }) +
    (report.failed ? ` · ${t("ui.sbc.report.failed", { count: report.failed })}` : "") +
    (report.stopped ? ` · ${t("ui.sbc.report.stopped", { reason: report.stopped })}` : "") +
    t("ui.sbc.report.end");
  setStatus(reportText, report.stopped || report.failed ? "warn" : "ok");
  log.info(t("ui.sbc.log.done", { report: reportText() }));
};

function onClick(event) {
  const target = event.target;
  if (target.closest("[data-sbc-close]")) {
    closeModal();
  } else if (target.closest("[data-sbc-load]")) {
    load();
  } else if (target.closest("[data-sbc-apply]")) {
    apply();
  } else if (target.closest("[data-sbc-buy]")) {
    buy();
  } else if (target.closest("[data-sbc-stop]")) {
    cancelTask();
    setStatus(() => t("ui.sbc.status.stopRequested"), "warn");
  }
}

function onChange(event) {
  const input = event.target.closest("[data-sbc-max]");
  if (!input || !session) {
    return;
  }
  const entry = session.entries[Number(input.dataset.sbcMax)];
  if (!entry) {
    return;
  }
  const value = floorPrice(parseCoinsInput(input.value));
  entry.manual = value > 0;
  entry.maxPrice = value;
  input.value = value ? String(value) : "";
  paintSummary();
}

export const closeSbcModal = () => closeModal();
