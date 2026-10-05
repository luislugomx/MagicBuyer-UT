import { listTransferAtFutbin } from "../../core/bulkSell";
import { isRunning } from "../../core/engine";
import * as market from "../../core/market";
import { log } from "../../core/logger";
import { notifyEvent, requestDesktopPermission, sound } from "../../core/notify";
import { formatCoins } from "../../core/prices";
import { TIMING_PRESETS, applyTimingPreset, getSettings, setSetting } from "../../core/settings";
import { getState, updateState } from "../../core/state";
import { beginTask, cancelTask, currentTask, endTask } from "../../core/tasks";
import { t } from "../../i18n";
import { qs, setHtml } from "../dom";
import {
  grid,
  numberField,
  priceField,
  rangeField,
  section,
  selectField,
  textField,
  toggleField,
} from "../fields";

// -------------------------------------------------------------------- Buy

export const buyPageHtml = () => `
  ${section(
    t("pages.buy.section.buyNow"),
    grid(
      numberField({ bind: "s:buy.maxPerSearch", label: t("pages.buy.maxPerSearch.label"), min: 1, max: 5, hint: t("pages.buy.maxPerSearch.hint") }),
      numberField({ bind: "s:buy.stopAfterPurchases", label: t("pages.buy.stopAfterPurchases.label"), placeholder: t("pages.common.unlimited"), hint: t("pages.buy.stopAfterPurchases.hint") }),
      priceField({ bind: "s:buy.coinsReserve", label: t("pages.buy.coinsReserve.label"), hint: t("pages.buy.coinsReserve.hint") }),
      numberField({ bind: "s:buy.maxResults", label: t("pages.buy.maxResults.label"), placeholder: t("pages.common.disabled"), hint: t("pages.buy.maxResults.hint") }),
      toggleField({ bind: "s:buy.skipGk", label: t("pages.buy.skipGk.label"), wide: true })
    )
  )}
  <div class="mb-note">${t("pages.buy.futbinNote")}</div>
  ${section(
    t("pages.buy.section.bids"),
    grid(
      toggleField({ bind: "s:bid.enabled", label: t("pages.buy.bid.enabled.label"), wide: true, hint: t("pages.buy.bid.enabled.hint") }),
      rangeField({ bind: "s:bid.expiresWithin", label: t("pages.buy.bid.expiresWithin.label"), unit: "M", placeholder: "5M", hint: t("pages.buy.bid.expiresWithin.hint") }),
      numberField({ bind: "s:bid.maxPerSearch", label: t("pages.buy.bid.maxPerSearch.label"), min: 1, max: 5 }),
      numberField({ bind: "s:bid.searchEvery", label: t("pages.buy.bid.searchEvery.label"), min: 2, max: 20, hint: t("pages.buy.bid.searchEvery.hint") }),
      numberField({ bind: "s:bid.maxActive", label: t("pages.buy.bid.maxActive.label"), min: 1, max: 50 }),
      toggleField({ bind: "s:bid.exact", label: t("pages.buy.bid.exact.label") }),
      toggleField({ bind: "s:bid.rebid", label: t("pages.buy.bid.rebid.label") }),
      toggleField({ bind: "s:bid.clearLost", label: t("pages.buy.bid.clearLost.label"), wide: true })
    )
  )}
`;

// ------------------------------------------------------------------- Sell

