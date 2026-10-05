import { observe, sleep } from "./async";
import { KIND, isFatal } from "./errors";
import { buildCriteria, cacheBusterPrices, normalizeFilter } from "./filters";
import { errorMessage, log } from "./logger";
import * as market from "./market";
import { getCoins, pageArrayOf, pageGlobal, repositories, services } from "./page";
import { floorPrice, formatCoins, priceAbove, toInt } from "./prices";
import { pickSeconds } from "./ranges";
import { getSettings } from "./settings";
import { recordTransaction, updateState } from "./state";
import { fetchFutbinSquad } from "../prices/futbinClient";
import {
  currentPrice,
  getPriceRecord,
  pricePlatform,
  requestPrice,
  seedFutbinPrice,
  trackPrice,
} from "../prices/priceService";
import { t } from "../i18n";

// Squad Building Challenges (SBC): imports a FUTBIN solution into the challenge squad,
// then buys the missing players at the FUTBIN price (editable). The challenge is never submitted
// automatically: you always click "Submit" yourself.

const FIELD_PLAYERS = 11;
const TOTAL_PLAYERS = 23;
const SBC_PRICE_MAX_AGE = 5 * 60 * 1000;

const call = (target, method, ...args) => {
  try {
    return target && typeof target[method] === "function" ? target[method](...args) : undefined;
  } catch (e) {
    return undefined;
  }
};

// ------------------------------------------------------------------- context

export const sbcContext = (ctrl) => {
  if (!ctrl) {
    return null;
  }
  const challenge = ctrl._challenge || null;
  const squad = ctrl._squad || (challenge && challenge.squad) || null;
  if (!challenge || !squad || typeof squad.getSlot !== "function") {
    return null;
  }
  return { ctrl, challenge, squad };
};

// Challenge positions (11 starters) for the current formation or another one.
export const readSlots = (squad, formationOverride) => {
  const formation = formationOverride || call(squad, "getFormation") || null;
  const slots = [];
  for (let index = 0; index < FIELD_PLAYERS; index += 1) {
    const slot = call(squad, "getSlot", index);
    if (!slot) {
      continue;
    }
    const position = formation ? call(formation, "getPosition", index) : null;
    const item = slot.item || null;
    const filled = !!call(slot, "isValid");
    const typeId = position && position.typeId != null ? Number(position.typeId) : Number(slot.generalPosition);
    slots.push({
      index,
      brick: !!call(slot, "isBrick"),
      generalPosition: Number.isFinite(typeId) ? typeId : -1,
      typeName: String((position && position.typeName) || slot.generalPositionName || positionName(typeId) || ""),
      filled,
      definitionId: filled && item ? Number(item.definitionId) || 0 : 0,
    });
  }
  return { formation, slots };
};

// EA position name from its id (web app PlayerPosition enum: 5 → "CB").
const positionName = (typeId) => {
  try {
    const names = pageGlobal("PlayerPosition");
    const name = names && names[typeId];
    return typeof name === "string" ? name : "";
  } catch (e) {
    return "";
  }
};

// ----------------------------------------------------------------- formation

const digits = (value) => String(value || "").replace(/\D+/g, "");

export const formationLabel = (formation) =>
  (formation && (formation.displayName || call(formation, "getDisplayName") || formation.name)) || "";

// EA formation matching the FUTBIN key ("4-3-3(4)" → "4334").
export const findFormation = (key) => {
  if (!key) {
    return null;
  }
  try {
    const repo = repositories() && repositories().Squad;
    const list = repo && typeof repo.getFormations === "function" ? Array.from(repo.getFormations()) : [];
    return (
      list.find((formation) => digits(formationLabel(formation)) === key) ||
      list.find((formation) => digits(formation.name) === key) ||
      null
    );
  } catch (e) {
    return null;
  }
};

// ------------------------------------------------------------------ placement

