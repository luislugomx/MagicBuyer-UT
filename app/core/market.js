import { t } from "../i18n";
import { observe } from "./async";
import { classify } from "./errors";
import { itemService, pageGlobal, pile, repositories, services, toPageArray } from "./page";
import { bumpStat } from "./state";

// Wrappers around services.Item (FC 27): each call returns a Promise
// { ok, response, error } and counts the requests sent to EA.

const now = () =>
  typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();

const requireItemService = () => {
  const svc = itemService();
  if (!svc) {
    throw new Error(t("core.market.itemServiceMissing"));
  }
  return svc;
};

const call = async (label, factory, timeoutMs = 15000) => {
  let observable;
  try {
    observable = factory();
  } catch (e) {
    return { ok: false, response: null, error: { code: -1, kind: "other", label: t("core.market.callFailed", { label, reason: e.message || e }) } };
  }
  bumpStat("requests");
  const response = await observe(observable, timeoutMs);
  const ok = !!(response && response.success);
  return { ok, response, error: ok ? null : classify(response) };
};

export const auctionOf = (item) => {
  if (!item) {
    return null;
  }
  try {
    if (typeof item.getAuctionData === "function") {
      return item.getAuctionData() || item._auction || null;
    }
  } catch (e) {}
  return item._auction || null;
};

export const baseIdOf = (item) => (Number(item && item.definitionId) || 0) & 0xffffff;

export const ratingOf = (item) => {
  try {
    return Number(item.rating) || 0;
  } catch (e) {
    return 0;
  }
};

export const nameOf = (item) => {
  try {
    const data =
      (typeof item.getStaticData === "function" && item.getStaticData()) ||
      item._staticData ||
      {};
    const known = data.knownAs && data.knownAs !== "---" ? data.knownAs : "";
    return String(known || data.name || data.lastName || "").trim() || t("core.market.unknownCard");
  } catch (e) {
    return t("core.market.unknownCard");
  }
};

export const isGoalkeeper = (item) => {
  try {
    if (typeof item.isGK === "function") {
      return !!item.isGK();
    }
  } catch (e) {}
  return item && item.preferredPosition === 0;
};

// Number of cards per market page (EA config, 20 by default; EA requests 1 more).
export const marketPageSize = () => {
  try {
    const getAppMain = pageGlobal("getAppMain");
    const Config = pageGlobal("EAConfigurationRepository");
    if (typeof getAppMain === "function" && Config) {
      const perPage = getAppMain()
        .getConfigRepository()
        .getConfigObject(Config.KEY_ITEMS_PER_PAGE);
      const value = perPage && Number(perPage[Config.ITEMS_PER_PAGE.TRANSFER_MARKET]);
      if (value > 0) {
        return value;
      }
    }
  } catch (e) {}
  return 20;
};

// Market search. EA's client cache is cleared every time,
// otherwise services.Item returns the previous page without querying the server.
export const searchMarket = async (criteria, page = 1) => {
  const svc = requireItemService();
  try {
    if (typeof svc.clearTransferMarketCache === "function") {
      svc.clearTransferMarketCache();
    }
  } catch (e) {}
  const started = now();
  const result = await call(t("core.market.op.search"), () => svc.searchTransferMarket(criteria, page));
  const latency = now() - started;
  const items =
    (result.response && result.response.data && result.response.data.items) || [];
  return Object.assign(result, { items: Array.from(items), latency });
};

// Buy Now or bid: EA uses the same bid(item, price) call.
export const bidOnItem = async (item, price) => {
  const svc = requireItemService();
  const started = now();
  const result = await call(t("core.market.op.buy"), () => svc.bid(item, price), 12000);
  return Object.assign(result, { latency: now() - started });
};

export const listOnMarket = async (item, startPrice, buyNowPrice, durationSeconds) => {
  const svc = requireItemService();
  return call(
    t("core.market.op.list"),
    () => svc.list(item, startPrice, buyNowPrice, durationSeconds),
    20000
  );
};

export const moveItem = async (item, pileName) => {
  const svc = requireItemService();
  return call(t("core.market.op.move"), () => svc.move(item, pile(pileName)), 15000);
};

// The card's EA price limits (min / max allowed when listing).
export const fetchPriceLimits = async (item) => {
  const read = () => {
    try {
      if (typeof item.hasPriceLimits === "function" && item.hasPriceLimits()) {
        const limits =
          (typeof item.getPriceLimits === "function" && item.getPriceLimits()) ||
          item._itemPriceLimits;
        if (limits && (limits.minimum || limits.maximum)) {
          return { min: Number(limits.minimum) || 0, max: Number(limits.maximum) || 0 };
        }
      }
    } catch (e) {}
    return null;
  };
  const cached = read();
  if (cached) {
    return cached;
  }
  const svc = itemService();
  if (!svc || typeof svc.requestMarketData !== "function") {
    return null;
  }
  await call(t("core.market.op.priceLimits"), () => svc.requestMarketData(item), 10000);
  return read();
};

