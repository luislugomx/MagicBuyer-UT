import { previewSearch, isRunning } from "../../core/engine";
import {
  addFilter,
  describeFilter,
  duplicateFilter,
  filterHasTarget,
  getActiveFilter,
  getFilters,
  getLastEaSearch,
  getRotation,
  normalizeFilter,
  onFiltersChange,
  removeFilter,
  setActiveFilter,
  setRotation,
  futbinKeyForFilter,
  updateFilter,
} from "../../core/filters";
import { percentRange } from "../../core/listing";
import { afterTax, floorPrice, formatCoins, profitFor, roundPrice, toInt } from "../../core/prices";
import { getSettings } from "../../core/settings";
import { currentPrice, getPriceRecord, onPriceUpdate, requestPrice, trackPrice } from "../../prices/priceService";
import { loadEaPlayersCatalog, searchEaPlayersByTerm } from "../../services/datasource/eaPlayers";
import { numberLocale, t } from "../../i18n";
import { debounce, escapeHtml, qs, setHtml } from "../dom";
import {
  grid,
  numberField,
  priceField,
  rangeField,
  registerVirtualFilterFields,
  section,
  selectField,
  textField,
  toggleField,
} from "../fields";

// Option labels are translation keys, resolved when the page is rendered.
const LEVELS = [
  ["any", "pages.target.level.any"],
  ["bronze", "pages.target.level.bronze"],
  ["silver", "pages.target.level.silver"],
  ["gold", "pages.target.level.gold"],
  ["SP", "pages.target.level.special"],
];

const POSITIONS = [
  ["any", "pages.target.position.any"],
  ["130", "pages.target.position.zoneDefense"],
  ["131", "pages.target.position.zoneMidfield"],
  ["132", "pages.target.position.zoneAttack"],
  ["GK", "pages.target.position.GK"],
  ["RB", "pages.target.position.RB"],
  ["RWB", "pages.target.position.RWB"],
  ["CB", "pages.target.position.CB"],
  ["LB", "pages.target.position.LB"],
  ["LWB", "pages.target.position.LWB"],
  ["CDM", "pages.target.position.CDM"],
  ["CM", "pages.target.position.CM"],
  ["CAM", "pages.target.position.CAM"],
  ["RM", "pages.target.position.RM"],
  ["LM", "pages.target.position.LM"],
  ["RW", "pages.target.position.RW"],
  ["LW", "pages.target.position.LW"],
  ["CF", "pages.target.position.CF"],
  ["ST", "pages.target.position.ST"],
];

const translateOptions = (options) => options.map(([value, key]) => [value, t(key)]);

let unsubscribeFilters = null;
let unsubscribePrices = null;
let liveTrack = { key: 0, untrack: null };
let liveTimer = null;

const LIVE_MAX_AGE = 5 * 60 * 1000;

// Default names in every language (French ones come from older versions), so a filter
// named automatically is renamed after the chosen player.
const isDefaultName = (name) =>
  /^(nouveau filtre|mon filtre|filtre|new filter|my filter|filter|nuevo filtro|mi filtro|filtro)( \((copie|copy|copia)\))?$/i.test(
    String(name || "").trim()
  );

const isImportedName = (name) => /^(Recherche EA|EA search|Búsqueda EA)/i.test(String(name || ""));

const filterPrices = (filter) => {
  const parts = [];
  if (filter.priceMode === "futbin") {
    parts.push(`≤ ${filter.futbinPercent} % FUTBIN`);
  } else if (filter.maxBuy) {
    parts.push(`≤ ${formatCoins(filter.maxBuy)}`);
  }
  if (filter.sellMode === "fixed" && filter.sellPrice) {
    parts.push(`→ ${formatCoins(filter.sellPrice)}`);
  } else if (filter.sellMode === "futbin") {
    parts.push(`→ ${filter.sellPercent || getSettings().sell.futbinPercent} %`);
  }
  return parts.join(" ");
};

