import {
  filterHasTarget,
  getActiveFilter,
  setLastEaSearch,
  snapshotFromEaCriteria,
} from "../core/filters";
import { log } from "../core/logger";
import { pageGlobal } from "../core/page";
import { afterTax, formatCoins, toInt } from "../core/prices";
import { onLanguageChange, t } from "../i18n";
import { escapeHtml, qs, setText } from "./dom";
import { showTargetTab, togglePanel } from "./panel";
import { importSnapshot } from "./pages/target";

// Integrations into the EA web app interface (FC 27).

const TAB_CLASS = "mb-native-tab";
let delegatesBound = false;
let currentSearchController = null;
let languageWatched = false;

// ------------------------------------------------ button in the tab bar

const bindDelegates = () => {
  if (delegatesBound) {
    return;
  }
  delegatesBound = true;
  // Capture at document level: EA never sees clicks on our buttons.
  ["pointerdown", "mousedown", "touchstart", "touchend", "mouseup", "pointerup"].forEach((type) =>
    document.addEventListener(
      type,
      (event) => {
        if (event.target && event.target.closest && event.target.closest(`.${TAB_CLASS}`)) {
          event.stopImmediatePropagation();
        }
      },
      true
    )
  );
  document.addEventListener(
    "click",
    (event) => {
      const tab = event.target && event.target.closest && event.target.closest(`.${TAB_CLASS}`);
      if (!tab) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      togglePanel();
    },
    true
  );
};

