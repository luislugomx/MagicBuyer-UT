import { numberLocale } from "../i18n";
import { pageGlobal } from "./page";

// FC 27 price tiers (UTCurrencyInputControl.PRICE_TIERS), sorted from highest to lowest.
const FALLBACK_TIERS = [
  { min: 100000, inc: 1000 },
  { min: 50000, inc: 500 },
  { min: 10000, inc: 250 },
  { min: 1000, inc: 100 },
  { min: 150, inc: 50 },
  { min: 0, inc: 150 },
];

export const MIN_PRICE = 150;
export const EA_TAX = 0.05;

const tiers = () => {
  const control = pageGlobal("UTCurrencyInputControl");
  const list = control && control.PRICE_TIERS;
  if (Array.isArray(list) && list.length && list.every((t) => t && t.inc > 0)) {
    return list;
  }
  return FALLBACK_TIERS;
};

export const maxPrice = () => {
  const max = Number(pageGlobal("AUCTION_MAX_BID"));
  return max > 0 ? max : 15000000;
};

export const toInt = (value) => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  }
  const digits = String(value == null ? "" : value).replace(/[^\d]/g, "");
  return digits ? parseInt(digits, 10) : 0;
};

// User input: "45000", "45 000", "45k", "1,2m".
export const parseCoinsInput = (value) => {
  const text = String(value == null ? "" : value)
    .trim()
    .toLowerCase()
    .replace(/[\s  ]/g, "");
  const short = text.match(/^(\d+(?:[.,]\d+)?)([km])$/);
  if (short) {
    const n = parseFloat(short[1].replace(",", "."));
    return Math.round(n * (short[2] === "k" ? 1000 : 1000000));
  }
  return toInt(text);
};

const tierFor = (value, strict) =>
  tiers().find((tier) => (strict ? value > tier.min : value >= tier.min)) ||
  FALLBACK_TIERS[FALLBACK_TIERS.length - 1];

// Rounds to a valid EA price (multiple of the tier step), clamped to [150, max].
export const roundPrice = (value) => {
  const n = toInt(value);
  if (!n) {
    return 0;
  }
  const { inc } = tierFor(n, false);
  const rounded = Math.round(n / inc) * inc;
  return Math.min(Math.max(rounded, MIN_PRICE), maxPrice());
};

// Rounds down (max price: never above what the user entered).
export const floorPrice = (value) => {
  const n = toInt(value);
  if (n < MIN_PRICE) {
    return 0;
  }
  const { inc } = tierFor(n, false);
  return Math.min(Math.floor(n / inc) * inc, maxPrice());
};

// Rounds up (min price).
export const ceilPrice = (value) => {
  const n = toInt(value);
  if (!n) {
    return 0;
  }
  if (n <= MIN_PRICE) {
    return MIN_PRICE;
  }
  const { inc } = tierFor(n, false);
  return Math.min(Math.ceil(n / inc) * inc, maxPrice());
};

// Next tier up (same rule as UTCurrencyInputControl.getIncrementAboveVal).
export const priceAbove = (value) => {
  const n = toInt(value);
  if (n < MIN_PRICE) {
    return MIN_PRICE;
  }
  if (n >= maxPrice()) {
    return maxPrice();
  }
  const { inc } = tierFor(n, false);
  return Math.min(Math.round((n + inc) / inc) * inc, maxPrice());
};

// Next tier down (same rule as UTCurrencyInputControl.getIncrementBelowVal).
export const priceBelow = (value) => {
  const n = toInt(value);
  if (n <= MIN_PRICE) {
    return 0;
  }
  const { inc } = tierFor(n, true);
  const next = Math.round((n - inc) / inc) * inc;
  return next >= MIN_PRICE ? next : 0;
};

export const stepPrice = (value, direction) =>
  direction > 0 ? priceAbove(value || 0) : priceBelow(value || 0);

export const afterTax = (price) => {
  const n = toInt(price);
  return n ? Math.floor(n * (1 - EA_TAX)) : 0;
};

export const profitFor = (buyPrice, sellPrice) => {
  const buy = toInt(buyPrice);
  const sell = toInt(sellPrice);
  if (!buy || !sell) {
    return 0;
  }
  return afterTax(sell) - buy;
};

export const formatCoins = (value) => {
  const n = Math.round(Number(value) || 0);
  const sign = n < 0 ? "-" : "";
  return sign + new Intl.NumberFormat(numberLocale(), { maximumFractionDigits: 0 }).format(Math.abs(n));
};

// Recommended start price for a listing at the given BIN.
export const startPriceFor = (bin) => {
  const below = priceBelow(bin);
  return below >= MIN_PRICE ? below : MIN_PRICE;
};
