import { pageGlobal } from "../core/page";
import { floorPrice, formatCoins, priceAbove, priceBelow, roundPrice, startPriceFor, toInt } from "../core/prices";
import { percentRange } from "../core/listing";
import { randomBetween } from "../core/ranges";
import { getSettings } from "../core/settings";
import { onLanguageChange, t } from "../i18n";
import { currentPrice, getPriceRecord, onPriceUpdate, requestPrice, trackPrice } from "../prices/priceService";
import { escapeHtml } from "./dom";

// "List on Transfer Market" panel of the web app: the card's FUTBIN price + a button that fills the prices
// (Buy Now = FUTBIN % from the Sell tab, start = one step below). Listing is still done
// with the EA button: you always see the price before confirming.

const ROW = "mb-ql-futbin";
const FRESH = 60 * 1000;
const USABLE = 10 * 60 * 1000;
const rows = new Set();
let hooked = false;
let listening = false;

const call = (target, method) => {
  try {
    return target && typeof target[method] === "function" ? target[method]() : undefined;
  } catch (e) {
    return undefined;
  }
};

const hintOf = (item) => {
  try {
    const data = (typeof item.getStaticData === "function" && item.getStaticData()) || item._staticData || {};
    const name = (data.knownAs && data.knownAs !== "---" ? data.knownAs : "") || data.name || data.lastName || "";
    return { name: String(name).trim(), rating: Number(item.rating) || 0 };
  } catch (e) {
    return { name: "", rating: 0 };
  }
};

// Suggested price (Buy Now + start), clamped to the card's EA limits. The percentage
// (Sell tab range) is drawn once per card so the button stays stable.
const proposal = (state) => {
  const reference = currentPrice(state.id, USABLE, "sell");
  if (!reference) {
    return null;
  }
  if (!state.percent) {
    const range = percentRange(getSettings().sell.futbinPercent);
    state.percent = randomBetween(range.min, range.max);
  }
  const percent = state.percent;
  let buyNow = roundPrice((reference * percent) / 100);
  const limits = call(state.item, "getPriceLimits") || state.item._itemPriceLimits || null;
  const min = limits ? toInt(limits.minimum) : 0;
  const max = limits ? toInt(limits.maximum) : 0;
  if (max && buyNow > max) {
    buyNow = floorPrice(max);
  }
  if (min && buyNow <= min) {
    buyNow = priceAbove(min);
  }
  let start = startPriceFor(buyNow);
  if (min && start < min) {
    start = min;
  }
  if (start >= buyNow) {
    start = priceBelow(buyNow) || start;
  }
  return { reference, buyNow, start, percent };
};

const paintRow = (row) => {
  const state = row.__mb;
  if (!state) {
    return;
  }
  const record = getPriceRecord(state.id);
  const info = row.querySelector("[data-mb-ql-info]");
  const button = row.querySelector("[data-mb-ql-fill]");
  const offer = proposal(state);
  if (!offer) {
    info.textContent = record && record.status === "miss" ? t("ui.quickList.notFound") : t("ui.quickList.loading");
    button.disabled = true;
    button.textContent = t("ui.quickList.button");
    return;
  }
  const age = Math.round((Date.now() - record.fetchedAt) / 60000);
  const when = age < 1 ? t("ui.quickList.justNow") : t("ui.quickList.minutesAgo", { minutes: age });
  info.textContent = `FUTBIN ${formatCoins(offer.reference)}${record.suspect ? " ⚠" : ""} · ${when}`;
  state.offer = offer;
  button.disabled = false;
  button.textContent = t("ui.quickList.fill", { price: formatCoins(offer.buyNow) });
  button.title = t("ui.quickList.fillTitle", {
    buyNow: formatCoins(offer.buyNow),
    percent: Math.round(offer.percent),
    start: formatCoins(offer.start),
  });
};

const fill = (event) => {
  event.preventDefault();
  event.stopPropagation();
  const row = event.currentTarget.closest(`.${ROW}`);
  const state = row && row.__mb;
  if (!state || !state.offer) {
    return;
  }
  try {
    const view = state.ctrl.getView();
    view.setBidValue(state.offer.start);
    view.setBuyNowValue(state.offer.buyNow);
  } catch (e) {}
};

const swallow = (event) => event.stopPropagation();

const buildRow = () => {
  const row = document.createElement("div");
  row.className = `panelActionRow ${ROW}`;
  row.innerHTML = `<span class="mb-ql-info" data-mb-ql-info>FUTBIN…</span><button type="button" class="mb-ql-fill" data-mb-ql-fill>${escapeHtml(t("ui.quickList.button"))}</button>`;
  const button = row.querySelector("[data-mb-ql-fill]");
  button.addEventListener("click", fill);
  ["pointerdown", "mousedown", "touchstart", "touchend", "mouseup", "pointerup"].forEach((type) =>
    button.addEventListener(type, swallow)
  );
  return row;
};

const release = (row) => {
  const state = row.__mb;
  if (state && state.untrack) {
    state.untrack();
  }
  row.__mb = null;
  rows.delete(row);
};

const decorate = (ctrl) => {
  const view = call(ctrl, "getView");
  const root = view && call(view, "getRootElement");
  if (!root) {
    return;
  }
  const item = ctrl.item;
  let row = root.querySelector(`.${ROW}`);
  const id = item && call(item, "isPlayer") && !item.concept ? Number(item.definitionId) || 0 : 0;
  if (!id) {
    if (row) {
      release(row);
      row.remove();
    }
    return;
  }
  if (!row) {
    row = buildRow();
    const actions = root.querySelector(".panelActions") || root;
    actions.insertBefore(row, actions.firstChild);
  }
  if (!row.__mb || row.__mb.id !== id || row.__mb.item !== item) {
    if (row.__mb) {
      release(row);
    }
    const hint = hintOf(item);
    row.__mb = { ctrl, item, id, untrack: trackPrice(id, hint, "visible"), offer: null, percent: 0 };
    rows.add(row);
    if (!currentPrice(id, FRESH)) {
      requestPrice(id, hint);
    }
  }
  row.__mb.ctrl = ctrl;
  paintRow(row);
};

export const hookQuickList = () => {
  if (!listening) {
    listening = true;
    onPriceUpdate((id) => {
      rows.forEach((row) => {
        if (!row.isConnected) {
          release(row);
        } else if (row.__mb && row.__mb.id === Number(id)) {
          paintRow(row);
        }
      });
    });
    const repaintAll = () => rows.forEach((row) => (row.isConnected ? paintRow(row) : release(row)));
    setInterval(repaintAll, 15000);
    onLanguageChange(repaintAll);
  }
  if (hooked) {
    return true;
  }
  const Ctrl = pageGlobal("UTQuickListPanelViewController");
  if (typeof Ctrl !== "function" || !Ctrl.prototype || typeof Ctrl.prototype.renderView !== "function") {
    return false;
  }
  if (!Ctrl.prototype.__mbFutbin) {
    const original = Ctrl.prototype.renderView;
    Ctrl.prototype.renderView = function () {
      const result = original.apply(this, arguments);
      try {
        decorate(this);
      } catch (e) {}
      return result;
    };
    Ctrl.prototype.__mbFutbin = true;
  }
  hooked = true;
  return true;
};