// Live FUTBIN price line for the active filter (% FUTBIN mode).
const futbinLiveHtml = () => {
  const filter = getActiveFilter();
  if (!filter || filter.priceMode !== "futbin") {
    return "";
  }
  const key = futbinKeyForFilter(filter);
  if (!key) {
    return `<div class="mb-note is-warn">${t("pages.target.live.noPlayer")}</div>`;
  }
  const record = getPriceRecord(key);
  const price = currentPrice(key, LIVE_MAX_AGE);
  if (!price) {
    const text =
      record && record.status === "miss"
        ? t("pages.target.live.notFound")
        : record && record.status === "error"
        ? t("pages.target.live.error")
        : t("pages.target.live.loading");
    return `<div class="mb-note${record && record.status && record.status !== "ok" ? " is-warn" : ""}">${text}</div>`;
  }
  const computed = floorPrice((currentPrice(key, LIVE_MAX_AGE, "buy") * filter.futbinPercent) / 100);
  const max = filter.maxBuy ? Math.min(filter.maxBuy, computed) : computed;
  const seconds = Math.round((Date.now() - record.fetchedAt) / 1000);
  const age = seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
  return `<div class="mb-note mb-live">FUTBIN <b>${formatCoins(price)}</b>${record.suspect ? " ⚠" : ""} · ${t("pages.target.live.readAgo", { age })}
    → ${t("pages.target.live.maxBuy")} <b>${formatCoins(max)}</b>${filter.maxBuy && filter.maxBuy < computed ? ` ${t("pages.target.live.capped")}` : ""}
    <button type="button" class="mb-link" data-target-action="futbin-refresh">${t("pages.target.live.refresh")}</button></div>`;
};

// The displayed filter's FUTBIN price is tracked while the Target tab is open.
const syncLiveTracking = () => {
  const filter = getActiveFilter();
  const key = filter && filter.priceMode === "futbin" ? futbinKeyForFilter(filter) : 0;
  if (key === liveTrack.key) {
    return;
  }
  if (liveTrack.untrack) {
    liveTrack.untrack();
  }
  liveTrack = {
    key,
    untrack: key
      ? trackPrice(key, { name: filter.player ? filter.player.name : "", rating: filter.player ? filter.player.rating : 0 }, "visible")
      : null,
  };
};

const listHtml = () => {
  const active = getActiveFilter();
  const rotation = getRotation();
  return getFilters()
    .map(
      (filter) => `
      <div class="mb-filter-item${active && active.id === filter.id ? " is-active" : ""}" data-filter-id="${filter.id}" role="button" tabindex="0">
        ${
          rotation.enabled
            ? `<button type="button" class="mb-check" role="checkbox" aria-checked="${filter.enabled}" data-filter-toggle="${filter.id}" aria-label="${escapeHtml(t("pages.target.filters.includeInRotation", { name: filter.name }))}">${filter.enabled ? "✓" : ""}</button>`
            : ""
        }
        <div class="mb-filter-main">
          <b>${escapeHtml(filter.name)}</b>
          <small>${escapeHtml(describeFilter(filter))}</small>
        </div>
        <span class="mb-price-tag">${escapeHtml(filterPrices(filter))}</span>
      </div>`
    )
    .join("");
};

const playerChipHtml = () => {
  const filter = getActiveFilter();
  const player = filter && filter.player;
  if (!player) {
    return `<span class="mb-empty">${t("pages.target.player.none")}</span>`;
  }
  return `<span class="mb-chip"><span>${escapeHtml(player.name || t("pages.target.player.fallbackName"))}${player.rating ? ` · ${player.rating}` : ""} · id ${player.id}</span><button type="button" data-player-clear aria-label="${escapeHtml(t("pages.target.player.remove"))}">×</button></span>`;
};

const targetWarningHtml = () => {
  const filter = getActiveFilter();
  if (!filter || filterHasTarget(filter)) {
    return "";
  }
  return `<div class="mb-note is-warn" style="margin-top:8px">${t("pages.target.noTargetWarning")}</div>`;
};

const lastEaHtml = () => {
  const snapshot = getLastEaSearch();
  if (!snapshot) {
    return t("pages.target.lastEa.none");
  }
  const when = new Date(snapshot.capturedAt).toLocaleTimeString(numberLocale(), { hour: "2-digit", minute: "2-digit" });
  const player =
    snapshot.player && snapshot.player.name
      ? snapshot.player.name
      : snapshot.player
      ? t("pages.target.lastEa.playerId", { id: snapshot.player.id })
      : t("pages.target.lastEa.allPlayers");
  const maxBuy = snapshot.maxBuy ? ` · ${t("pages.target.lastEa.maxBuy", { price: formatCoins(snapshot.maxBuy) })}` : "";
  return `${t("pages.target.lastEa.captured", { time: when, player: escapeHtml(player) })}${maxBuy}.`;
};