export const sellPageHtml = () => `
  ${section(
    t("pages.sell.section.afterBuy"),
    grid(
      selectField({
        bind: "s:sell.mode",
        label: t("pages.sell.mode.label"),
        wide: true,
        options: [
          ["list", t("pages.sell.mode.list")],
          ["transfer", t("pages.sell.mode.transfer")],
          ["none", t("pages.sell.mode.none")],
        ],
      }),
      selectField({
        bind: "s:sell.duration",
        label: t("pages.sell.duration.label"),
        options: [
          ["1H", t("pages.sell.duration.hours", { count: 1 })],
          ["3H", t("pages.sell.duration.hours", { count: 3 })],
          ["6H", t("pages.sell.duration.hours", { count: 6 })],
          ["12H", t("pages.sell.duration.hours", { count: 12 })],
          ["1D", t("pages.sell.duration.oneDay")],
          ["3D", t("pages.sell.duration.days", { count: 3 })],
        ],
      }),
      priceField({ bind: "s:sell.minProfit", label: t("pages.sell.minProfit.label"), hint: t("pages.sell.minProfit.hint") }),
      numberField({ bind: "s:sell.maxRating", label: t("pages.sell.maxRating.label"), placeholder: t("pages.common.disabled") })
    )
  )}
  ${section(
    t("pages.sell.section.price"),
    grid(
      selectField({
        bind: "s:sell.priceMode",
        label: t("pages.sell.priceMode.label"),
        wide: true,
        options: [
          ["fixed", t("pages.sell.priceMode.fixed")],
          ["futbin", t("pages.sell.priceMode.futbin")],
        ],
        hint: t("pages.sell.priceMode.hint"),
      }),
      priceField({ bind: "s:sell.defaultPrice", label: t("pages.sell.defaultPrice.label"), wide: true, showIf: "s:sell.priceMode=fixed" }),
      rangeField({
        bind: "s:sell.futbinPercent",
        label: t("pages.sell.futbinPercent.label"),
        unit: null,
        placeholder: "99-100",
        wide: true,
        showIf: "s:sell.priceMode=futbin",
        hint: t("pages.sell.futbinPercent.hint"),
      })
    )
  )}
  <div class="mb-note">${t("pages.sell.note")}</div>
`;

// ------------------------------------------------------------------ Timing

const presetButtons = () =>
  Object.keys(TIMING_PRESETS)
    .map((key) => {
      const preset = TIMING_PRESETS[key];
      const active = getSettings().timing.preset === key;
      return `<button type="button" class="mb-preset${active ? " is-active" : ""}" data-preset="${key}">
        <b>${t(preset.labelKey)}</b><small>${t(preset.hintKey)}</small>
      </button>`;
    })
    .join("");

export const timingPageHtml = () => `
  ${section(t("pages.timing.section.profile"), `<div class="mb-presets" data-presets>${presetButtons()}</div>`)}
  ${section(
    t("pages.timing.section.pace"),
    grid(
      rangeField({ bind: "s:timing.wait", label: t("pages.timing.wait.label"), unit: "S", placeholder: "5-9", key: true, wide: true, hint: t("pages.timing.wait.hint") }),
      numberField({ bind: "s:timing.maxPerMinute", label: t("pages.timing.maxPerMinute.label"), placeholder: t("pages.common.unlimited"), hint: t("pages.timing.maxPerMinute.hint") }),
      rangeField({ bind: "s:timing.afterBuy", label: t("pages.timing.afterBuy.label"), unit: "S", optional: true, placeholder: "2-4S" })
    )
  )}
  ${section(
    t("pages.timing.section.pauses"),
    grid(
      rangeField({ bind: "s:timing.pauseEvery", label: t("pages.timing.pauseEvery.label"), unit: null, optional: true, placeholder: "15-25", hint: t("pages.timing.pauseEvery.hint") }),
      rangeField({ bind: "s:timing.pauseFor", label: t("pages.timing.pauseFor.label"), unit: "S", optional: true, placeholder: "40-80S" }),
      rangeField({ bind: "s:timing.stopAfter", label: t("pages.timing.stopAfter.label"), unit: "H", optional: true, placeholder: "2-3H", hint: t("pages.timing.stopAfter.hint"), wide: true })
    )
  )}
  ${section(
    t("pages.timing.section.freshness"),
    grid(
      selectField({
        bind: "s:timing.cacheBuster",
        label: t("pages.timing.cacheBuster.label"),
        wide: true,
        options: [
          ["auto", t("pages.timing.cacheBuster.auto")],
          ["minBuy", t("pages.timing.cacheBuster.minBuy")],
          ["minBid", t("pages.timing.cacheBuster.minBid")],
          ["off", t("pages.common.disabledCapital")],
        ],
        hint: t("pages.timing.cacheBuster.hint"),
      }),
      numberField({ bind: "s:timing.maxPages", label: t("pages.timing.maxPages.label"), min: 1, max: 5, hint: t("pages.timing.maxPages.hint") }),
      priceField({ bind: "s:timing.cacheBusterMax", label: t("pages.timing.cacheBusterMax.label"), hint: t("pages.timing.cacheBusterMax.hint") }),
      toggleField({ bind: "s:timing.keepAlive", label: t("pages.timing.keepAlive.label"), wide: true, hint: t("pages.timing.keepAlive.hint") })
    )
  )}
  ${section(
    t("pages.timing.section.errors"),
    grid(
      rangeField({ bind: "s:errors.cooldown", label: t("pages.timing.cooldown.label"), unit: "M", placeholder: "4-8M", wide: true }),
      numberField({ bind: "s:errors.maxCooldowns", label: t("pages.timing.maxCooldowns.label"), min: 0, max: 20 }),
      numberField({ bind: "s:errors.maxConsecutiveFailures", label: t("pages.timing.maxFailures.label"), min: 1, max: 20 }),
      textField({ bind: "s:errors.stopCodes", label: t("pages.timing.stopCodes.label"), placeholder: t("pages.timing.stopCodes.placeholder"), wide: true })
    ) +
      `<div class="mb-note is-warn" style="margin-top:8px">${t("pages.timing.errors.note")}</div>`
  )}
`;

