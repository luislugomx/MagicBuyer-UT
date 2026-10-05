import { isFinalizing, isPaused, isRunning, isStopping, startBot, stopBot } from "../core/engine";
import { formatDuration } from "../core/ranges";
import { getState, onStateChange, statusLabel } from "../core/state";
import { onLanguageChange, t } from "../i18n";
import { escapeHtml, qs, setText } from "./dom";
import { togglePanel } from "./panel";

// Floating badge: bot status + panel toggle + quick Start/Stop.

let hud = null;
let timer = null;
let languageWatched = false;

const hudHtml = () => `
      <button type="button" class="mb-hud-main" data-hud-toggle aria-label="${escapeHtml(t("ui.hud.open.aria"))}">
        <span class="mb-hud-logo">MB</span>
        <span class="mb-dot"></span>
        <span class="mb-hud-text"><b data-hud-label>MagicBuyer</b><small data-hud-detail>${escapeHtml(t("ui.hud.open.detail"))}</small></span>
      </button>
      <button type="button" class="mb-hud-action" data-hud-action aria-label="${escapeHtml(t("ui.hud.start.aria"))}">▶</button>`;

const paint = () => {
  if (!hud) {
    return;
  }
  const state = getState();
  const status = isPaused() ? "paused" : state.status;
  if (hud.dataset.status !== status) {
    hud.dataset.status = status;
  }
  const running = isRunning();
  const stats = state.stats;
  setText(qs(hud, "[data-hud-label]"), running ? statusLabel(status) : "MagicBuyer");
  const elapsed = state.startedAt && running ? formatDuration(Date.now() - state.startedAt) : "";
  setText(
    qs(hud, "[data-hud-detail]"),
    running || stats.searches
      ? `🔎 ${stats.searches} · ✅ ${stats.won}${elapsed ? ` · ${elapsed}` : ""}`
      : t("ui.hud.open.detail")
  );
  const action = qs(hud, "[data-hud-action]");
  action.disabled = isStopping() && !isFinalizing();
  setText(action, running ? "■" : "▶");
  action.setAttribute("aria-label", running ? t("ui.hud.stop.aria") : t("ui.hud.start.aria"));
  action.title = running ? t("ui.hud.stop.title") : t("ui.hud.start.title");
};

export const ensureHud = () => {
  if (hud && document.body && document.body.contains(hud)) {
    return hud;
  }
  if (!document.body) {
    return null;
  }
  hud = document.getElementById("mb-hud");
  if (!hud) {
    hud = document.createElement("div");
    hud.id = "mb-hud";
    hud.dataset.status = "idle";
    hud.innerHTML = hudHtml();
    document.body.appendChild(hud);
    hud.addEventListener("click", (event) => {
      if (event.target.closest("[data-hud-action]")) {
        if (isRunning()) {
          stopBot(t("ui.stop.manual"), { manual: true });
        } else if (!startBot()) {
          togglePanel();
        }
        paint();
        return;
      }
      if (event.target.closest("[data-hud-toggle]")) {
        togglePanel();
      }
    });
    onStateChange(paint);
    if (!timer) {
      timer = setInterval(paint, 1000);
    }
    if (!languageWatched) {
      languageWatched = true;
      // The click listener lives on the badge itself, so replacing its content keeps it working.
      onLanguageChange(() => {
        if (hud) {
          hud.innerHTML = hudHtml();
          paint();
        }
      });
    }
  }
  paint();
  return hud;
};