export const ensureTabButton = () => {
  bindDelegates();
  const bar = document.querySelector("nav.ut-tab-bar");
  if (!bar || bar.querySelector(`.${TAB_CLASS}`)) {
    return;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = `ut-tab-bar-item ${TAB_CLASS}`;
  button.setAttribute("aria-label", "MagicBuyer");
  button.innerHTML = "<span>MagicBuyer</span>";
  bar.appendChild(button);
};

// ------------------------------------------------- EA Transfer Market

const readController = (ctrl) => {
  const viewmodel = ctrl && ctrl.viewmodel;
  if (!viewmodel || !viewmodel.searchCriteria) {
    return null;
  }
  return snapshotFromEaCriteria(viewmodel.searchCriteria, viewmodel.playerData);
};

const captureController = (ctrl, quiet) => {
  const snapshot = readController(ctrl);
  if (snapshot) {
    setLastEaSearch(snapshot);
    if (!quiet) {
      log.info(t("ui.ea.log.captured"));
    }
  }
  return snapshot;
};

const searchBarHtml = () => `<strong>⚡ MagicBuyer</strong>
    <button type="button" data-mb-ea="snipe">${escapeHtml(t("ui.ea.bar.snipe"))}</button>
    <button type="button" class="is-ghost" data-mb-ea="open">${escapeHtml(t("ui.ea.bar.open"))}</button>`;

const injectSearchBar = (ctrl) => {
  let rootEl = null;
  try {
    const view = typeof ctrl.getView === "function" ? ctrl.getView() : null;
    rootEl = view && typeof view.getRootElement === "function" ? view.getRootElement() : null;
  } catch (e) {
    rootEl = null;
  }
  if (!rootEl || rootEl.querySelector(".mb-ea-bar")) {
    return;
  }
  const host = rootEl.querySelector(".ut-content") || rootEl;
  const bar = document.createElement("div");
  bar.className = "mb-ea-bar";
  bar.innerHTML = searchBarHtml();
  bar.addEventListener("click", (event) => {
    const button = event.target.closest("[data-mb-ea]");
    if (!button) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (button.dataset.mbEa === "open") {
      togglePanel();
      return;
    }
    const snapshot = captureController(currentSearchController || ctrl, true);
    if (!snapshot) {
      log.warn(t("ui.ea.log.readFailed"));
      return;
    }
    // An already configured filter is never overwritten: a new one is created.
    const active = getActiveFilter();
    importSnapshot(snapshot, { asNew: !!(active && filterHasTarget(active)) });
    const filter = getActiveFilter();
    const name = filter ? filter.name : t("ui.ea.log.defaultFilter");
    log.success(
      filter && filter.maxBuy
        ? t("ui.ea.log.importedWithMax", { name, price: formatCoins(filter.maxBuy) })
        : t("ui.ea.log.importedNoMax", { name })
    );
    showTargetTab();
  });
  host.insertBefore(bar, host.firstChild);
};

const hookMarketSearch = () => {
  const Ctrl = pageGlobal("UTMarketSearchFiltersViewController");
  if (typeof Ctrl !== "function" || !Ctrl.prototype || Ctrl.prototype.__mbHooked) {
    return !!(Ctrl && Ctrl.prototype && Ctrl.prototype.__mbHooked);
  }
  const proto = Ctrl.prototype;
  const originalAppear = proto.viewDidAppear;
  if (typeof originalAppear === "function") {
    proto.viewDidAppear = function () {
      const result = originalAppear.apply(this, arguments);
      try {
        currentSearchController = this;
        injectSearchBar(this);
      } catch (e) {}
      return result;
    };
  }
  const originalSearch = proto.eSearchSelected;
  if (typeof originalSearch === "function") {
    proto.eSearchSelected = function () {
      try {
        currentSearchController = this;
        captureController(this, true);
      } catch (e) {}
      return originalSearch.apply(this, arguments);
    };
  }
  proto.__mbHooked = true;
  return true;
};

// --------------------------------------- listing panel: net + profit

const taxInfoHtml = () =>
  `<span>${escapeHtml(t("ui.ea.tax.net"))} <b data-mb-net>—</b></span><span>${escapeHtml(t("ui.ea.tax.profit"))} <b data-mb-profit>—</b></span>`;

// Injected static texts are rendered again in the new language; values are refilled on the next tick.
const watchLanguage = () => {
  if (languageWatched) {
    return;
  }
  languageWatched = true;
  onLanguageChange(() => {
    document.querySelectorAll(".mb-ea-bar").forEach((bar) => {
      bar.innerHTML = searchBarHtml();
    });
    document.querySelectorAll(".mb-tax-info").forEach((info) => {
      info.innerHTML = taxInfoHtml();
    });
    try {
      paintQuickList();
    } catch (e) {}
  });
};

const paintQuickList = () => {
  document.querySelectorAll(".ut-quick-list-panel-view").forEach((panel) => {
    const inputs = panel.querySelectorAll("input.ut-number-input-control");
    const binInput = inputs[1];
    if (!binInput) {
      return;
    }
    let info = panel.querySelector(".mb-tax-info");
    if (!info) {
      info = document.createElement("div");
      info.className = "mb-tax-info";
      info.innerHTML = taxInfoHtml();
      const row = binInput.closest(".panelActionRow") || binInput.parentElement;
      if (row && row.parentNode) {
        row.parentNode.insertBefore(info, row.nextSibling);
      } else {
        panel.appendChild(info);
      }
    }
    const bin = toInt(binInput.value);
    const boughtEl = panel.querySelector(".boughtPriceValue");
    const bought = toInt(boughtEl && boughtEl.textContent);
    const net = afterTax(bin);
    setText(qs(info, "[data-mb-net]"), bin ? formatCoins(net) : "—");
    const profitEl = qs(info, "[data-mb-profit]");
    const profit = bought ? net - bought : null;
    setText(profitEl, profit == null ? "—" : `${profit >= 0 ? "+" : ""}${formatCoins(profit)}`);
    profitEl.classList.toggle("is-neg", profit != null && profit < 0);
  });
};

export const tickEaHooks = () => {
  watchLanguage();
  try {
    ensureTabButton();
  } catch (e) {}
  try {
    hookMarketSearch();
  } catch (e) {}
  try {
    paintQuickList();
  } catch (e) {}
};
