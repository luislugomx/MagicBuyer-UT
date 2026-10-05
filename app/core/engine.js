import { startKeepAlive, stopKeepAlive, unlockAudio } from "./audio";
import { createCancelToken, sleep, withTimeout } from "./async";
import { KIND, classify, isFatal, parseCodeList } from "./errors";
import {
  buildCriteria,
  cacheBusterPrices,
  describeFilter,
  filterHasTarget,
  futbinKeyForFilter,
  getRotation,
  runnableFilters,
} from "./filters";
import { errorMessage, log } from "./logger";
import * as market from "./market";
import { notifyEvent, sound } from "./notify";
import { getCoins, getUser, isAppReady, itemService } from "./page";
import {
  durationSeconds,
  fixedSellPriceFor,
  futbinSellPrice,
  prepareListing,
  sellModeFor,
  sellPercentFor,
} from "./listing";
import { afterTax, floorPrice, formatCoins, priceAbove, profitFor, roundPrice, toInt } from "./prices";
import { formatDuration, parseRange, pickInt, pickSeconds, randomBetween } from "./ranges";
import { currentPrice, getPriceRecord, onPriceUpdate, requestPrice, trackPrice } from "../prices/priceService";
import { getSettings } from "./settings";
import { t } from "../i18n";
import { currentTask } from "./tasks";
import {
  STATUS,
  bumpStat,
  getState,
  recordSearch,
  recordTransaction,
  resetStats,
  updateState,
} from "./state";

const RELIST_MIN_GAP = 5 * 60 * 1000;
const CLEAR_MIN_GAP = 60 * 1000;
const REFERENCE_WAIT_MAX = 2 * 60 * 1000;
const MAX_SELL_DEFERRALS = 6;
// Maximum wait for a bought card's FUTBIN price before sending it unlisted to the Transfer List.
const SELL_PRICE_WAIT = 90 * 1000;
// Maximum age of a usable FUTBIN price: buying 5 min (refreshed every ≤ 2 min), selling 10 min.
const BUY_PRICE_MAX_AGE = 5 * 60 * 1000;
const SELL_PRICE_MAX_AGE = 10 * 60 * 1000;
const RELIST_RETRY = 90 * 1000;
const RELIST_BATCH = 5;
const RELIST_FALLBACK_AFTER = 3 * 60 * 1000;

let run = null;

export const isRunning = () => !!run;
export const isPaused = () => !!(run && run.paused);
export const isStopping = () => !!(run && run.stopping);
// Listing of cards bought just before stopping (Stop interrupts it).
export const isFinalizing = () => !!(run && run.finalToken && !run.finalToken.cancelled);

// ------------------------------------------------------------ utilities

const safeCall = (target, method) => {
  try {
    return !!(target && typeof target[method] === "function" && target[method]());
  } catch (e) {
    return false;
  }
};

// Wait interrupted by Stop (run token) or by Pause/Resume (one-off token).
const idle = async (ctx, ms) => {
  if (ctx.token.cancelled) {
    return false;
  }
  const interrupt = createCancelToken();
  ctx.interrupt = interrupt;
  const onStop = () => interrupt.cancel();
  ctx.token.on(onStop);
  const completed = await sleep(ms, interrupt);
  ctx.token.off(onStop);
  if (ctx.interrupt === interrupt) {
    ctx.interrupt = null;
  }
  return completed && !ctx.token.cancelled;
};

// "Not before": next allowed search. A manual pause never shortens
// a wait (time between searches, automatic pause or safety pause).
const setNotBefore = (ctx, at, kind) => {
  const now = Date.now();
  if (at >= ctx.notBefore || ctx.notBefore <= now) {
    ctx.notBefore = at;
    ctx.waitKind = kind;
    ctx.waitStartedAt = now;
  }
};

const inCooldown = (ctx) => ctx.waitKind === "cooldown" && ctx.notBefore > Date.now();
const blocked = (ctx) => ctx.token.cancelled || inCooldown(ctx);

const sessionAlive = () => !!(itemService() && getUser());

const futbinHint = (filter) => ({
  name: filter.player ? filter.player.name : "",
  rating: filter.player ? filter.player.rating : 0,
});

// Effective max buy price: fixed, or X % of the FUTBIN price (capped by the fixed price if set).
// In FUTBIN mode, without a recent price (< 5 min) the filter waits: never buy on a stale price.
const effectiveMaxBuy = (filter) => {
  const cap = toInt(filter.maxBuy);
  if (filter.priceMode !== "futbin") {
    return cap;
  }
  const key = futbinKeyForFilter(filter);
  const reference = key ? currentPrice(key, BUY_PRICE_MAX_AGE, "buy") : 0;
  if (!reference) {
    return 0;
  }
  const computed = floorPrice((reference * filter.futbinPercent) / 100);
  return cap ? Math.min(cap, computed) : computed;
};

const referencePending = (filter) =>
  filter.priceMode === "futbin" && !!futbinKeyForFilter(filter) && !effectiveMaxBuy(filter);

// "Hot" tracking (≤ 2 min) of the FUTBIN prices used by the bot while it runs.
const trackHot = (ctx, key, hint) => {
  if (!key || ctx.tracked.has(key)) {
    return;
  }
  ctx.tracked.set(key, trackPrice(key, hint, "hot"));
};

const releaseTracking = (ctx) => {
  ctx.tracked.forEach((untrack) => untrack());
  ctx.tracked.clear();
  if (ctx.unwatchPrices) {
    ctx.unwatchPrices();
    ctx.unwatchPrices = null;
  }
};

// Logs FUTBIN price changes for the bot's targets (max buy recomputed on every update).
const watchFutbinPrices = (ctx) => {
  const lastPrices = new Map();
  ctx.unwatchPrices = onPriceUpdate((definitionId, record) => {
    if (!record || !ctx.tracked.has(definitionId) || ctx.token.cancelled) {
      return;
    }
    const filter = runnableFilters().find(
      (entry) => entry.priceMode === "futbin" && futbinKeyForFilter(entry) === definitionId
    );
    if (!filter) {
      return;
    }
    if (record.suspect && !ctx.warned.has(`suspect:${definitionId}:${record.suspect.price}`)) {
      ctx.warned.add(`suspect:${definitionId}:${record.suspect.price}`);
      log.warn(
        t("engine.price.suspectJump", { name: filter.name, price: formatCoins(record.suspect.price) })
      );
      return;
    }
    const previous = lastPrices.get(definitionId);
    lastPrices.set(definitionId, record.price);
    if (previous && previous !== record.price && record.price) {
      log.info(
        t("engine.price.changed", {
          name: filter.name,
          previous: formatCoins(previous),
          price: formatCoins(record.price),
          maxBuy: formatCoins(effectiveMaxBuy(filter)),
        })
      );
    }
  });
};

const matchesTarget = (item, filter) => {
  if (filter.definitionId) {
    return Number(item.definitionId) === filter.definitionId;
  }
  if (filter.player && filter.player.id) {
    return market.baseIdOf(item) === filter.player.id;
  }
  return true;
};

const purchaseLimitReached = (settings) => {
  const maxBuys = toInt(settings.buy.stopAfterPurchases);
  return !!(maxBuys && getState().stats.won >= maxBuys);
};

// ------------------------------------------------------------------ startup