export const targetPageHtml = () => `
  ${section(
    t("pages.target.section.filters"),
    `<div class="mb-filter-list" data-filter-list>${listHtml()}</div>
     <div class="mb-row" style="margin-top:8px">
       <button type="button" class="mb-btn mb-btn-ghost mb-btn-sm" data-filter-action="add">+ ${t("pages.target.filters.new")}</button>
       <button type="button" class="mb-btn mb-btn-ghost mb-btn-sm" data-filter-action="duplicate">${t("pages.target.filters.duplicate")}</button>
       <button type="button" class="mb-btn mb-btn-danger mb-btn-sm" data-filter-action="delete">${t("pages.target.filters.delete")}</button>
     </div>
     <div style="margin-top:8px">${grid(
       toggleField({ bind: "r:enabled", label: t("pages.target.rotation.enabled.label"), hint: t("pages.target.rotation.enabled.hint") }),
       numberField({ bind: "r:every", label: t("pages.target.rotation.every.label"), hint: t("pages.target.rotation.every.hint"), min: 1, max: 50 }),
       toggleField({ bind: "r:random", label: t("pages.target.rotation.random.label"), wide: true })
     )}</div>`
  )}
  ${section(
    t("pages.target.section.target"),
    grid(
      textField({ bind: "f:name", label: t("pages.target.name.label"), wide: true }),
      `<div class="mb-field is-wide">
        <label class="mb-label" for="mb-player-input"><span>${t("pages.target.player.label")}</span><em data-catalog-status></em></label>
        <div class="mb-player-search">
          <input id="mb-player-input" class="mb-input" type="search" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(t("pages.target.player.placeholder"))}" data-player-input aria-autocomplete="list" aria-controls="mb-player-results" />
          <div class="mb-results" id="mb-player-results" role="listbox" data-player-results hidden></div>
        </div>
        <div style="margin-top:8px" data-player-chip>${playerChipHtml()}</div>
        <div data-target-warning>${targetWarningHtml()}</div>
        <p class="mb-hint">${t("pages.target.player.hint")}</p>
      </div>`,
      selectField({ bind: "f:level", label: t("pages.target.level.label"), options: translateOptions(LEVELS) }),
      selectField({ bind: "f:positionChoice", label: t("pages.target.position.label"), options: translateOptions(POSITIONS) }),
      numberField({ bind: "f:minRating", label: t("pages.target.minRating.label"), placeholder: "—", max: 99 }),
      numberField({ bind: "f:maxRating", label: t("pages.target.maxRating.label"), placeholder: "—", max: 99 })
    )
  )}
  ${section(
    t("pages.target.section.buyPrice"),
    grid(
      selectField({
        bind: "f:priceMode",
        label: t("pages.target.priceMode.label"),
        wide: true,
        options: [
          ["fixed", t("pages.target.priceMode.fixed")],
          ["futbin", t("pages.target.priceMode.futbin")],
        ],
      }),
      numberField({
        bind: "f:futbinPercent",
        label: t("pages.target.futbinPercent.label"),
        float: true,
        min: 10,
        max: 150,
        key: true,
        showIf: "f:priceMode=futbin",
        hint: t("pages.target.futbinPercent.hint"),
      }),
      priceField({
        bind: "f:maxBuy",
        label: t("pages.target.maxBuy.label"),
        key: true,
        wide: true,
        hint: t("pages.target.maxBuy.hint"),
      }),
      `<div class="mb-field is-wide" data-show-if="f:priceMode=futbin"><div data-futbin-live>${futbinLiveHtml()}</div></div>`,
      priceField({ bind: "f:maxBid", label: t("pages.target.maxBid.label"), hint: t("pages.target.maxBid.hint") }),
      priceField({ bind: "f:minBuy", label: t("pages.target.minBuy.label"), hint: t("pages.target.minBuy.hint") })
    )
  )}
  ${section(
    t("pages.target.section.resale"),
    grid(
      selectField({
        bind: "f:sellMode",
        label: t("pages.target.sellPrice.label"),
        wide: true,
        options: [
          ["global", t("pages.target.sellMode.global")],
          ["fixed", t("pages.target.sellMode.fixed")],
          ["futbin", t("pages.target.sellMode.futbin")],
        ],
      }),
      priceField({ bind: "f:sellPrice", label: t("pages.target.sellPrice.label"), wide: true, showIf: "f:sellMode=fixed" }),
      rangeField({
        bind: "f:sellPercent",
        label: t("pages.target.futbinPercent.label"),
        unit: null,
        optional: true,
        wide: true,
        placeholder: t("pages.target.sellPercent.placeholder"),
        showIf: "f:sellMode=futbin",
        hint: t("pages.target.sellPercent.hint"),
      })
    )
  )}
  ${section(
    t("pages.target.section.advanced"),
    grid(
      numberField({ bind: "f:definitionId", label: t("pages.target.definitionId.label"), placeholder: t("pages.target.definitionId.placeholder") }),
      textField({ bind: "f:raritiesText", label: t("pages.target.rarities.label"), placeholder: t("pages.target.rarities.placeholder") }),
      numberField({ bind: "f:nationField", label: t("pages.target.nation.label"), placeholder: "—" }),
      numberField({ bind: "f:leagueField", label: t("pages.target.league.label"), placeholder: "—" }),
      numberField({ bind: "f:clubField", label: t("pages.target.club.label"), placeholder: "—" }),
      numberField({ bind: "f:playStyleField", label: t("pages.target.playStyle.label"), placeholder: "—" })
    ) +
      `<p class="mb-hint">${t("pages.target.advanced.hint")}</p>`
  )}
  ${section(
    t("pages.target.section.importTest"),
    `<div class="mb-note" data-last-ea>${lastEaHtml()}</div>
     <div class="mb-row" style="margin-top:8px">
       <button type="button" class="mb-btn mb-btn-ghost mb-btn-sm" data-target-action="import">${t("pages.target.import.button")}</button>
       <button type="button" class="mb-btn mb-btn-primary mb-btn-sm" data-target-action="preview">${t("pages.target.preview.button")}</button>
     </div>
     <div data-preview></div>`
  )}
`;

