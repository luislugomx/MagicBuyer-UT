import { t } from "../i18n";
import { errorCode } from "./page";

// Classification of FC 27 UTAS error responses.
export const KIND = {
  CAPTCHA: "captcha",
  AUTH: "auth",
  BANNED: "banned",
  LOCKED: "locked",
  RATE: "rate",
  BLOCKED: "blocked",
  GONE: "gone",
  FUNDS: "funds",
  FULL: "full",
  TIMEOUT: "timeout",
  OTHER: "other",
};

export const responseCode = (response) => {
  if (!response) {
    return 0;
  }
  const fromError = Number(response.error && response.error.code);
  if (fromError) {
    return fromError;
  }
  return Number(response.status) || 0;
};

export const classify = (response) => {
  const code = responseCode(response);
  if (response && response.timeout) {
    return { code, kind: KIND.TIMEOUT, label: t("core.error.timeout") };
  }
  if (code === errorCode("CAPTCHA_REQUIRED")) {
    return { code, kind: KIND.CAPTCHA, label: t("core.error.captcha") };
  }
  if (code === 401) {
    return { code, kind: KIND.AUTH, label: t("core.error.auth") };
  }
  if (code === errorCode("ACCOUNT_BANNED") || code === errorCode("UNRECOVERABLE")) {
    return { code, kind: KIND.BANNED, label: t("core.error.banned") };
  }
  if (code === errorCode("LOCKED_TRANSFER_MARKET")) {
    return { code, kind: KIND.LOCKED, label: t("core.error.locked") };
  }
  if (code === 429) {
    return { code, kind: KIND.RATE, label: t("core.error.rate") };
  }
  if (code === 512 || code === 521) {
    return { code, kind: KIND.BLOCKED, label: t("core.error.blocked") };
  }
  if (
    code === errorCode("PERMISSION_DENIED") ||
    code === errorCode("NO_TRADE_EXISTS") ||
    code === 426 ||
    code === 409
  ) {
    return { code, kind: KIND.GONE, label: t("core.error.gone") };
  }
  if (code === errorCode("NOT_ENOUGH_CREDIT")) {
    return { code, kind: KIND.FUNDS, label: t("core.error.funds") };
  }
  if (code === errorCode("DESTINATION_FULL")) {
    return { code, kind: KIND.FULL, label: t("core.error.full") };
  }
  return { code, kind: KIND.OTHER, label: code ? t("core.error.code", { code }) : t("core.error.unknown") };
};

// Errors that must stop the bot immediately.
export const isFatal = (kind) =>
  kind === KIND.CAPTCHA || kind === KIND.AUTH || kind === KIND.BANNED || kind === KIND.LOCKED;

export const parseCodeList = (text) =>
  new Set(
    String(text || "")
      .split(/[\s,;]+/)
      .map((part) => parseInt(part, 10))
      .filter((n) => Number.isFinite(n) && n > 0)
  );