const preflight = () => {
  if (!isAppReady()) {
    return t("engine.preflight.appNotReady");
  }
  if (!getUser()) {
    return t("engine.preflight.notLoggedIn");
  }
  const task = currentTask();
  if (task) {
    return t("engine.preflight.taskRunning", { task: task.label });
  }
  const settings = getSettings();
  const filters = runnableFilters().filter(filterHasTarget);
  if (!filters.length) {
    return t("engine.preflight.noTarget");
  }
  if (filters.some((filter) => filter.priceMode === "futbin" && !futbinKeyForFilter(filter))) {
    return t("engine.preflight.futbinNeedsPlayer");
  }
  const usable = filters.filter(
    (filter) =>
      (filter.priceMode === "futbin" ? futbinKeyForFilter(filter) : filter.maxBuy) ||
      (settings.bid.enabled && filter.maxBid)
  );
  if (!usable.length) {
    return t("engine.preflight.noPrice");
  }
  if (!parseRange(settings.timing.wait, "S")) {
    return t("engine.preflight.invalidWait");
  }
  return null;
};

export const startBot = () => {
  if (run) {
    if (run.stopping) {
      log.warn(t("engine.start.stillStopping"));
      return false;
    }
    if (run.paused) {
      resumeBot();
    }
    return true;
  }
  unlockAudio();
  const problem = preflight();
  if (problem) {
    log.error(problem);
    updateState({ detail: problem });
    return false;
  }
  const settings = getSettings();
  const stopAfter = pickSeconds(settings.timing.stopAfter, "H");
  const ctx = {
    token: createCancelToken(),
    interrupt: null,
    paused: false,
    stopping: false,
    stopReason: "",
    stopAlert: false,
    manualStop: false,
    attempted: new Set(),
    retries: new Map(),
    bids: new Map(),
    userWatched: new Set(),
    sellQueue: [],
    errorCounts: new Map(),
    searchCount: 0,
    searchesSincePause: 0,
    pauseAfter: pickInt(settings.timing.pauseEvery),
    stopAt: stopAfter > 0 ? Date.now() + stopAfter * 1000 : 0,
    cycles: 0,
    consecutiveFailures: 0,
    unexpectedErrors: 0,
    cooldowns: 0,
    filterIndex: 0,
    filterSearches: 0,
    currentFilterId: null,
    bidSearchCounter: 0,
    page: 1,
    extraDelay: 0,
    notBefore: 0,
    waitKind: null,
    waitStartedAt: 0,
    transferDirty: true,
    fullStop: false,
    nextWatchCheck: 0,
    lastRelistAt: 0,
    lastClearAt: 0,
    referenceWaitSince: 0,
    relistPending: new Map(),
    tracked: new Map(),
    unwatchPrices: null,
    warned: new Set(),
  };
  run = ctx;
  watchFutbinPrices(ctx);
  resetStats();
  updateState({
    status: STATUS.STARTING,
    detail: "",
    startedAt: Date.now(),
    stoppedAt: 0,
    nextSearchAt: 0,
    pauseUntil: 0,
    coins: getCoins(),
  });
  if (settings.timing.keepAlive) {
    startKeepAlive();
  }
  const filters = runnableFilters().filter(filterHasTarget);
  log.info(
    t("engine.start.started", {
      filters:
        filters.length > 1 ? t("engine.start.rotation", { count: filters.length }) : describeFilter(filters[0]),
      wait: settings.timing.wait,
    }) +
      (ctx.pauseAfter ? t("engine.start.pauseEvery", { count: ctx.pauseAfter }) : "") +
      (ctx.stopAt ? t("engine.start.stopIn", { duration: formatDuration(ctx.stopAt - Date.now()) }) : "")
  );
  mainLoop(ctx)
    .catch((e) => {
      log.error(t("engine.error.unexpected", { message: errorMessage(e) }));
      ctx.stopReason = ctx.stopReason || t("engine.stop.internalError");
      ctx.stopAlert = true;
    })
    .finally(() => finalize(ctx));
  return true;
};

export const stopBot = (reason = t("engine.stop.manual"), { alert = false, manual = false } = {}) => {
  const ctx = run;
  if (!ctx) {
    return;
  }
  if (ctx.stopping) {
    // Stop during post-stop listings: interrupt them.
    if (ctx.finalToken && !ctx.finalToken.cancelled) {
      ctx.finalToken.cancel();
      log.warn(t("engine.stop.finalListingsInterrupted"));
    }
    return;
  }
  ctx.stopping = true;
  ctx.stopReason = reason;
  ctx.stopAlert = alert;
  ctx.manualStop = manual;
  ctx.token.cancel();
  updateState({ status: STATUS.STOPPING, detail: reason, nextSearchAt: 0, pauseUntil: 0 });
};

export const pauseBot = () => {
  const ctx = run;
  if (!ctx || ctx.paused || ctx.stopping) {
    return;
  }
  ctx.paused = true;
  if (ctx.interrupt) {
    ctx.interrupt.cancel();
  }
  updateState({ status: STATUS.PAUSED, nextSearchAt: 0, pauseUntil: 0 });
  log.info(t("engine.pause.manual"));
};

export const resumeBot = () => {
  const ctx = run;
  if (!ctx || !ctx.paused || ctx.stopping) {
    return;
  }
  ctx.paused = false;
  if (ctx.interrupt) {
    ctx.interrupt.cancel();
  }
  updateState({ status: STATUS.RUNNING });
  log.info(
    ctx.notBefore > Date.now()
      ? t("engine.resume.withWait", { seconds: Math.ceil((ctx.notBefore - Date.now()) / 1000) })
      : t("engine.resume.now")
  );
};

const finalize = async (ctx) => {
  if (run !== ctx) {
    return;
  }
  stopKeepAlive();
  releaseTracking(ctx);
  // Cards bought just before stopping are still processed (unless a blocking error occurs). The bot
  // stays "stopping" meanwhile: no new run can start in parallel.
  if (ctx.sellQueue.length && !ctx.stopAlert && sessionAlive()) {
    log.info(t("engine.finalize.processing", { count: ctx.sellQueue.length }));
    const detached = Object.assign({}, ctx, {
      token: createCancelToken(),
      notBefore: 0,
      waitKind: null,
      finalizing: true,
      halted: "",
    });
    ctx.finalToken = detached.token;
    updateState({ status: STATUS.STOPPING, detail: t("engine.finalize.detail") });
    await processSellQueue(detached).catch((e) =>
      log.error(t("engine.finalize.saleError", { message: errorMessage(e) }))
    );
    if (detached.halted) {
      ctx.stopAlert = true;
      ctx.stopReason = t("engine.stop.then", {
        reason: ctx.stopReason || t("engine.stop.generic"),
        next: detached.halted,
      });
    }
  }
  if (ctx.sellQueue.length) {
    log.warn(t("engine.finalize.leftUnassigned", { count: ctx.sellQueue.length }));
  }
  run = null;
  const reason = ctx.stopReason || t("engine.stop.generic");
  const stats = getState().stats;
  updateState({
    status: STATUS.STOPPED,
    detail: reason,
    stoppedAt: Date.now(),
    nextSearchAt: 0,
    pauseUntil: 0,
  });
  const summary = t("engine.stop.summary", {
    searches: stats.searches,
    won: stats.won,
    spent: formatCoins(stats.spent),
  });
  if (ctx.stopAlert) {
    log.error(t("engine.stop.stopped", { reason, summary }));
  } else {
    log.info(t("engine.stop.stopped", { reason, summary }));
  }
  if (ctx.manualStop && !ctx.stopAlert) {
    sound("stop");
  } else {
    notifyEvent(ctx.stopAlert ? "alert" : "stop", t("engine.notify.stopped", { reason, summary }), {
      toast: true,
      negative: ctx.stopAlert,
    });
  }
};