// "Virtual" fields: converted to the filter model.
const VIRTUAL = {
  positionChoice: {
    read: (filter) => (filter.zone > 0 ? String(filter.zone) : filter.position || "any"),
    write: (value) =>
      /^13[0-2]$/.test(value) ? { zone: Number(value), position: "any" } : { zone: -1, position: value || "any" },
  },
  raritiesText: {
    read: (filter) => filter.rarities.join(", "),
    write: (value) => ({
      rarities: String(value || "")
        .split(/[\s,;]+/)
        .map((v) => parseInt(v, 10))
        .filter((v) => Number.isFinite(v) && v >= 0),
    }),
  },
  nationField: { read: (f) => (f.nation > 0 ? f.nation : 0), write: (v) => ({ nation: toInt(v) || -1 }) },
  leagueField: { read: (f) => (f.league > 0 ? f.league : 0), write: (v) => ({ league: toInt(v) || -1 }) },
  clubField: { read: (f) => (f.club > 0 ? f.club : 0), write: (v) => ({ club: toInt(v) || -1 }) },
  playStyleField: { read: (f) => (f.playStyle > 0 ? f.playStyle : 0), write: (v) => ({ playStyle: toInt(v) || -1 }) },
};

registerVirtualFilterFields(VIRTUAL);