// --------------------------------------------------------- Transfer List

const transferStatsHtml = () => {
  const transfer = getState().transfer;
  if (!transfer) {
    return `<p class="mb-empty">${t("pages.transfer.notLoaded")}</p>`;
  }
  const cell = (label, value) => `<div>${label}<b>${value}</b></div>`;
  return `<div class="mb-stats-list">
    ${cell(t("pages.transfer.stats.active"), transfer.active)}
    ${cell(t("pages.transfer.stats.sold"), transfer.sold)}
    ${cell(t("pages.transfer.stats.unsold"), transfer.unsold)}
    ${cell(t("pages.transfer.stats.available"), transfer.available)}
    ${cell(t("pages.transfer.stats.usage"), `${transfer.total}${transfer.capacity ? ` / ${transfer.capacity}` : ""}`)}
    ${cell(t("pages.transfer.stats.soldValue"), formatCoins(transfer.soldValue))}
  </div>`;
};

export const transferPageHtml = () => `
  ${section(t("pages.transfer.section.list"), `<div data-transfer-stats>${transferStatsHtml()}</div>
    <div class="mb-row" style="margin-top:8px">
      <button type="button" class="mb-btn mb-btn-ghost mb-btn-sm" data-transfer-action="refresh">${t("pages.transfer.refresh")}</button>
      <button type="button" class="mb-btn mb-btn-ghost mb-btn-sm" data-transfer-action="relist">${t("pages.transfer.relist")}</button>
      <button type="button" class="mb-btn mb-btn-ghost mb-btn-sm" data-transfer-action="clear">${t("pages.transfer.clearSold")}</button>
    </div>`)}
  ${section(
    t("pages.transfer.section.futbin"),
    `<p class="mb-hint">${t("pages.transfer.futbin.hint")}</p>
     <div class="mb-row" style="margin-top:8px">
       <button type="button" class="mb-btn mb-btn-primary mb-btn-sm" data-transfer-action="futbin">${t("pages.transfer.futbin.start")}</button>
       <button type="button" class="mb-btn mb-btn-danger mb-btn-sm" data-transfer-action="futbin-stop" hidden>${t("pages.transfer.futbin.stop")}</button>
     </div>
     <div data-transfer-futbin></div>`
  )}
  ${section(
    t("pages.transfer.section.auto"),
    grid(
      toggleField({ bind: "s:transfer.relistExpired", label: t("pages.transfer.relistExpired.label"), wide: true, hint: t("pages.transfer.relistExpired.hint") }),
      selectField({
        bind: "s:transfer.relistMode",
        label: t("pages.transfer.relistMode.label"),
        wide: true,
        showIf: "s:transfer.relistExpired=true",
        options: [
          ["same", t("pages.transfer.relistMode.same")],
          ["futbin", t("pages.transfer.relistMode.futbin")],
        ],
        hint: t("pages.transfer.relistMode.hint"),
      }),
      numberField({ bind: "s:transfer.clearSoldAt", label: t("pages.transfer.clearSoldAt.label"), placeholder: t("pages.common.never"), hint: t("pages.transfer.clearSoldAt.hint") }),
      numberField({ bind: "s:transfer.checkEvery", label: t("pages.transfer.checkEvery.label"), min: 1, max: 100, hint: t("pages.transfer.checkEvery.hint") }),
      toggleField({ bind: "s:transfer.stopWhenFull", label: t("pages.transfer.stopWhenFull.label"), wide: true })
    )
  )}
`;