// Stop requested by an error: during post-stop sales, only those sales are interrupted.
const haltRun = (ctx, reason, options = {}) => {
  if (ctx.finalizing) {
    if (!ctx.halted) {
      ctx.halted = reason;
      log.error(t("engine.stop.finalListingsHalted", { reason }));
    }
    ctx.token.cancel();
    return;
  }
  stopBot(reason, options);
};

// ---------------------------------------------------------------- main loop

const mainLoop = async (ctx) => {
  try {
    await initialSync(ctx);
  } catch (e) {
    log.warn(t("engine.sync.incomplete", { message: errorMessage(e) }));
  }
  if (ctx.token.cancelled) {
    return;
  }
  if (!ctx.paused) {
    updateState({ status: STATUS.RUNNING });
  }
  while (!ctx.token.cancelled) {
    // An unexpected error does not kill the bot: 3 in a row stop it.
    try {
      const searched = await loopStep(ctx);
      if (searched) {
        ctx.unexpectedErrors = 0;
      }
    } catch (e) {
      ctx.unexpectedErrors += 1;
      log.error(t("engine.error.cycle", { count: ctx.unexpectedErrors, message: errorMessage(e) }));
      if (ctx.unexpectedErrors >= 3) {
        stopBot(t("engine.stop.repeatedErrors"), { alert: true });
      } else {
        setNotBefore(ctx, Date.now() + 3000, "wait");
      }
    }
  }
};

// One loop step. Returns true if a search happened.
const loopStep = async (ctx) => {
  if (ctx.paused) {
    await idle(ctx, 1000);
    return false;
  }
  if (ctx.notBefore > Date.now()) {
    await waitForNextSlot(ctx);
    return false;
  }
  const settings = getSettings();
  const stopReason = checkStopConditions(ctx, settings);
  if (stopReason) {
    stopBot(stopReason);
    return false;
  }
  if (!sessionAlive()) {
    stopBot(t("engine.stop.sessionLost"), { alert: true });
    return false;
  }
  if (ctx.pauseAfter > 0 && ctx.searchesSincePause >= ctx.pauseAfter) {
    await startScheduledPause(ctx, settings);
    return false;
  }
  const pick = nextFilter(ctx, settings);
  if (!pick) {
    handleNoFilter(ctx, settings);
    return false;
  }
  ctx.referenceWaitSince = 0;
  const cycleStart = Date.now();
  await snipeCycle(ctx, pick.filter, pick.maxBuy, settings);
  if (!ctx.token.cancelled) {
    await maintenance(ctx);
  }
  if (!ctx.token.cancelled) {
    setNotBefore(ctx, Date.now() + nextWait(ctx, cycleStart), "wait");
  }
  return true;
};

const waitForNextSlot = async (ctx) => {
  const kind = ctx.waitKind || "wait";
  const status =
    kind === "cooldown" ? STATUS.COOLDOWN : kind === "auto-pause" ? STATUS.AUTO_PAUSE : STATUS.RUNNING;
  const target = ctx.notBefore;
  updateState({
    status,
    nextSearchAt: target,
    waitStartedAt: ctx.waitStartedAt || Date.now(),
    pauseUntil: kind === "wait" ? 0 : target,
  });
  const planned = target - Date.now();
  const from = Date.now();
  const completed = await idle(ctx, planned);
  if (!completed) {
    return;
  }
  const overshoot = Date.now() - from - planned;
  if (kind === "wait" && overshoot > 20000 && !ctx.warned.has("throttle")) {
    ctx.warned.add("throttle");
    log.warn(
      t("engine.warn.throttled")
    );
  }
  if (kind === "cooldown") {
    log.info(t("engine.cooldown.ended"));
  }
  ctx.waitKind = null;
  updateState({ status: STATUS.RUNNING, nextSearchAt: 0, pauseUntil: 0 });
};

const checkStopConditions = (ctx, settings) => {
  if (ctx.stopAt && Date.now() >= ctx.stopAt) {
    return t("engine.stop.maxDuration");
  }
  const maxBuys = toInt(settings.buy.stopAfterPurchases);
  if (purchaseLimitReached(settings)) {
    return t("engine.stop.purchaseGoal", { count: maxBuys });
  }
  if (ctx.fullStop && settings.transfer.stopWhenFull) {
    return t("engine.stop.pilesFull");
  }
  return null;
};

const startScheduledPause = async (ctx, settings) => {
  const seconds = pickSeconds(settings.timing.pauseFor, "S");
  const done = ctx.searchesSincePause;
  ctx.searchesSincePause = 0;
  ctx.pauseAfter = pickInt(settings.timing.pauseEvery);
  if (!(seconds > 0)) {
    return;
  }
  const until = Date.now() + seconds * 1000;
  setNotBefore(ctx, until, "auto-pause");
  if (!ctx.paused) {
    updateState({ status: STATUS.AUTO_PAUSE, pauseUntil: until, nextSearchAt: until, waitStartedAt: Date.now() });
  }
  log.info(t("engine.pause.auto", { seconds: Math.round(seconds), count: done }));
  // Use the pause for reselling and the Transfer List.
  await maintenance(ctx, { force: true });
};

// Filters that are actually usable (target + price), rotated if enabled.
const nextFilter = (ctx, settings) => {
  const usable = [];
  runnableFilters()
    .filter(filterHasTarget)
    .forEach((filter) => {
      if (filter.priceMode === "futbin") {
        trackHot(ctx, futbinKeyForFilter(filter), futbinHint(filter));
      }
      const maxBuy = effectiveMaxBuy(filter);
      const bidOn = settings.bid.enabled && toInt(filter.maxBid) > 0;
      if (maxBuy || bidOn) {
        usable.push({ filter, maxBuy });
      }
    });
  if (!usable.length) {
    return null;
  }
  const rotation = getRotation();
  if (usable.length > 1 && rotation.enabled) {
    const every = Math.max(1, toInt(rotation.every) || 1);
    if (ctx.filterSearches >= every) {
      ctx.filterSearches = 0;
      if (rotation.random) {
        const choices = usable.map((_, index) => index).filter((i) => i !== ctx.filterIndex % usable.length);
        ctx.filterIndex = choices[Math.floor(Math.random() * choices.length)] || 0;
      } else {
        ctx.filterIndex += 1;
      }
    }
  } else {
    ctx.filterIndex = 0;
  }
  const pick = usable[ctx.filterIndex % usable.length];
  if (pick.filter.id !== ctx.currentFilterId) {
    if (ctx.currentFilterId) {
      log.info(t("engine.filter.next", { name: pick.filter.name, description: describeFilter(pick.filter) }));
    }
    ctx.currentFilterId = pick.filter.id;
    ctx.page = 1;
    updateState({ filterName: pick.filter.name });
  }
  return pick;
};