const previewHtml = (result) => {
  if (!result.ok) {
    return `<div class="mb-note is-warn" style="margin-top:8px">${escapeHtml(result.message)}</div>`;
  }
  if (!result.rows.length) {
    const text = result.maxBuy
      ? t("pages.target.preview.emptyAtPrice", { price: formatCoins(result.maxBuy), ms: Math.round(result.latency) })
      : t("pages.target.preview.empty", { ms: Math.round(result.latency) });
    return `<div class="mb-note" style="margin-top:8px">${text}</div>`;
  }
  const rows = result.rows
    .slice(0, 21)
    .map((row) => {
      const deal = result.maxBuy && row.bin && row.bin <= result.maxBuy && row.match && !row.own;
      const minutes = Math.floor(row.expires / 60);
      const time = row.expires >= 3600 ? `${Math.floor(row.expires / 3600)} h` : `${minutes} min`;
      return `<tr class="${deal ? "is-deal" : row.match ? "" : "is-muted"}">
        <td>${escapeHtml(row.name)} ${row.rating}${row.own ? ` ${t("pages.target.preview.own")}` : ""}</td>
        <td class="is-num">${row.bin ? formatCoins(row.bin) : "—"}</td>
        <td class="is-num">${row.bid ? formatCoins(row.bid) : "—"}</td>
        <td class="is-num">${time}</td>
      </tr>`;
    })
    .join("");
  const cheapest = result.rows.find((row) => row.bin && row.match && !row.own);
  const futbin = result.futbinPrice
    ? ` · FUTBIN ${formatCoins(result.futbinPrice)} → ${t("pages.target.live.maxBuy")} ${formatCoins(result.maxBuy)}`
    : "";
  return `<div class="mb-preview">
      <table>
        <thead><tr><th>${t("pages.target.preview.col.card")}</th><th class="is-num">${t("pages.target.preview.col.buyNow")}</th><th class="is-num">${t("pages.target.preview.col.bid")}</th><th class="is-num">${t("pages.target.preview.col.ends")}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="mb-hint">${t("pages.target.preview.results", { count: result.rows.length })} · ${Math.round(result.latency)} ms${
      cheapest ? ` · ${t("pages.target.preview.cheapest", { price: formatCoins(cheapest.bin) })}` : ""
    }${futbin}. ${t("pages.target.preview.legend")}</p>`;
};