export const fetchTransferList = async () => {
  const svc = requireItemService();
  const result = await call(t("core.market.op.transferList"), () => svc.requestTransferItems());
  const items =
    (result.response && result.response.response && result.response.response.items) || [];
  return Object.assign(result, { items: Array.from(items) });
};

export const fetchWatchList = async () => {
  const svc = requireItemService();
  const result = await call(t("core.market.op.watchList"), () => svc.requestWatchedItems());
  const items =
    (result.response && result.response.response && result.response.response.items) || [];
  return Object.assign(result, { items: Array.from(items) });
};

export const refreshAuctions = async (items) => {
  const svc = requireItemService();
  if (!items || !items.length) {
    return { ok: true };
  }
  return call(t("core.market.op.refreshAuctions"), () => svc.refreshAuctions(items));
};

export const untargetItems = async (items) => {
  const svc = requireItemService();
  if (!items || !items.length) {
    return { ok: true };
  }
  return call(t("core.market.op.untarget"), () => svc.untarget(items));
};

export const relistExpired = async () => {
  const svc = requireItemService();
  return call(t("core.market.op.relist"), () => svc.relistExpiredAuctions(), 20000);
};

export const clearSold = async () => {
  const svc = requireItemService();
  return call(t("core.market.op.clearSold"), () => svc.clearSoldItems(), 20000);
};

// Owned cards (club or SBC storage) for a list of exact versions, like EA's
// squad builder (defId + exact search).
const ownedSearch = async (label, run, definitionIds) => {
  const ids = Array.from(new Set((definitionIds || []).map(Number).filter(Boolean)));
  if (!ids.length) {
    return { ok: true, items: [] };
  }
  const Dto = pageGlobal("UTSearchCriteriaDTO");
  let criteria;
  try {
    criteria = typeof Dto === "function" ? new Dto() : { type: "player", defId: [] };
  } catch (e) {
    criteria = { type: "player", defId: [] };
  }
  criteria.type = "player";
  criteria.defId = toPageArray(ids);
  criteria.isExactSearch = true;
  criteria.count = Math.max(21, ids.length * 3);
  const result = await call(label, () => run(criteria), 15000);
  const items =
    (result.response && result.response.response && result.response.response.items) ||
    (result.response && result.response.data && result.response.data.items) ||
    [];
  return Object.assign(result, { items: Array.from(items) });
};

export const searchClubItems = (definitionIds) =>
  ownedSearch(t("core.market.op.club"), (criteria) => services().Club.search(criteria), definitionIds);

export const searchStorageItems = (definitionIds) => {
  const svc = itemService();
  if (!svc || typeof svc.searchStorageItems !== "function") {
    return Promise.resolve({ ok: true, items: [] });
  }
  return ownedSearch(t("core.market.op.storage"), (criteria) => svc.searchStorageItems(criteria), definitionIds);
};

export const refreshCoins = async () => {
  const svc = services();
  if (!svc || !svc.User || typeof svc.User.requestCurrencies !== "function") {
    return { ok: false };
  }
  return call(t("core.market.op.coins"), () => svc.User.requestCurrencies(), 10000);
};

const itemRepository = () => {
  const repos = repositories();
  return (repos && repos.Item) || null;
};

export const pileCapacity = (pileName) => {
  try {
    const repo = itemRepository();
    if (repo && typeof repo.getPileSize === "function") {
      return Number(repo.getPileSize(pile(pileName))) || 0;
    }
  } catch (e) {}
  return 0;
};

export const pileCount = (pileName) => {
  try {
    const repo = itemRepository();
    if (repo && typeof repo.numItemsInCache === "function") {
      return Number(repo.numItemsInCache(pile(pileName))) || 0;
    }
  } catch (e) {}
  return 0;
};

// EA's isPileFull reports "full" until the pile size is loaded: it is ignored until then.
export const isPileFull = (pileName) => {
  try {
    const repo = itemRepository();
    if (repo && typeof repo.isPileFull === "function" && pileCapacity(pileName) > 0) {
      return !!repo.isPileFull(pile(pileName));
    }
  } catch (e) {}
  return false;
};

// Transfer List summary for the stats.
export const summarizeTransferList = (items) => {
  const summary = { total: items.length, sold: 0, unsold: 0, active: 0, available: 0, soldValue: 0 };
  items.forEach((item) => {
    const auction = auctionOf(item);
    if (!auction) {
      summary.available += 1;
      return;
    }
    const is = (fn) => {
      try {
        return typeof auction[fn] === "function" && auction[fn]();
      } catch (e) {
        return false;
      }
    };
    if (is("isSold")) {
      summary.sold += 1;
      summary.soldValue += Number(auction.currentBid) || 0;
    } else if (is("isExpired")) {
      summary.unsold += 1;
    } else if (is("isSelling")) {
      summary.active += 1;
    } else {
      summary.available += 1;
    }
  });
  return summary;
};