const handleNoFilter = (ctx, settings) => {
  const waiting = runnableFilters()
    .filter(filterHasTarget)
    .some((filter) => referencePending(filter));
  if (!waiting) {
    stopBot(t("engine.stop.noUsableFilter"));
    return;
  }
  const now = Date.now();
  if (!ctx.referenceWaitSince) {
    ctx.referenceWaitSince = now;
    log.info(t("engine.price.waitingForMaxBuy"));
  } else if (now - ctx.referenceWaitSince > REFERENCE_WAIT_MAX) {
    stopBot(t("engine.stop.futbinUnavailable"), { alert: true });
    return;
  }
  setNotBefore(ctx, now + 5000, "wait");
};

const nextWait = (ctx, cycleStart) => {
  const timing = getSettings().timing;
  const base = (pickSeconds(timing.wait, "S") || 5) * 1000;
  const extra = ctx.extraDelay || 0;
  ctx.extraDelay = 0;
  let target = cycleStart + base + extra;
  const perMinute = toInt(timing.maxPerMinute);
  if (perMinute > 0) {
    target = Math.max(target, cycleStart + 60000 / perMinute);
  }
  return Math.max(100, target - Date.now());
};

// ------------------------------------------------------------------- snipe

const snipeCycle = async (ctx, filter, maxBuy, settings) => {
  const bidOn = settings.bid.enabled && toInt(filter.maxBid) > 0;
  // With a max buy price, EA only returns listings under that price, so bids
  // go through a dedicated search (every N searches).
  let bidSearch = false;
  if (bidOn && !maxBuy) {
    bidSearch = true;
  } else if (bidOn) {
    ctx.bidSearchCounter += 1;
    bidSearch = ctx.bidSearchCounter % Math.max(2, toInt(settings.bid.searchEvery) || 3) === 0;
  }
  const searchMaxBuy = bidSearch ? 0 : maxBuy;
  const bust = cacheBusterPrices(settings.timing.cacheBuster, ctx.searchCount, {
    maxBuy: searchMaxBuy,
    minBuy: toInt(filter.minBuy),
    maxBid: bidSearch ? toInt(filter.maxBid) : 0,
    cap: settings.timing.cacheBusterMax,
  });
  const criteria = buildCriteria(filter, {
    minBuy: bust.minBuy,
    maxBuy: searchMaxBuy,
    maxBid: bidSearch ? toInt(filter.maxBid) : bust.maxBid,
    minBid: bust.minBid,
  });
  const page = bidSearch ? 1 : ctx.page || 1;
  const result = await market.searchMarket(criteria, page);
  ctx.searchCount += 1;
  ctx.searchesSincePause += 1;
  ctx.filterSearches += 1;
  recordSearch(result.latency);
  if (ctx.token.cancelled) {
    return;
  }
  if (!result.ok) {
    await handleFailure(ctx, result.error || classify(result.response), "search");
    return;
  }
  ctx.consecutiveFailures = 0;
  const items = result.items;
  bumpStat("results", items.length);
  if (!bidSearch) {
    const maxPages = Math.max(1, Math.min(10, toInt(settings.timing.maxPages) || 1));
    ctx.page = items.length > market.marketPageSize() && page < maxPages ? page + 1 : 1;
  }

  const analysis = analyzeResults(ctx, items, filter, maxBuy, settings, bidOn);
  logSearch(filter, items.length, analysis, result.latency, page, maxBuy, bidSearch);
  bumpStat("deals", analysis.deals.length);

  const maxResults = toInt(settings.buy.maxResults);
  if (!bidSearch && maxResults && items.length > maxResults) {
    log.warn(
      t("engine.search.tooManyResults", { count: items.length, limit: maxResults })
    );
    return;
  }
  // FUTBIN mode: a full page of listings under the max price means that price is above the
  // market (wrong or stale FUTBIN price, percentage too high): no purchase and the price is reread.
  if (!bidSearch && filter.priceMode === "futbin" && items.length >= market.marketPageSize()) {
    const warnKey = `futbin-full:${filter.id}:${maxBuy}`;
    if (!ctx.warned.has(warnKey)) {
      ctx.warned.add(warnKey);
      log.warn(
        t("engine.search.futbinAboveMarket", { name: filter.name, count: items.length, maxBuy: formatCoins(maxBuy) })
      );
      requestPrice(futbinKeyForFilter(filter), futbinHint(filter));
    }
    return;
  }

  let attempts = 0;
  const perSearch = Math.max(1, toInt(settings.buy.maxPerSearch) || 1);
  for (const deal of analysis.deals) {
    if (attempts >= perSearch || blocked(ctx) || purchaseLimitReached(settings)) {
      break;
    }
    const coins = getCoins();
    const reserve = toInt(settings.buy.coinsReserve);
    if (coins && coins - reserve < deal.bin) {
      if (!ctx.warned.has(`coins:${deal.tradeId}`)) {
        ctx.warned.add(`coins:${deal.tradeId}`);
        log.warn(
          t("engine.buy.notEnoughCoins", {
            name: market.nameOf(deal.item),
            price: formatCoins(deal.bin),
            coins: formatCoins(coins),
            reserve: reserve ? t("engine.buy.reserve", { reserve: formatCoins(reserve) }) : "",
          })
        );
      }
      continue;
    }
    attempts += 1;
    const outcome = await attemptBuy(ctx, deal, filter);
    if (outcome === "fatal") {
      return;
    }
  }
  if (bidOn && analysis.auctions.length && !blocked(ctx) && !purchaseLimitReached(settings)) {
    attempts += await placeBids(ctx, analysis.auctions, filter, settings);
  }
  if (attempts) {
    ctx.extraDelay = pickSeconds(settings.timing.afterBuy, "S") * 1000;
  }
};

const analyzeResults = (ctx, items, filter, maxBuy, settings, bidOn) => {
  const deals = [];
  const auctions = [];
  const counts = { own: 0, seen: 0, other: 0, rating: 0, gk: 0, above: 0 };
  items.forEach((item) => {
    const auction = market.auctionOf(item);
    const tradeId = auction ? String(auction.tradeId || "") : "";
    if (!auction || !tradeId || tradeId === "0") {
      return;
    }
    if (auction.tradeOwner) {
      counts.own += 1;
      return;
    }
    if (!matchesTarget(item, filter)) {
      counts.other += 1;
      return;
    }
    const rating = market.ratingOf(item);
    if ((filter.minRating && rating < filter.minRating) || (filter.maxRating && rating > filter.maxRating)) {
      counts.rating += 1;
      return;
    }
    if (settings.buy.skipGk && market.isGoalkeeper(item)) {
      counts.gk += 1;
      return;
    }
    const bin = toInt(auction.buyNowPrice);
    if (bin && maxBuy && bin <= maxBuy) {
      if (ctx.attempted.has(tradeId)) {
        counts.seen += 1;
        return;
      }
      deals.push({ item, tradeId, bin, rating, expires: Number(auction.expires) || 0 });
      return;
    }
    counts.above += 1;
    if (bidOn) {
      auctions.push({ item, tradeId, auction, rating, bin });
    }
  });
  // Cheapest first; at equal price, the newest listing (more likely to still be available).
  deals.sort((a, b) => a.bin - b.bin || b.expires - a.expires);
  return { deals, auctions, counts };
};

