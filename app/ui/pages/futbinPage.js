import { log } from "../../core/logger";
import { formatCoins } from "../../core/prices";
import { fetchFutbinPrice, futbinRequestCount, resolveFutbinLink } from "../../prices/futbinClient";
import { clearFutbinCache, getFutbinStatus, pricePlatform } from "../../prices/priceService";
import { numberLocale, t } from "../../i18n";
import { escapeHtml, qs, setHtml } from "../dom";
import { grid, numberField, rangeField, section, selectField, toggleField } from "../fields";

// FUTBIN tab: access (test), refresh rate, price tags on cards, SBC.

const TEST_CARD = { definitionId: 231747, name: "Mbappé", rating: 0 };

// Translation keys of the price service states, resolved at render time.
const STATE_KEYS = {
  idle: "pages.futbin.state.idle",
  fetching: "pages.futbin.state.fetching",
  queued: "pages.futbin.state.queued",
  blocked: "pages.futbin.state.blocked",
};

const ago = (timestamp) => {
  if (!timestamp) {
    return t("pages.common.never");
  }
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  return t("pages.futbin.ago", { time: seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min` });
};

const statusHtml = () => {
  const status = getFutbinStatus();
  const cell = (label, value) => `<div>${label}<b>${value}</b></div>`;
  const blocked = status.blockedUntil > Date.now();
  return `<div class="mb-stats-list">
      ${cell(t("pages.futbin.status.state"), escapeHtml(STATE_KEYS[status.state] ? t(STATE_KEYS[status.state]) : status.state))}
      ${cell(t("pages.futbin.status.platform"), pricePlatform() === "pc" ? "PC" : t("pages.futbin.platform.console"))}
      ${cell(t("pages.futbin.status.tracked"), status.tracked)}
      ${cell(t("pages.futbin.status.queue"), status.queue)}
      ${cell(t("pages.futbin.status.lastPrice"), ago(status.lastSuccessAt))}
      ${cell(t("pages.futbin.status.requests"), futbinRequestCount())}
    </div>${
      status.lastError || blocked
        ? `<div class="mb-note is-warn" style="margin-top:8px">${escapeHtml(status.lastError || t("pages.futbin.status.slowed"))}${
            blocked ? ` · ${t("pages.futbin.status.resumeIn", { seconds: Math.ceil((status.blockedUntil - Date.now()) / 1000) })}` : ""
          }</div>`
        : ""
    }`;
};

export const futbinPageHtml = () => `
  ${section(
    t("pages.futbin.section.access"),
    `<div data-futbin-status>${statusHtml()}</div>
     <div class="mb-row" style="margin-top:8px">
       <button type="button" class="mb-btn mb-btn-primary mb-btn-sm" data-futbin-action="test">${t("pages.futbin.test")}</button>
       <button type="button" class="mb-btn mb-btn-ghost mb-btn-sm" data-futbin-action="open">${t("pages.futbin.open")}</button>
       <button type="button" class="mb-btn mb-btn-ghost mb-btn-sm" data-futbin-action="clear">${t("pages.futbin.clearCache")}</button>
     </div>
     <div data-futbin-test></div>
     <p class="mb-hint">${t("pages.futbin.access.hint")}</p>`
  )}
  ${section(
    t("pages.futbin.section.refresh"),
    grid(
      selectField({
        bind: "s:prices.platform",
        label: t("pages.futbin.platform.label"),
        wide: true,
        options: [
          ["auto", t("pages.futbin.platform.auto")],
          ["console", t("pages.futbin.platform.consoleOption")],
          ["pc", "PC"],
        ],
      }),
      numberField({ bind: "s:prices.hotInterval", label: t("pages.futbin.hotInterval.label"), min: 60, max: 120, hint: t("pages.futbin.hotInterval.hint") }),
      numberField({ bind: "s:prices.visibleInterval", label: t("pages.futbin.visibleInterval.label"), min: 60, max: 600, hint: t("pages.futbin.visibleInterval.hint") }),
      numberField({ bind: "s:prices.jumpGuard", label: t("pages.futbin.jumpGuard.label"), min: 5, max: 90, hint: t("pages.futbin.jumpGuard.hint") }),
      numberField({ bind: "s:prices.minGap", label: t("pages.futbin.minGap.label"), float: true, min: 0.8, max: 10, hint: t("pages.futbin.minGap.hint") }),
      toggleField({
        bind: "s:prices.iframeFallback",
        label: t("pages.futbin.iframeFallback.label"),
        wide: true,
        hint: t("pages.futbin.iframeFallback.hint"),
      })
    )
  )}
  ${section(
    t("pages.futbin.section.display"),
    grid(
      toggleField({
        bind: "s:ui.cardPrices",
        label: t("pages.futbin.cardPrices.label"),
        wide: true,
        hint: t("pages.futbin.cardPrices.hint"),
      })
    )
  )}
  ${section(
    t("pages.futbin.section.sbc"),
    grid(
      numberField({ bind: "s:sbc.margin", label: t("pages.futbin.sbcMargin.label"), min: 0, max: 50, hint: t("pages.futbin.sbcMargin.hint") }),
      numberField({ bind: "s:sbc.triesPerPlayer", label: t("pages.futbin.sbcTries.label"), min: 1, max: 30 }),
      rangeField({ bind: "s:sbc.wait", label: t("pages.futbin.sbcWait.label"), unit: "S", placeholder: "3-5", wide: true })
    ) +
      `<p class="mb-hint">${t("pages.futbin.sbc.hint")}</p>`
  )}
`;

export const refreshFutbinStatus = (body) => {
  const el = qs(body, "[data-futbin-status]");
  if (el) {
    setHtml(el, statusHtml());
  }
};

const runTest = async (out) => {
  const started = Date.now();
  out.innerHTML = `<div class="mb-note" style="margin-top:8px">${t("pages.futbin.testRunning")}</div>`;
  // Explicit test: the direct request is retried even if FUTBIN refused it recently.
  const resolved = await resolveFutbinLink(TEST_CARD, { forceDirect: true });
  if (!resolved.ok) {
    const message = resolved.blocked
      ? t("pages.futbin.testError.blocked")
      : resolved.notFound
      ? t("pages.futbin.testError.notFound")
      : `${t("pages.futbin.testError.noResponse")}${resolved.status ? ` (${resolved.status})` : ""}.`;
    out.innerHTML = `<div class="mb-note is-warn" style="margin-top:8px">✗ ${escapeHtml(message)}</div>`;
    log.warn(t("pages.futbin.log.testFailed", { message }));
    return;
  }
  const platform = pricePlatform();
  const price = await fetchFutbinPrice(resolved.link, platform, { forceDirect: true });
  const seconds = ((Date.now() - started) / 1000).toLocaleString(numberLocale(), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  if (!price.ok) {
    const message = price.blocked
      ? t("pages.futbin.priceError.blocked")
      : price.noPrice
      ? t("pages.futbin.priceError.noPrice")
      : `${t("pages.futbin.priceError.noResponse")}${price.status ? ` (${price.status})` : ""}`;
    out.innerHTML = `<div class="mb-note is-warn" style="margin-top:8px">✗ ${escapeHtml(t("pages.futbin.priceError.searchOk", { message }))}.</div>`;
    log.warn(`${t("pages.futbin.log.testFailed", { message })}.`);
    return;
  }
  const via = price.via === "iframe" ? t("pages.futbin.via.iframe") : t("pages.futbin.via.direct");
  const age = price.updatedAgoSec
    ? ` · ${t("pages.futbin.updatedAgo", { minutes: Math.round(price.updatedAgoSec / 60) })}`
    : "";
  const name = resolved.link.name || TEST_CARD.name;
  const platformText = platform === "pc" ? "PC" : t("pages.futbin.platform.consoleLower");
  out.innerHTML = `<div class="mb-note" style="margin-top:8px">✓ ${escapeHtml(t("pages.futbin.testOk", { via }))} : ${escapeHtml(
    name
  )} = <b>${formatCoins(price.price)}</b> (${escapeHtml(platformText)})${age} · ${seconds} s</div>`;
  log.success(t("pages.futbin.log.testOk", { via, name, price: formatCoins(price.price) }));
};

export const bindFutbinPage = (page) => {
  page.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-futbin-action]");
    if (!action) {
      return;
    }
    if (action.dataset.futbinAction === "open") {
      window.open("https://www.futbin.com/", "_blank", "noopener");
      return;
    }
    if (action.dataset.futbinAction === "clear") {
      if (window.confirm(t("pages.futbin.confirmClear"))) {
        clearFutbinCache();
        log.info(t("pages.futbin.log.cacheCleared"));
        refreshFutbinStatus(page);
      }
      return;
    }
    if (action.dataset.futbinAction === "test") {
      action.disabled = true;
      try {
        await runTest(qs(page, "[data-futbin-test]"));
      } finally {
        action.disabled = false;
        refreshFutbinStatus(page);
      }
    }
  });
};