// ----------------------------------------------------------------- Alerts

export const alertsPageHtml = () => `
  ${section(
    t("pages.alerts.section.soundDesktop"),
    grid(
      toggleField({ bind: "s:notify.sound", label: t("pages.alerts.sound.label"), hint: t("pages.alerts.sound.hint") }),
      numberField({ bind: "s:notify.volume", label: t("pages.alerts.volume.label"), float: true, min: 0, max: 1 }),
      toggleField({ bind: "s:notify.desktop", label: t("pages.alerts.desktop.label"), wide: true, hint: t("pages.alerts.desktop.hint") })
    ) +
      `<div class="mb-row" style="margin-top:8px">
        <button type="button" class="mb-btn mb-btn-ghost mb-btn-sm" data-sound="buy">${t("pages.alerts.testBuy")}</button>
        <button type="button" class="mb-btn mb-btn-ghost mb-btn-sm" data-sound="alert">${t("pages.alerts.testAlert")}</button>
      </div>`
  )}
  ${section(
    "Discord & Telegram",
    grid(
      textField({ bind: "s:notify.discordWebhook", label: t("pages.alerts.discordWebhook.label"), placeholder: "https://discord.com/api/webhooks/…", secret: true, wide: true }),
      textField({ bind: "s:notify.telegramToken", label: t("pages.alerts.telegramToken.label"), placeholder: "123456:ABC…", secret: true, wide: true }),
      textField({ bind: "s:notify.telegramChatId", label: t("pages.alerts.telegramChatId.label"), placeholder: t("pages.alerts.telegramChatId.placeholder"), wide: true })
    ) +
      `<div class="mb-row" style="margin-top:8px"><button type="button" class="mb-btn mb-btn-primary mb-btn-sm" data-notify-test>${t("pages.alerts.sendTest")}</button><span class="mb-hint" data-notify-result></span></div>`
  )}
  ${section(
    t("pages.alerts.section.when"),
    grid(
      toggleField({ bind: "s:notify.onBuy", label: t("pages.alerts.onBuy.label") }),
      toggleField({ bind: "s:notify.onFail", label: t("pages.alerts.onFail.label") }),
      toggleField({ bind: "s:notify.onList", label: t("pages.alerts.onList.label") }),
      toggleField({ bind: "s:notify.onStop", label: t("pages.alerts.onStop.label") })
    ) + `<p class="mb-hint">${t("pages.alerts.alwaysNotified")}</p>`
  )}
`;

// ---------------------------------------------------------------- bindings

export const bindSettingsPages = (body, refreshAll) => {
  body.addEventListener("click", async (event) => {
    const target = event.target;
    const preset = target.closest("[data-preset]");
    if (preset) {
      applyTimingPreset(preset.dataset.preset);
      setHtml(qs(body, "[data-presets]"), presetButtons());
      refreshAll();
      return;
    }
    const soundBtn = target.closest("[data-sound]");
    if (soundBtn) {
      const previous = getSettings().notify.sound;
      if (!previous) {
        setSetting("notify.sound", true);
      }
      sound(soundBtn.dataset.sound);
      if (!previous) {
        setSetting("notify.sound", false);
      }
      return;
    }
    if (target.closest("[data-notify-test]")) {
      const result = qs(body, "[data-notify-result]");
      result.textContent = t("pages.alerts.sending");
      const sent = await notifyEvent("test", t("pages.alerts.testMessage"));
      const ok = sent.filter(Boolean).length;
      result.textContent = ok ? t("pages.alerts.testOk", { count: ok }) : t("pages.alerts.testNone");
      return;
    }
    const action = target.closest("[data-transfer-action]");
    if (action) {
      if (action.dataset.transferAction === "futbin-stop") {
        cancelTask();
        return;
      }
      if (isRunning() && action.dataset.transferAction !== "refresh") {
        log.warn(t("pages.transfer.log.botRunning"));
        return;
      }
      if (action.dataset.transferAction === "futbin") {
        await runFutbinListing(body);
        return;
      }
      action.disabled = true;
      try {
        await runTransferAction(action.dataset.transferAction);
      } finally {
        action.disabled = false;
        setHtml(qs(body, "[data-transfer-stats]"), transferStatsHtml());
      }
    }
  });
  body.addEventListener("click", (event) => {
    const toggle = event.target.closest && event.target.closest('[data-bind="s:notify.desktop"]');
    if (!toggle) {
      return;
    }
    // After fields.js has flipped the toggle: ask for permission if it is now on.
    setTimeout(async () => {
      if (!getSettings().notify.desktop) {
        return;
      }
      const permission = await requestDesktopPermission();
      if (permission !== "granted") {
        setSetting("notify.desktop", false);
        log.warn(t("pages.alerts.log.desktopDenied"));
        refreshAll();
      }
    }, 0);
  });
};