const logSearch = (filter, total, analysis, latency, page, maxBuy, bidSearch) => {
  const { deals, counts } = analysis;
  const extras = [];
  if (counts.own) {
    extras.push(t("engine.search.own", { count: counts.own }));
  }
  if (counts.seen) {
    extras.push(t("engine.search.seen", { count: counts.seen }));
  }
  if (counts.other) {
    extras.push(t("engine.search.other", { count: counts.other }));
  }
  if (counts.rating) {
    extras.push(t("engine.search.rating", { count: counts.rating }));
  }
  if (counts.gk) {
    extras.push(t("engine.search.gk", { count: counts.gk }));
  }
  const text =
    `${filter.name}${bidSearch ? t("engine.search.bidsTag") : ""} · ` +
    t(total === 1 ? "engine.search.results.one" : "engine.search.results.many", { count: total }) +
    (page > 1 ? t("engine.search.page", { page }) : "") +
    (deals.length
      ? " · " +
        t(deals.length === 1 ? "engine.search.deals.one" : "engine.search.deals.many", {
          count: deals.length,
          maxBuy: formatCoins(maxBuy),
        })
      : "") +
    (extras.length ? ` · ${extras.join(", ")}` : "") +
    ` · ${Math.round(latency)} ms`;
  log.search(text);
};

const attemptBuy = async (ctx, deal, filter) => {
  const name = market.nameOf(deal.item);
  bumpStat("attempts");
  const result = await market.bidOnItem(deal.item, deal.bin);
  if (result.ok) {
    ctx.attempted.add(deal.tradeId);
    bumpStat("won");
    bumpStat("spent", deal.bin);
    updateState({ coins: getCoins() });
    log.buy(
      t("engine.buy.bought", {
        name,
        rating: deal.rating,
        price: formatCoins(deal.bin),
        latency: Math.round(result.latency),
      }),
      { definitionId: deal.item.definitionId }
    );
    recordTransaction({ type: t("engine.transaction.buy"), name, rating: deal.rating, price: deal.bin, filter: filter.name });
    notifyEvent("buy", t("engine.notify.bought", { name, rating: deal.rating, price: formatCoins(deal.bin) }));
    queueSale(ctx, { item: deal.item, buyPrice: deal.bin, filter, name, rating: deal.rating });
    return "won";
  }
  const error = result.error || classify(result.response);
  if (error.kind === KIND.GONE) {
    ctx.attempted.add(deal.tradeId);
    bumpStat("missed");
    log.warn(t("engine.buy.missed", { name, price: formatCoins(deal.bin), code: error.code }));
    recordTransaction({ type: t("engine.transaction.missed"), name, rating: deal.rating, price: deal.bin, filter: filter.name });
    notifyEvent("fail", t("engine.notify.missed", { name, rating: deal.rating, price: formatCoins(deal.bin) }));
    return trackStopCode(ctx, error) ? "fatal" : "missed";
  }
  // Transient error: only one retry allowed on this listing.
  const tries = (ctx.retries.get(deal.tradeId) || 0) + 1;
  ctx.retries.set(deal.tradeId, tries);
  if (tries >= 2 || isFatal(error.kind)) {
    ctx.attempted.add(deal.tradeId);
  }
  await handleFailure(ctx, error, "buy", name);
  return ctx.token.cancelled ? "fatal" : "error";
};

// -------------------------------------------------------------------- bids

const placeBids = async (ctx, auctions, filter, settings) => {
  const maxBid = floorPrice(filter.maxBid);
  const window = parseRange(settings.bid.expiresWithin, "M");
  const windowSeconds = window ? window.max : 300;
  const perSearch = Math.max(1, toInt(settings.bid.maxPerSearch) || 1);
  const maxActive = Math.max(1, toInt(settings.bid.maxActive) || 10);
  let placed = 0;
  const sorted = auctions
    .filter((entry) => {
      const expires = Number(entry.auction.expires) || 0;
      return expires > 0 && expires <= windowSeconds;
    })
    .sort((a, b) => (Number(a.auction.expires) || 0) - (Number(b.auction.expires) || 0));
  for (const entry of sorted) {
    if (placed >= perSearch || ctx.bids.size >= maxActive || blocked(ctx)) {
      break;
    }
    if (ctx.userWatched.has(entry.tradeId) || ctx.bids.has(entry.tradeId)) {
      continue;
    }
    const auction = entry.auction;
    const current = toInt(auction.currentBid);
    const price = settings.bid.exact
      ? maxBid
      : current
      ? priceAbove(current)
      : Math.max(150, roundPrice(auction.startingBid));
    if (!price || price > maxBid || (entry.bin && price >= entry.bin) || (current && price <= current)) {
      continue;
    }
    const coins = getCoins();
    if (coins && coins - toInt(settings.buy.coinsReserve) < price) {
      continue;
    }
    placed += 1;
    const name = market.nameOf(entry.item);
    const result = await market.bidOnItem(entry.item, price);
    if (result.ok) {
      bumpStat("bids");
      ctx.bids.set(entry.tradeId, {
        item: entry.item,
        price,
        filter,
        name,
        rating: entry.rating,
        endsAt: Date.now() + (Number(auction.expires) || 0) * 1000,
      });
      log.info(
        t("engine.bid.placed", {
          name,
          rating: entry.rating,
          price: formatCoins(price),
          seconds: Math.round(Number(auction.expires) || 0),
        })
      );
      continue;
    }
    const error = result.error || classify(result.response);
    if (error.kind === KIND.GONE) {
      log.warn(t("engine.bid.rejected", { name }));
      if (trackStopCode(ctx, error)) {
        break;
      }
    } else {
      await handleFailure(ctx, error, "bid", name);
    }
  }
  return placed;
};

const checkBids = async (ctx, force) => {
  if (!ctx.bids.size) {
    return;
  }
  const now = Date.now();
  const dueEnd = Array.from(ctx.bids.values()).some((bid) => bid.endsAt && bid.endsAt <= now);
  if (!force && !dueEnd && now < ctx.nextWatchCheck) {
    return;
  }
  ctx.nextWatchCheck = now + 20000;
  const settings = getSettings();
  const result = await market.fetchWatchList();
  if (!result.ok) {
    await handleFailure(ctx, result.error, "watch");
    return;
  }
  const tracked = [];
  const seen = new Set();
  result.items.forEach((item) => {
    const auction = market.auctionOf(item);
    const tradeId = auction ? String(auction.tradeId) : "";
    if (tradeId && ctx.bids.has(tradeId) && !seen.has(tradeId)) {
      seen.add(tradeId);
      tracked.push(item);
    }
  });
  const active = tracked.filter((item) => safeCall(market.auctionOf(item), "isActiveTrade"));
  if (active.length) {
    const refreshed = await market.refreshAuctions(active);
    if (!refreshed.ok) {
      await handleFailure(ctx, refreshed.error, "watch");
      if (blocked(ctx)) {
        return;
      }
    }
  }
  const release = [];
  for (const item of tracked) {
    if (blocked(ctx)) {
      break;
    }
    const auction = market.auctionOf(item);
    const tradeId = String(auction.tradeId);
    const bid = ctx.bids.get(tradeId);
    if (!bid) {
      continue;
    }
    if (safeCall(auction, "isWon")) {
      ctx.bids.delete(tradeId);
      const price = toInt(auction.currentBid) || bid.price;
      bumpStat("bidsWon");
      bumpStat("won");
      bumpStat("spent", price);
      log.buy(t("engine.bid.won", { name: bid.name, rating: bid.rating, price: formatCoins(price) }));
      recordTransaction({
        type: t("engine.transaction.bidWon"),
        name: bid.name,
        rating: bid.rating,
        price,
        filter: bid.filter.name,
      });
      notifyEvent("buy", t("engine.notify.bidWon", { name: bid.name, price: formatCoins(price) }));
      queueSale(ctx, { item, buyPrice: price, filter: bid.filter, name: bid.name, rating: bid.rating });
    } else if (
      safeCall(auction, "isExpired") ||
      (safeCall(auction, "isClosedTrade") && !safeCall(auction, "isWon"))
    ) {
      ctx.bids.delete(tradeId);
      release.push(item);
      log.info(t("engine.bid.lost", { name: bid.name }));
    } else if (safeCall(auction, "isOutbid")) {
      const next = priceAbove(toInt(auction.currentBid));
      const maxBid = floorPrice(bid.filter.maxBid);
      const coins = getCoins();
      const affordable = !coins || coins - toInt(settings.buy.coinsReserve) >= next;
      if (settings.bid.rebid && next <= maxBid && affordable) {
        const rebid = await market.bidOnItem(item, next);
        if (rebid.ok) {
          bid.price = next;
          bumpStat("bids");
          log.info(t("engine.bid.rebid", { name: bid.name, price: formatCoins(next) }));
        } else if (rebid.error && rebid.error.kind !== KIND.GONE) {
          await handleFailure(ctx, rebid.error, "bid", bid.name);
        }
      } else {
        ctx.bids.delete(tradeId);
        release.push(item);
        log.info(t("engine.bid.outbidAboveMax", { name: bid.name, maxBid: formatCoins(maxBid) }));
      }
    }
  }
  Array.from(ctx.bids.keys()).forEach((tradeId) => {
    const bid = ctx.bids.get(tradeId);
    if (!seen.has(tradeId) && bid && bid.endsAt < now - 60000) {
      ctx.bids.delete(tradeId);
    }
  });
  if (release.length && settings.bid.clearLost && !blocked(ctx)) {
    const cleared = await market.untargetItems(release);
    if (!cleared.ok) {
      await handleFailure(ctx, cleared.error, "watch");
    }
  }
};