const POSITION_ALIASES = {
  GB: "GK",
  G: "GK",
  DC: "CB",
  DD: "RB",
  DG: "LB",
  DLD: "RWB",
  DLG: "LWB",
  MDC: "CDM",
  MC: "CM",
  MOC: "CAM",
  MD: "RM",
  MG: "LM",
  AD: "RW",
  AG: "LW",
  BU: "ST",
  AT: "CF",
  RCB: "CB",
  LCB: "CB",
  RDM: "CDM",
  LDM: "CDM",
  RCM: "CM",
  LCM: "CM",
  RAM: "CAM",
  LAM: "CAM",
  RS: "ST",
  LS: "ST",
};

export const normalizePosition = (label) => {
  const up = String(label || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  return POSITION_ALIASES[up] || up;
};

const possiblePositions = (item) => {
  try {
    const list = item && item.possiblePositions;
    if (list && typeof list.length === "number" && list.length) {
      return Array.from(list).map(Number);
    }
    const preferred = Number(item && item.preferredPosition);
    return Number.isFinite(preferred) && preferred >= 0 ? [preferred] : null;
  } catch (e) {
    return null;
  }
};

// Playable position: the EA card's possible positions, otherwise those given by FUTBIN.
const fits = (entry, slot) => {
  const positions = entry.item ? possiblePositions(entry.item) : null;
  if (positions) {
    return positions.includes(slot.generalPosition);
  }
  const slotName = normalizePosition(slot.typeName);
  const futbinPositions = (entry.player.positions || []).map(normalizePosition).filter(Boolean);
  if (futbinPositions.length && slotName) {
    return futbinPositions.includes(slotName);
  }
  const label = normalizePosition(entry.player.position);
  if (label && slotName) {
    return slotName === label;
  }
  return true;
};

// Possible positions for an entry: first the exact position from the FUTBIN solution (same layout,
// so same chemistry), otherwise the positions where the player can play.
const eligibleSlots = (entry, open) => {
  const wanted = normalizePosition(entry.player.slotPosition);
  if (wanted) {
    const same = open.filter((slot) => normalizePosition(slot.typeName) === wanted);
    if (same.length) {
      return same.map((slot) => slot.index);
    }
  }
  return open.filter((slot) => fits(entry, slot)).map((slot) => slot.index);
};

// Assigns each player to a position they can play (maximum matching); the others
// take the remaining positions. Returns each entry's position index (-1 if none).
export const planPlacement = (slots, entries) => {
  const open = slots.filter((slot) => !slot.brick);
  const eligible = entries.map((entry) => eligibleSlots(entry, open));
  const owner = new Map();
  // First free position first (keeps the solution order), otherwise move an already placed player.
  const assign = (entryIndex, seen) => {
    const options = eligible[entryIndex];
    const free = options.find((slotIndex) => !owner.has(slotIndex) && !seen.has(slotIndex));
    if (free !== undefined) {
      seen.add(free);
      owner.set(free, entryIndex);
      return true;
    }
    for (const slotIndex of options) {
      if (seen.has(slotIndex)) {
        continue;
      }
      seen.add(slotIndex);
      if (assign(owner.get(slotIndex), seen)) {
        owner.set(slotIndex, entryIndex);
        return true;
      }
    }
    return false;
  };
  entries.forEach((_, entryIndex) => assign(entryIndex, new Set()));
  const result = entries.map(() => -1);
  owner.forEach((entryIndex, slotIndex) => {
    result[entryIndex] = slotIndex;
  });
  const free = open.map((slot) => slot.index).filter((index) => !owner.has(index));
  result.forEach((slotIndex, entryIndex) => {
    if (slotIndex < 0 && free.length) {
      result[entryIndex] = free.shift();
    }
  });
  return result;
};

// ----------------------------------------------------------------- club cards

const betterOwned = (candidate, current) => {
  if (!current) {
    return true;
  }
  // Untradeable first (no market value), then SBC storage (duplicates) before the club.
  const rank = (entry) => (entry.item.tradable ? 2 : 0) + (entry.source === "stockage" ? 0 : 1);
  return rank(candidate) < rank(current);
};

// Owned cards (club + SBC storage) for the requested exact versions. Loans are excluded,
// as is a card rated lower than the solution's (another version of the player).
export const findOwnedItems = async (definitionIds, minRatings = new Map()) => {
  const wanted = Array.from(new Set(definitionIds.map(Number).filter(Boolean)));
  const found = new Map();
  const errors = [];
  const consider = (item, source) => {
    const id = Number(item && item.definitionId) || 0;
    if (!id || !wanted.includes(id) || call(item, "isLimitedUse")) {
      return;
    }
    const minRating = minRatings.get(id) || 0;
    if (minRating && Number(item.rating) && Number(item.rating) < minRating) {
      return;
    }
    const entry = { item, source };
    if (betterOwned(entry, found.get(id))) {
      found.set(id, entry);
    }
  };
  if (!wanted.length) {
    return { found, errors };
  }
  const club = await market.searchClubItems(wanted);
  if (club.ok) {
    club.items.forEach((item) => consider(item, "club"));
  } else if (club.error) {
    errors.push(club.error);
  }
  const storage = await market.searchStorageItems(wanted);
  if (storage.ok) {
    storage.items.forEach((item) => consider(item, "stockage"));
  } else if (storage.error) {
    errors.push(storage.error);
  }
  return { found, errors };
};

// ------------------------------------------------------------------- session

// FUTBIN price read live (account platform, under 5 min old). The price shown on the FUTBIN
// squad page is only indicative (possibly another platform): never used to buy.
const livePrice = (entry, use = "display") => currentPrice(entry.player.eaId, SBC_PRICE_MAX_AGE, use);

// Max buy price of a missing player: entered by hand, otherwise live FUTBIN price + margin (0 if unknown).
export const maxPriceFor = (entry) => {
  if (entry.manual) {
    return floorPrice(entry.maxPrice);
  }
  const price = livePrice(entry, "buy");
  if (!price) {
    return 0;
  }
  const margin = Math.max(0, Math.min(50, Number(getSettings().sbc.margin) || 0));
  const computed = floorPrice((price * (100 + margin)) / 100);
  // Cheap cards: with a margin, at least one EA tier above the FUTBIN price (650 → 700).
  return margin > 0 && computed <= price ? priceAbove(price) : computed;
};

// Price shown in the preview: live FUTBIN, otherwise the squad page price (indicative).
export const entryPrice = (entry) => livePrice(entry) || toInt(entry.player.price) || 0;

// Loads a FUTBIN solution for the open challenge: players, formation, cards already owned.
export const loadSolution = async (ctrl, url) => {
  const ctx = sbcContext(ctrl);
  if (!ctx) {
    return { ok: false, message: t("core.sbc.load.openSquad") };
  }
  const res = await fetchFutbinSquad(url);
  if (!res.ok) {
    if (res.invalid) {
      return { ok: false, message: t("core.sbc.load.invalidLink") };
    }
    if (res.blocked) {
      return { ok: false, message: t("core.sbc.load.blocked") };
    }
    if (res.empty) {
      return { ok: false, message: t("core.sbc.load.empty") };
    }
    if (res.notFound) {
      return { ok: false, message: t("core.sbc.load.notFound") };
    }
    return {
      ok: false,
      message: res.status
        ? t("core.sbc.load.noResponseStatus", { status: res.status })
        : t("core.sbc.load.noResponse"),
    };
  }
  const parsed = res.squad;
  const players = parsed.players.filter((player) => player.eaId).slice(0, FIELD_PLAYERS);
  if (!players.length) {
    return { ok: false, message: t("core.sbc.load.unidentified") };
  }
  // FUTBIN prices from the squad page (account platform): used right away, then read again
  // on each player's page (the FUTBIN link is already known, no search needed).
  const platform = pricePlatform();
  players.forEach((player) => {
    if (player.prices) {
      player.price = player.prices[platform] || 0;
    }
    seedFutbinPrice(player.eaId, {
      price: player.price,
      platform: player.prices ? platform : "",
      link: player.futbinId ? { futbinId: player.futbinId, url: player.url, name: player.name, rating: player.rating } : null,
    });
  });
  const minRatings = new Map(players.filter((player) => player.rating).map((player) => [player.eaId, player.rating]));
  const owned = await findOwnedItems(players.map((player) => player.eaId), minRatings);
  const formation = findFormation(parsed.formationKey);
  const session = {
    ctx,
    url,
    via: res.via,
    source: parsed.source || "",
    challengeName: parsed.challengeName || "",
    futbinFormation: parsed.formation || "",
    formation,
    entries: players.map((player) => {
      const hit = owned.found.get(player.eaId);
      return {
        player,
        item: hit ? hit.item : null,
        source: hit ? hit.source : null,
        state: hit ? "owned" : "missing",
        slot: -1,
        manual: false,
        maxPrice: 0,
        boughtPrice: 0,
        note: "",
      };
    }),
    ownedErrors: owned.errors,
    untrack: [],
  };
  session.entries.forEach((entry) => {
    const hint = { name: entry.player.name, rating: entry.player.rating };
    if (entry.state === "missing") {
      session.untrack.push(trackPrice(entry.player.eaId, hint, "hot"));
    } else if (!currentPrice(entry.player.eaId, SBC_PRICE_MAX_AGE)) {
      requestPrice(entry.player.eaId, hint);
    }
  });
  replan(session);
  return { ok: true, session };
};

export const releaseSession = (session) => {
  if (session && session.untrack) {
    session.untrack.forEach((untrack) => untrack());
    session.untrack = [];
  }
};

// Recomputes positions with the target formation and the known cards.
export const replan = (session) => {
  const { slots } = readSlots(session.ctx.squad, session.formation);
  session.slots = slots;
  const plan = planPlacement(slots, session.entries);
  session.entries.forEach((entry, index) => {
    entry.slot = plan[index];
    const slot = slots.find((s) => s.index === entry.slot);
    entry.slotLabel = slot ? slot.typeName : "";
  });
  return session;
};

export const sessionSummary = (session) => {
  const missing = session.entries.filter((entry) => entry.state === "missing" || entry.state === "failed");
  const total = missing.reduce((sum, entry) => sum + (maxPriceFor(entry) || 0), 0);
  const unknown = missing.filter((entry) => !maxPriceFor(entry)).length;
  return {
    placed: session.entries.filter((entry) => entry.item).length,
    total: session.entries.length,
    missing: missing.length,
    budget: total,
    unknown,
    coins: getCoins(),
  };
};

const saveChallenge = async (ctx) => {
  const svc = services();
  if (!svc || !svc.SBC || typeof svc.SBC.saveChallenge !== "function") {
    return { success: false, status: -1 };
  }
  const response = await observe(svc.SBC.saveChallenge(ctx.challenge), 15000);
  if (response && response.success) {
    try {
      ctx.ctrl.getView().updateChallenge(ctx.challenge);
    } catch (e) {}
  }
  return response;
};

// Sets the FUTBIN formation and places every known card, then saves the challenge.
export const applySession = async (session) => {
  const { squad } = session.ctx;
  try {
    const current = call(squad, "getFormation");
    if (session.formation && (!current || current.id !== session.formation.id)) {
      squad.setFormation(session.formation);
    }
    replan(session);
    const target = new Array(TOTAL_PLAYERS).fill(null);
    const keep = new Set();
    session.entries.forEach((entry) => {
      if (entry.item && entry.slot >= 0) {
        target[entry.slot] = entry.item;
        keep.add(entry.slot);
      }
    });
    // Missing players' positions are cleared: no old card blocks a future placement.
    session.slots
      .filter((slot) => !slot.brick && slot.filled && !keep.has(slot.index))
      .forEach((slot) => call(squad, "removeItemFromSlot", slot.index));
    squad.setPlayers(pageArrayOf(target), true);
  } catch (e) {
    return { ok: false, message: t("core.sbc.apply.placementFailed", { reason: errorMessage(e) }) };
  }
  const saved = await saveChallenge(session.ctx);
  if (!saved || !saved.success) {
    const code = (saved && ((saved.error && saved.error.code) || saved.status)) || "";
    return {
      ok: false,
      message: code ? t("core.sbc.apply.notSavedCode", { code }) : t("core.sbc.apply.notSaved"),
    };
  }
  return { ok: true };
};

// ------------------------------------------------------- buying missing players

// Translation keys, resolved when the message is shown.
const FATAL_MESSAGES = {
  [KIND.CAPTCHA]: "core.sbc.fatal.captcha",
  [KIND.AUTH]: "core.sbc.fatal.auth",
  [KIND.BANNED]: "core.sbc.fatal.banned",
  [KIND.LOCKED]: "core.sbc.fatal.locked",
  [KIND.RATE]: "core.sbc.fatal.rate",
  [KIND.BLOCKED]: "core.sbc.fatal.blocked",
  [KIND.FUNDS]: "core.sbc.fatal.funds",
};

const stopKind = (error) =>
  error && (isFatal(error.kind) || error.kind === KIND.RATE || error.kind === KIND.BLOCKED || error.kind === KIND.FUNDS);

const offersFor = (items, entry, maxPrice) =>
  items
    .map((item) => {
      const auction = market.auctionOf(item);
      const bin = auction ? toInt(auction.buyNowPrice) : 0;
      return { item, bin, auction };
    })
    .filter(
      (offer) =>
        offer.auction &&
        !offer.auction.tradeOwner &&
        Number(offer.item.definitionId) === entry.player.eaId &&
        offer.bin > 0 &&
        offer.bin <= maxPrice
    )
    .sort((a, b) => a.bin - b.bin || (Number(b.auction.expires) || 0) - (Number(a.auction.expires) || 0));

// Buys a missing card: exact search (specific version) with cache buster, cheapest first.
const buyOne = async (entry, token, onUpdate) => {
  const settings = getSettings();
  const tries = Math.max(1, Math.min(30, toInt(settings.sbc.triesPerPlayer) || 6));
  for (let attempt = 0; attempt < tries && !token.cancelled; attempt += 1) {
    // Never above the max price confirmed at launch; follows a FUTBIN price drop.
    const live = maxPriceFor(entry);
    const maxPrice = entry.frozenMax ? (live ? Math.min(entry.frozenMax, live) : entry.frozenMax) : live;
    if (!maxPrice) {
      entry.note = t("core.sbc.note.unknownPrice");
      return { ok: false, unknownPrice: true };
    }
    entry.note = t("core.sbc.note.searching", {
      attempt: attempt + 1,
      tries,
      price: formatCoins(maxPrice),
    });
    onUpdate(entry);
    const filter = normalizeFilter({ name: entry.player.name, definitionId: entry.player.eaId, maxBuy: maxPrice });
    const bust = cacheBusterPrices(settings.timing.cacheBuster, attempt, {
      maxBuy: maxPrice,
      minBuy: 0,
      maxBid: 0,
      cap: settings.timing.cacheBusterMax,
    });
    const result = await market.searchMarket(
      buildCriteria(filter, { maxBuy: maxPrice, minBuy: bust.minBuy, maxBid: bust.maxBid, minBid: bust.minBid }),
      1
    );
    if (token.cancelled) {
      return { ok: false };
    }
    if (!result.ok) {
      if (stopKind(result.error)) {
        return { ok: false, fatal: result.error };
      }
      entry.note = t("core.sbc.note.searchRefused", { reason: result.error.label });
    } else {
      for (const offer of offersFor(result.items, entry, maxPrice).slice(0, 2)) {
        const coins = getCoins();
        if (coins && coins < offer.bin) {
          return { ok: false, fatal: { kind: KIND.FUNDS, code: 470, label: t("core.error.funds") } };
        }
        const buy = await market.bidOnItem(offer.item, offer.bin);
        if (buy.ok) {
          return { ok: true, item: offer.item, price: offer.bin };
        }
        if (stopKind(buy.error)) {
          return { ok: false, fatal: buy.error };
        }
        if (buy.error.kind !== KIND.GONE) {
          entry.note = t("core.sbc.note.buyRefused", { reason: buy.error.label });
          break;
        }
        entry.note = t("core.sbc.note.missed");
        onUpdate(entry);
      }
    }
    if (attempt < tries - 1) {
      await sleep((pickSeconds(settings.sbc.wait, "S") || 4) * 1000, token);
    }
  }
  return { ok: false };
};

// Buys the missing players one by one, sends them to the club and places them in the challenge.
export const buyMissing = async (session, { token, onUpdate = () => {} }) => {
  const report = { bought: 0, spent: 0, failed: 0, stopped: "" };
  const queue = session.entries.filter((entry) => entry.state === "missing" || entry.state === "failed");
  // Max prices frozen at launch: the displayed budget is a real cap.
  queue.forEach((entry) => {
    entry.frozenMax = maxPriceFor(entry);
  });
  for (let index = 0; index < queue.length; index += 1) {
    const entry = queue[index];
    if (token.cancelled) {
      report.stopped = t("core.common.stopRequested");
      break;
    }
    entry.state = "searching";
    onUpdate(entry);
    let outcome;
    try {
      outcome = await buyOne(entry, token, onUpdate);
    } catch (e) {
      outcome = { ok: false };
      entry.note = errorMessage(e);
    }
    if (outcome.fatal) {
      entry.state = "failed";
      entry.note = FATAL_MESSAGES[outcome.fatal.kind] ? t(FATAL_MESSAGES[outcome.fatal.kind]) : outcome.fatal.label;
      report.stopped = entry.note;
      onUpdate(entry);
      log.error(t("core.sbc.log.stopped", { reason: entry.note }));
      break;
    }
    if (!outcome.ok) {
      entry.state = token.cancelled ? "missing" : "failed";
      if (!token.cancelled) {
        entry.note = outcome.unknownPrice ? entry.note : t("core.sbc.note.noOffer");
        report.failed += 1;
      }
      onUpdate(entry);
      continue;
    }
    report.bought += 1;
    report.spent += outcome.price;
    entry.boughtPrice = outcome.price;
    log.buy(
      t("core.sbc.log.bought", {
        name: entry.player.name,
        rating: entry.player.rating || "",
        price: formatCoins(outcome.price),
      })
    );
    recordTransaction({
      type: t("core.transaction.sbcBuy"),
      name: entry.player.name,
      rating: entry.player.rating,
      price: outcome.price,
      filter: "SBC",
    });
    updateState({ coins: getCoins() });
    const moved = await market.moveItem(outcome.item, "CLUB");
    if (!moved.ok) {
      log.warn(t("core.sbc.log.notMoved", { name: entry.player.name, reason: moved.error.label }));
    }
    entry.item = outcome.item;
    entry.source = "acheté";
    entry.state = "bought";
    entry.note = t("core.sbc.note.bought", { price: formatCoins(outcome.price) });
    onUpdate(entry);
    const placed = await applySession(session);
    if (!placed.ok) {
      entry.note += ` · ${placed.message}`;
      onUpdate(entry);
    }
    if (index < queue.length - 1 && !token.cancelled) {
      await sleep((pickSeconds(getSettings().sbc.wait, "S") || 4) * 1000, token);
    }
  }
  return report;
};

// Readable age of a card's FUTBIN price (for the preview).
export const priceStatus = (entry) => {
  const record = getPriceRecord(entry.player.eaId);
  const fallback = entry.player.price ? t("core.sbc.price.indicative") : "";
  if (!record || !record.fetchedAt || !livePrice(entry)) {
    if (record && record.status === "miss") {
      return fallback
        ? `${fallback} · ${t("core.sbc.price.cardNotFound")}`
        : t("core.sbc.price.cardNotFoundOnFutbin");
    }
    if (record && (record.status === "error" || record.status === "paused")) {
      return fallback
        ? `${fallback} · ${t("core.sbc.price.noResponse")}`
        : t("core.sbc.price.noResponse");
    }
    return fallback || t("core.sbc.price.loading");
  }
  const seconds = Math.max(0, Math.round((Date.now() - record.fetchedAt) / 1000));
  return seconds < 60
    ? t("core.sbc.price.ageSeconds", { seconds })
    : t("core.sbc.price.ageMinutes", { minutes: Math.round(seconds / 60) });
};

// Display label of an owned card's source (the source values themselves are internal ids).
const SOURCE_LABELS = {
  club: "core.sbc.source.club",
  stockage: "core.sbc.source.storage",
  "acheté": "core.sbc.source.bought",
};

export const sourceLabel = (source) => (SOURCE_LABELS[source] ? t(SOURCE_LABELS[source]) : source || "");