export const bindTargetPage = (page, refreshAll) => {
  const listEl = qs(page, "[data-filter-list]");
  const chipEl = qs(page, "[data-player-chip]");
  const input = qs(page, "[data-player-input]");
  const results = qs(page, "[data-player-results]");
  const status = qs(page, "[data-catalog-status]");
  const lastEa = qs(page, "[data-last-ea]");
  const preview = qs(page, "[data-preview]");
  let hits = [];
  let focusIndex = -1;

  const warningEl = qs(page, "[data-target-warning]");
  const liveEl = qs(page, "[data-futbin-live]");
  const renderLive = () => setHtml(liveEl, futbinLiveHtml());
  const renderList = () => {
    setHtml(listEl, listHtml());
    setHtml(chipEl, playerChipHtml());
    setHtml(warningEl, targetWarningHtml());
    setHtml(lastEa, lastEaHtml());
    syncLiveTracking();
    renderLive();
  };

  if (unsubscribeFilters) {
    unsubscribeFilters();
  }
  unsubscribeFilters = onFiltersChange(() => {
    renderList();
    refreshAll();
  });
  if (unsubscribePrices) {
    unsubscribePrices();
  }
  unsubscribePrices = onPriceUpdate((id) => {
    if (id === liveTrack.key) {
      renderLive();
      refreshAll();
    }
  });
  syncLiveTracking();
  clearInterval(liveTimer);
  liveTimer = setInterval(renderLive, 15000);

  const closeResults = () => {
    results.hidden = true;
    input.setAttribute("aria-expanded", "false");
    focusIndex = -1;
  };

  const choose = (player) => {
    const filter = getActiveFilter();
    if (!filter || !player) {
      return;
    }
    const patch = { player: { id: player.eaId, name: player.name, rating: player.rating }, definitionId: 0 };
    if (isDefaultName(filter.name)) {
      patch.name = `${player.name}${player.rating ? ` ${player.rating}` : ""}`;
    }
    updateFilter(filter.id, patch);
    input.value = "";
    closeResults();
  };

  const paintHits = () => {
    if (!hits.length) {
      results.innerHTML = `<div class="mb-hit"><small>${t("pages.target.search.noResults")}</small></div>`;
      results.hidden = false;
      return;
    }
    results.innerHTML = hits
      .map(
        (player, index) => `<button type="button" class="mb-hit${index === focusIndex ? " is-focus" : ""}" role="option" data-hit="${index}">
          <span class="mb-hit-rating">${player.rating || "—"}</span>
          <span><b>${escapeHtml(player.name)}</b><small>${escapeHtml(`${player.firstName || ""} ${player.lastName || ""}`.trim())} · id ${player.eaId}</small></span>
        </button>`
      )
      .join("");
    results.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };

  const search = debounce(async () => {
    const term = input.value.trim();
    if (term.length < 2) {
      closeResults();
      return;
    }
    status.textContent = t("pages.target.search.searching");
    hits = await searchEaPlayersByTerm(term, 12);
    status.textContent = hits.length ? "" : t("pages.target.search.catalogMaybeUnavailable");
    focusIndex = hits.length ? 0 : -1;
    paintHits();
  }, 180);

  input.addEventListener("input", search);
  input.addEventListener("focus", () => {
    loadEaPlayersCatalog().then((rows) => {
      status.textContent =
        rows && rows.length
          ? t("pages.target.search.catalogCount", { count: rows.length.toLocaleString(numberLocale()) })
          : t("pages.target.search.catalogUnavailable");
    });
  });
  input.addEventListener("keydown", (event) => {
    if (results.hidden || !hits.length) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusIndex = (focusIndex + (event.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length;
      paintHits();
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(hits[Math.max(0, focusIndex)]);
    } else if (event.key === "Escape") {
      closeResults();
    }
  });
  results.addEventListener("mousedown", (event) => event.preventDefault());
  results.addEventListener("click", (event) => {
    const hit = event.target.closest("[data-hit]");
    if (hit) {
      choose(hits[Number(hit.dataset.hit)]);
    }
  });
  input.addEventListener("blur", () => setTimeout(closeResults, 120));

  page.addEventListener("click", async (event) => {
    const target = event.target;
    const toggle = target.closest("[data-filter-toggle]");
    if (toggle) {
      event.stopPropagation();
      const filter = getFilters().find((f) => f.id === toggle.dataset.filterToggle);
      if (filter) {
        updateFilter(filter.id, { enabled: !filter.enabled });
      }
      return;
    }
    const item = target.closest("[data-filter-id]");
    if (item) {
      setActiveFilter(item.dataset.filterId);
      preview.innerHTML = "";
      return;
    }
    if (target.closest("[data-player-clear]")) {
      const filter = getActiveFilter();
      if (filter) {
        updateFilter(filter.id, { player: null });
      }
      return;
    }
    const action = target.closest("[data-filter-action]");
    if (action) {
      const active = getActiveFilter();
      if (action.dataset.filterAction === "add") {
        addFilter({ name: t("pages.target.filters.defaultName") });
      } else if (action.dataset.filterAction === "duplicate" && active) {
        duplicateFilter(active.id);
      } else if (action.dataset.filterAction === "delete" && active) {
        if (window.confirm(t("pages.target.filters.confirmDelete", { name: active.name }))) {
          removeFilter(active.id);
        }
      }
      preview.innerHTML = "";
      return;
    }
    const targetAction = target.closest("[data-target-action]");
    if (!targetAction) {
      return;
    }
    if (targetAction.dataset.targetAction === "futbin-refresh") {
      const filter = getActiveFilter();
      const key = filter ? futbinKeyForFilter(filter) : 0;
      if (key) {
        requestPrice(key, { name: filter.player ? filter.player.name : "", rating: filter.player ? filter.player.rating : 0 }).then(renderLive);
      }
      return;
    }
    if (targetAction.dataset.targetAction === "import") {
      const snapshot = getLastEaSearch();
      if (!snapshot) {
        preview.innerHTML = `<div class="mb-note is-warn" style="margin-top:8px">${t("pages.target.import.none")}</div>`;
        return;
      }
      importSnapshot(snapshot);
      preview.innerHTML = `<div class="mb-note" style="margin-top:8px">${t("pages.target.import.done")}</div>`;
      return;
    }
    if (targetAction.dataset.targetAction === "preview") {
      if (isRunning()) {
        preview.innerHTML = `<div class="mb-note is-warn" style="margin-top:8px">${t("pages.target.preview.botRunning")}</div>`;
        return;
      }
      targetAction.disabled = true;
      preview.innerHTML = `<div class="mb-note" style="margin-top:8px">${t("pages.target.preview.searching")}</div>`;
      try {
        const filter = getActiveFilter();
        const result = await previewSearch(filter);
        preview.innerHTML = previewHtml(result);
      } catch (e) {
        preview.innerHTML = `<div class="mb-note is-warn" style="margin-top:8px">${escapeHtml(e.message || e)}</div>`;
      } finally {
        targetAction.disabled = false;
      }
    }
  });
  page.addEventListener("keydown", (event) => {
    const item = event.target.closest && event.target.closest("[data-filter-id]");
    if (item && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      setActiveFilter(item.dataset.filterId);
    }
  });
};

// Applies a captured EA search to the active filter (or creates a new one).
export const importSnapshot = (snapshot, { asNew = false } = {}) => {
  if (!snapshot) {
    return null;
  }
  const patch = {
    type: snapshot.type,
    category: snapshot.category,
    level: snapshot.level,
    rarities: snapshot.rarities,
    position: snapshot.position,
    zone: snapshot.zone,
    nation: snapshot.nation,
    league: snapshot.league,
    club: snapshot.club,
    playStyle: snapshot.playStyle,
    definitionId: snapshot.definitionId,
    player: snapshot.player,
  };
  if (snapshot.maxBuy) {
    patch.maxBuy = snapshot.maxBuy;
  }
  if (snapshot.minBuy) {
    patch.minBuy = snapshot.minBuy;
  }
  if (snapshot.maxBid) {
    patch.maxBid = snapshot.maxBid;
  }
  const name = snapshot.player && snapshot.player.name
    ? `${snapshot.player.name}${snapshot.player.rating ? ` ${snapshot.player.rating}` : ""}`
    : t("pages.target.import.defaultName");
  const active = getActiveFilter();
  if (asNew || !active) {
    return addFilter(Object.assign({ name }, patch));
  }
  if (isDefaultName(active.name) || isImportedName(active.name)) {
    patch.name = name;
  }
  updateFilter(active.id, patch);
  return normalizeFilter(Object.assign({}, active, patch));
};

// Max buy actually used (fixed, or capped % FUTBIN) for the page hints.
const effectiveBuy = (filter) => {
  if (filter.priceMode !== "futbin") {
    return toInt(filter.maxBuy);
  }
  const key = futbinKeyForFilter(filter);
  const price = key ? currentPrice(key, LIVE_MAX_AGE, "buy") : 0;
  if (!price) {
    return 0;
  }
  const computed = floorPrice((price * filter.futbinPercent) / 100);
  return filter.maxBuy ? Math.min(filter.maxBuy, computed) : computed;
};

// Hint under the resale price: net after tax + profit per card.
export const sellExtra = () => {
  const filter = getActiveFilter();
  if (!filter) {
    return "";
  }
  const settings = getSettings().sell;
  let sell = 0;
  let prefix = "";
  const futbinSell = filter.sellMode === "futbin" || (filter.sellMode === "global" && settings.priceMode === "futbin");
  if (futbinSell) {
    const key = futbinKeyForFilter(filter);
    const price = key ? currentPrice(key, LIVE_MAX_AGE, "sell") : 0;
    if (!price) {
      return "";
    }
    const range = percentRange(filter.sellMode === "futbin" && filter.sellPercent ? filter.sellPercent : settings.futbinPercent);
    sell = roundPrice((price * (range.min + range.max)) / 200);
    prefix = `≈ ${formatCoins(sell)} · `;
  } else {
    sell = filter.sellMode === "fixed" ? toInt(filter.sellPrice) || toInt(settings.defaultPrice) : toInt(settings.defaultPrice);
  }
  if (!sell) {
    return "";
  }
  const buy = effectiveBuy(filter);
  const net = afterTax(sell);
  const profit = buy ? profitFor(buy, sell) : 0;
  const profitText = buy ? ` · ${t("pages.target.sellExtra.profit", { profit: `${profit >= 0 ? "+" : ""}${formatCoins(profit)}` })}` : "";
  return `${prefix}${t("pages.target.sellExtra.net", { price: formatCoins(net) })}${profitText}`;
};