// ----------------------------------------------------------------- resale

const sellKey = (job) => Number(job.item && job.item.definitionId) || 0;

// Requests the FUTBIN price of the bought version (unless it is less than a minute old).
const requestSellPrice = (job) => {
  const key = sellKey(job);
  if (!key || currentPrice(key, 60 * 1000, "sell")) {
    return Promise.resolve(null);
  }
  job.requestedAt = Date.now();
  return requestPrice(key, { name: job.name, rating: job.rating });
};

const queueSale = (ctx, job) => {
  const entry = Object.assign({ deferrals: 0, requestedAt: 0, queuedAt: Date.now() }, job);
  ctx.sellQueue.push(entry);
  // The FUTBIN price is requested right away, in the background, while the cycle finishes.
  const sell = getSettings().sell;
  if (sell.mode === "list" && sellModeFor(entry.filter, sell) === "futbin") {
    requestSellPrice(entry);
  }
};

const moveToTransferList = async (ctx, job) => {
  if (market.isPileFull("TRANSFER")) {
    log.warn(t("engine.sell.keptUnassigned", { name: job.name }));
    ctx.fullStop = true;
    return;
  }
  const result = await market.moveItem(job.item, "TRANSFER");
  if (result.ok) {
    ctx.transferDirty = true;
    log.info(t("engine.sell.movedToTransfer", { name: job.name }));
    return;
  }
  log.warn(t("engine.sell.moveFailed", { name: job.name, error: result.error.label }));
  if (result.error.kind === KIND.FULL) {
    ctx.fullStop = true;
  } else {
    await handleFailure(ctx, result.error, "move", job.name);
  }
};

// Resale price: fixed (filter or Sell tab) or % of the bought version's FUTBIN price.
// Returns null until the FUTBIN price arrives (the sale is deferred to the next cycle).
const sellPriceFor = async (ctx, job, sell) => {
  if (sellModeFor(job.filter, sell) !== "futbin") {
    const price = fixedSellPriceFor(job.filter, sell);
    return { price, reason: price ? "" : t("engine.sell.noPrice") };
  }
  const key = sellKey(job);
  let reference = key ? currentPrice(key, SELL_PRICE_MAX_AGE, "sell") : 0;
  if (!reference && key && ctx.finalizing) {
    // After stopping there is no next cycle: wait for the FUTBIN response (20 s max).
    await withTimeout(requestSellPrice(job), 20000);
    reference = currentPrice(key, SELL_PRICE_MAX_AGE, "sell");
  }
  if (reference) {
    const { price, percent } = futbinSellPrice(reference, sellPercentFor(job.filter, sell));
    log.info(
      t("engine.sell.futbinPrice", {
        name: job.name,
        reference: formatCoins(reference),
        percent: Math.round(percent),
        price: formatCoins(price),
      })
    );
    return { price, reason: "" };
  }
  const waiting = job.deferrals < MAX_SELL_DEFERRALS || Date.now() - (job.queuedAt || 0) < SELL_PRICE_WAIT;
  if (key && !ctx.finalizing && waiting) {
    if (!job.requestedAt || Date.now() - job.requestedAt > 30000) {
      requestSellPrice(job);
    }
    return null;
  }
  return { price: 0, reason: t("engine.sell.futbinUnavailable") };
};

// Returns "deferred" if the sale must be retried on the next cycle.
const sellJob = async (ctx, job) => {
  const sell = getSettings().sell;
  if (sell.mode === "none") {
    return "done";
  }
  if (sell.maxRating && job.rating > toInt(sell.maxRating)) {
    log.info(t("engine.sell.keptRating", { name: job.name, rating: job.rating }));
    return "done";
  }
  if (sell.mode === "transfer") {
    await moveToTransferList(ctx, job);
    return "done";
  }
  const plan = await sellPriceFor(ctx, job, sell);
  if (plan === null) {
    return "deferred";
  }
  if (!plan.price) {
    log.warn(t("engine.sell.sentUnlisted", { name: job.name, reason: plan.reason }));
    await moveToTransferList(ctx, job);
    return "done";
  }
  if (market.isPileFull("TRANSFER")) {
    log.warn(t("engine.sell.keptUnassigned", { name: job.name }));
    ctx.fullStop = true;
    return "done";
  }
  const listing = await prepareListing(job.item, plan.price);
  const price = listing.buyNow;
  const profit = profitFor(job.buyPrice, price);
  const minProfit = toInt(sell.minProfit);
  if (minProfit && profit < minProfit) {
    log.warn(
      t("engine.sell.profitTooLow", { name: job.name, profit: formatCoins(profit), minProfit: formatCoins(minProfit) })
    );
    await moveToTransferList(ctx, job);
    return "done";
  }
  const start = listing.start;
  const duration = durationSeconds(sell.duration);
  const result = await market.listOnMarket(job.item, start, price, duration);
  if (result.ok) {
    ctx.transferDirty = true;
    bumpStat("listed");
    bumpStat("estProfit", profit);
    log.success(
      t("engine.sell.listed", {
        name: job.name,
        price: formatCoins(price),
        start: formatCoins(start),
        profit: formatCoins(profit),
      })
    );
    recordTransaction({
      type: t("engine.transaction.listed"),
      name: job.name,
      rating: job.rating,
      price,
      profit,
      filter: job.filter.name,
    });
    notifyEvent(
      "list",
      t("engine.notify.listed", { name: job.name, price: formatCoins(price), profit: formatCoins(profit) })
    );
    return "done";
  }
  const error = result.error || classify(result.response);
  log.error(t("engine.sell.listFailed", { name: job.name, error: error.label }));
  if (error.kind === KIND.FULL) {
    ctx.fullStop = true;
  } else {
    await handleFailure(ctx, error, "list", job.name, { quiet: true });
  }
  return "done";
};