// Bulk listing at the FUTBIN price, with progress tracking and a Stop button.
const runFutbinListing = async (body) => {
  const out = qs(body, "[data-transfer-futbin]");
  const startBtn = qs(body, '[data-transfer-action="futbin"]');
  const stopBtn = qs(body, '[data-transfer-action="futbin-stop"]');
  const task = beginTask(t("pages.transfer.futbin.taskLabel"));
  if (!task) {
    const other = currentTask();
    out.innerHTML = `<div class="mb-note is-warn" style="margin-top:8px">${t("pages.transfer.futbin.busy", { task: other ? other.label : "?" })}</div>`;
    return;
  }
  startBtn.disabled = true;
  stopBtn.hidden = false;
  const paint = (report) => {
    out.innerHTML = `<div class="mb-note" style="margin-top:8px">${t("pages.transfer.futbin.progress", {
      listed: report.listed,
      total: report.total,
    })}${report.skipped ? ` · ${t("pages.transfer.futbin.skipped", { count: report.skipped })}` : ""}${
      report.current ? ` · ${t("pages.transfer.futbin.current", { name: report.current })}` : ""
    }</div>`;
  };
  try {
    const report = await listTransferAtFutbin({ token: task.token, onProgress: paint });
    paint(report);
    const text =
      t("pages.transfer.futbin.done", { listed: report.listed, total: report.total }) +
      (report.noPrice ? ` · ${t("pages.transfer.futbin.noPrice", { count: report.noPrice })}` : "") +
      (report.stopped ? ` · ${t("pages.transfer.futbin.stopped", { reason: report.stopped })}` : "");
    out.innerHTML = `<div class="mb-note${report.stopped ? " is-warn" : ""}" style="margin-top:8px">${text}.</div>`;
    log.info(`${text}.`);
  } finally {
    endTask(task);
    startBtn.disabled = false;
    stopBtn.hidden = true;
    await runTransferAction("refresh");
    setHtml(qs(body, "[data-transfer-stats]"), transferStatsHtml());
  }
};

export const refreshTransferStats = (body) => {
  const el = qs(body, "[data-transfer-stats]");
  if (el) {
    setHtml(el, transferStatsHtml());
  }
};

const runTransferAction = async (action) => {
  if (action === "refresh") {
    const result = await market.fetchTransferList();
    if (result.ok) {
      const summary = market.summarizeTransferList(result.items);
      updateState({ transfer: Object.assign({ capacity: market.pileCapacity("TRANSFER") }, summary) });
    } else {
      log.warn(t("pages.transfer.log.unavailable", { error: result.error.label }));
    }
    return;
  }
  if (action === "relist") {
    const result = await market.relistExpired();
    if (result.ok) {
      log.success(t("pages.transfer.log.relisted"));
    } else {
      log.warn(t("pages.transfer.log.relistFailed", { error: result.error.label }));
    }
  }
  if (action === "clear") {
    const result = await market.clearSold();
    if (result.ok) {
      log.success(t("pages.transfer.log.cleared"));
      await market.refreshCoins();
    } else {
      log.warn(t("pages.transfer.log.clearFailed", { error: result.error.label }));
    }
  }
  await runTransferAction("refresh");
};