const processSellQueue = async (ctx) => {
  const jobs = ctx.sellQueue.splice(0);
  const later = [];
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    if (ctx.token.cancelled || inCooldown(ctx)) {
      later.push(job);
      continue;
    }
    let outcome = "done";
    try {
      outcome = await sellJob(ctx, job);
      if (outcome === "deferred") {
        job.deferrals += 1;
        later.push(job);
      }
    } catch (e) {
      log.error(t("engine.sell.resaleError", { name: job.name, message: errorMessage(e) }));
    }
    // Pause only between two EA actions (a deferred sale sent no request).
    if (outcome !== "deferred" && index < jobs.length - 1 && !ctx.token.cancelled) {
      await sleep(randomBetween(700, 1500), ctx.token);
    }
  }
  ctx.sellQueue.push(...later);
};

// ----------------------------------------------------------- transfer list

const checkTransferList = async (ctx) => {
  const result = await market.fetchTransferList();
  if (!result.ok) {
    await handleFailure(ctx, result.error, "transfer", null, { quiet: true });
    return;
  }
  ctx.transferDirty = false;
  const summary = market.summarizeTransferList(result.items);
  const capacity = market.pileCapacity("TRANSFER");
  updateState({ transfer: Object.assign({ capacity }, summary), coins: getCoins() });
  const settings = getSettings().transfer;
  const now = Date.now();
  if (settings.relistExpired && summary.unsold > 0 && now - ctx.lastRelistAt > RELIST_MIN_GAP && !blocked(ctx)) {
    ctx.lastRelistAt = now;
    if (settings.relistMode === "futbin") {
      await relistAtFutbin(ctx, result.items);
    } else {
      await relistSamePrice(ctx, summary.unsold);
    }
  }
  const clearAt = toInt(settings.clearSoldAt);
  if (clearAt > 0 && summary.sold >= clearAt && now - ctx.lastClearAt > CLEAR_MIN_GAP && !blocked(ctx)) {
    ctx.lastClearAt = now;
    const cleared = await market.clearSold();
    if (cleared.ok) {
      const earned = afterTax(summary.soldValue);
      bumpStat("soldCount", summary.sold);
      bumpStat("soldValue", earned);
      ctx.transferDirty = true;
      log.success(t("engine.transfer.soldCleared", { count: summary.sold, earned: formatCoins(earned) }));
      await market.refreshCoins();
      updateState({ coins: getCoins() });
    } else {
      await handleFailure(ctx, cleared.error, "transfer", null, { quiet: true });
    }
  }
  if (capacity && summary.total >= capacity && !ctx.warned.has("transfer-full")) {
    ctx.warned.add("transfer-full");
    log.warn(t("engine.transfer.full", { total: summary.total, capacity }));
  }
};

const relistSamePrice = async (ctx, count) => {
  const relist = await market.relistExpired();
  if (relist.ok) {
    ctx.transferDirty = true;
    ctx.relistPending.clear();
    log.success(t("engine.transfer.relistedSame", { count }));
  } else {
    log.warn(t("engine.transfer.relistFailed", { error: relist.error.label }));
    await handleFailure(ctx, relist.error, "transfer", null, { quiet: true });
  }
};

// Relists unsold cards at the current FUTBIN price (% from the Sell tab), 5 cards per pass.
// A card without a FUTBIN price is retried; after 3 min without a price, it is relisted at the same price.
const relistAtFutbin = async (ctx, items) => {
  const sell = getSettings().sell;
  const now = Date.now();
  const ready = [];
  const pending = [];
  items
    .filter((item) => safeCall(market.auctionOf(item), "isExpired"))
    .forEach((item) => {
      const key = Number(item.definitionId) || 0;
      const reference = key ? currentPrice(key, SELL_PRICE_MAX_AGE, "sell") : 0;
      if (reference) {
        ready.push({ item, reference });
      } else {
        pending.push(item);
      }
    });
  pending.forEach((item) => {
    const id = String(item.id);
    if (!ctx.relistPending.has(id)) {
      ctx.relistPending.set(id, now);
    }
    requestPrice(Number(item.definitionId), { name: market.nameOf(item), rating: market.ratingOf(item) });
  });
  const duration = durationSeconds(sell.duration);
  let listed = 0;
  for (const entry of ready.slice(0, RELIST_BATCH)) {
    if (blocked(ctx)) {
      break;
    }
    const name = market.nameOf(entry.item);
    const { price } = futbinSellPrice(entry.reference, sell.futbinPercent);
    const listing = await prepareListing(entry.item, price);
    const res = await market.listOnMarket(entry.item, listing.start, listing.buyNow, duration);
    if (res.ok) {
      listed += 1;
      ctx.relistPending.delete(String(entry.item.id));
      log.success(
        t("engine.transfer.relisted", {
          name,
          price: formatCoins(listing.buyNow),
          reference: formatCoins(entry.reference),
        })
      );
    } else {
      log.warn(t("engine.transfer.relistItemFailed", { name, error: res.error.label }));
      await handleFailure(ctx, res.error, "list", name, { quiet: true });
      break;
    }
    await sleep(randomBetween(700, 1500), ctx.token);
  }
  if (listed) {
    ctx.transferDirty = true;
  }
  const stale = pending.filter((item) => now - (ctx.relistPending.get(String(item.id)) || now) > RELIST_FALLBACK_AFTER);
  if (stale.length && ready.length <= RELIST_BATCH && !blocked(ctx)) {
    log.warn(t("engine.transfer.relistFallback", { count: stale.length }));
    await relistSamePrice(ctx, pending.length);
    return;
  }
  if (pending.length || ready.length > RELIST_BATCH) {
    // Next pass in ~90 s (on the next Transfer List check).
    ctx.lastRelistAt = Date.now() - RELIST_MIN_GAP + RELIST_RETRY;
  }
};

const maintenance = async (ctx, { force = false } = {}) => {
  ctx.cycles += 1;
  if (ctx.sellQueue.length) {
    await processSellQueue(ctx);
  }
  if (blocked(ctx)) {
    return;
  }
  await checkBids(ctx, force);
  if (blocked(ctx)) {
    return;
  }
  const every = Math.max(1, toInt(getSettings().transfer.checkEvery) || 8);
  if (force || ctx.transferDirty || ctx.cycles % every === 0) {
    await checkTransferList(ctx);
  }
  updateState({ coins: getCoins() });
};

const initialSync = async (ctx) => {
  const settings = getSettings();
  if (settings.bid.enabled) {
    const watched = await market.fetchWatchList();
    if (watched.ok) {
      watched.items.forEach((item) => {
        const auction = market.auctionOf(item);
        if (auction && auction.tradeId) {
          ctx.userWatched.add(String(auction.tradeId));
        }
      });
      if (ctx.userWatched.size) {
        log.info(t("engine.sync.watchedKept", { count: ctx.userWatched.size }));
      }
    } else {
      await handleFailure(ctx, watched.error, "watch", null, { quiet: true });
    }
  }
  if (ctx.token.cancelled) {
    return;
  }
  await checkTransferList(ctx);
  const futbinFilters = runnableFilters()
    .filter(filterHasTarget)
    .filter((filter) => filter.priceMode === "futbin" && futbinKeyForFilter(filter));
  if (!futbinFilters.length || ctx.token.cancelled) {
    return;
  }
  await withTimeout(
    Promise.all(
      futbinFilters.map((filter) => {
        const key = futbinKeyForFilter(filter);
        trackHot(ctx, key, futbinHint(filter));
        const ready = currentPrice(key, BUY_PRICE_MAX_AGE)
          ? Promise.resolve()
          : requestPrice(key, futbinHint(filter));
        return ready.then(() => {
          const price = currentPrice(key, BUY_PRICE_MAX_AGE, "buy");
          if (price) {
            const record = getPriceRecord(key);
            const age = record && record.updatedAgoSec != null ? Math.round(record.updatedAgoSec / 60) : null;
            log.info(
              t("engine.price.initial", {
                name: filter.name,
                price: formatCoins(price),
                maxBuy: formatCoins(effectiveMaxBuy(filter)),
                percent: filter.futbinPercent,
                cap: filter.maxBuy ? t("engine.price.cap", { cap: formatCoins(filter.maxBuy) }) : "",
              }) + (age != null ? t("engine.price.updatedAgo", { minutes: age }) : ".")
            );
          } else {
            const record = getPriceRecord(key);
            log.warn(
              t("engine.price.unavailable", {
                name: filter.name,
                detail: record && record.status === "miss" ? t("engine.price.notFoundOnFutbin") : "",
              })
            );
          }
        });
      })
    ),
    25000
  );
};

// ------------------------------------------------------------------ errors

// Custom stop codes (Timing tab). Returns true if the bot was stopped.
const trackStopCode = (ctx, error) => {
  const custom = parseCodeList(getSettings().errors.stopCodes);
  if (!error || !error.code || !custom.has(error.code)) {
    return false;
  }
  const count = (ctx.errorCounts.get(error.code) || 0) + 1;
  ctx.errorCounts.set(error.code, count);
  const limit = Math.max(1, toInt(getSettings().errors.maxConsecutiveFailures) || 3);
  if (count >= limit) {
    haltRun(ctx, t("engine.stop.errorCode", { code: error.code, count }), { alert: true });
    return true;
  }
  return false;
};

// Translation keys, resolved when the message is logged.
const LABELS = {
  buy: "engine.action.buy",
  bid: "engine.action.bid",
  list: "engine.action.list",
  move: "engine.action.move",
  watch: "engine.action.watch",
  transfer: "engine.action.transfer",
};

const handleFailure = async (ctx, error, where, subject, { quiet = false } = {}) => {
  if (!error || ctx.token.cancelled) {
    return;
  }
  bumpStat("errors");
  if (trackStopCode(ctx, error)) {
    return;
  }
  const prefix = subject ? `${subject} : ` : "";
  switch (error.kind) {
    case KIND.CAPTCHA:
      haltRun(ctx, t("engine.stop.captcha"), { alert: true });
      return;
    case KIND.AUTH:
      haltRun(ctx, t("engine.stop.sessionExpired"), { alert: true });
      return;
    case KIND.BANNED:
      haltRun(ctx, t("engine.stop.banned"), { alert: true });
      return;
    case KIND.LOCKED:
      haltRun(ctx, t("engine.stop.marketLocked"), { alert: true });
      return;
    case KIND.RATE:
    case KIND.BLOCKED:
      if (ctx.finalizing) {
        haltRun(ctx, `${error.label} (${error.code})`, { alert: true });
      } else {
        startCooldown(ctx, error);
      }
      return;
    case KIND.FULL:
      ctx.fullStop = true;
      log.warn(`${prefix}${error.label}.`);
      return;
    case KIND.FUNDS:
      log.warn(`${prefix}${t("engine.error.notEnoughCoins")}`);
      return;
    default:
      break;
  }
  if (where === "search") {
    ctx.consecutiveFailures += 1;
    const limit = Math.max(1, toInt(getSettings().errors.maxConsecutiveFailures) || 3);
    if (ctx.consecutiveFailures >= limit) {
      stopBot(t("engine.stop.searchFailures", { count: ctx.consecutiveFailures, error: error.label }), { alert: true });
    } else {
      log.warn(t("engine.search.failed", { error: error.label, count: ctx.consecutiveFailures, limit }));
    }
    return;
  }
  if (!quiet) {
    log.error(`${prefix}${t("engine.error.actionFailed", { action: LABELS[where] ? t(LABELS[where]) : where, error: error.label })}`);
  }
};

// Safety pause on 429 / 512 / 521: no request until it ends (even after Pause/Resume).
const startCooldown = (ctx, error) => {
  if (inCooldown(ctx)) {
    return;
  }
  ctx.cooldowns += 1;
  const settings = getSettings().errors;
  const maxCooldowns = Math.max(0, toInt(settings.maxCooldowns));
  if (ctx.cooldowns > maxCooldowns) {
    stopBot(t("engine.stop.rateLimited", { code: error.code }), { alert: true });
    return;
  }
  const seconds = pickSeconds(settings.cooldown, "M") || 300;
  const until = Date.now() + seconds * 1000;
  setNotBefore(ctx, until, "cooldown");
  log.warn(
    t("engine.cooldown.started", {
      error: error.label,
      code: error.code,
      duration: seconds >= 90 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds)} s`,
      count: ctx.cooldowns,
      max: maxCooldowns,
    })
  );
  notifyEvent("fail", t("engine.notify.cooldown", { error: error.label, code: error.code }));
  if (!ctx.paused) {
    updateState({ status: STATUS.COOLDOWN, pauseUntil: until, nextSearchAt: until, waitStartedAt: Date.now() });
  }
};

// ------------------------------------------------------------- test search

// A single search, without buying, to check a filter and see market prices.
export const previewSearch = async (filter) => {
  if (run) {
    return { ok: false, message: t("engine.preview.botRunning") };
  }
  if (!isAppReady() || !getUser()) {
    return { ok: false, message: t("engine.preview.notLoggedIn") };
  }
  const key = filter.priceMode === "futbin" ? futbinKeyForFilter(filter) : 0;
  if (key && !effectiveMaxBuy(filter)) {
    await withTimeout(requestPrice(key, futbinHint(filter)), 20000);
    if (!effectiveMaxBuy(filter)) {
      return { ok: false, message: t("engine.preview.futbinUnavailable") };
    }
  }
  const maxBuy = effectiveMaxBuy(filter);
  const criteria = buildCriteria(filter, { maxBuy });
  const result = await market.searchMarket(criteria, 1);
  if (!result.ok) {
    return { ok: false, message: t("engine.preview.rejected", { error: result.error.label, code: result.error.code }) };
  }
  const rows = result.items
    .map((item) => {
      const auction = market.auctionOf(item) || {};
      return {
        name: market.nameOf(item),
        rating: market.ratingOf(item),
        definitionId: Number(item.definitionId) || 0,
        bin: toInt(auction.buyNowPrice),
        bid: toInt(auction.currentBid) || toInt(auction.startingBid),
        expires: Number(auction.expires) || 0,
        own: !!auction.tradeOwner,
        match: matchesTarget(item, filter),
      };
    })
    .sort((a, b) => a.bin - b.bin);
  return { ok: true, rows, latency: result.latency, maxBuy, futbinPrice: key ? currentPrice(key, BUY_PRICE_MAX_AGE) : 0 };
};
