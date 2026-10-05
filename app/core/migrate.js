import { futbinKeyForFilter, getFilters, updateFilter } from "./filters";
import { getSettings, setSetting } from "./settings";

// Settings migrations between versions (run only once at startup).
export const runMigrations = () => {
  const settings = getSettings();
  const done = new Set((settings.meta && settings.meta.migrations) || []);
  if (!done.has("futbin-modes")) {
    // v5.0: global "reference price" → v5.1: FUTBIN mode per filter + FUTBIN resale.
    if (settings.buy && settings.buy.useReference) {
      const percent = Number(settings.buy.referencePercent) || 85;
      // Only filters that target a specific card (the FUTBIN price is that card's price).
      getFilters()
        .filter((filter) => futbinKeyForFilter(filter))
        .forEach((filter) => updateFilter(filter.id, { priceMode: "futbin", futbinPercent: percent }));
    }
    if (settings.sell && settings.sell.useReference) {
      setSetting("sell.priceMode", "futbin");
      if (settings.sell.referencePercent) {
        setSetting("sell.futbinPercent", String(settings.sell.referencePercent));
      }
    }
    if (settings.ui && settings.ui.futbinBadges === false) {
      setSetting("ui.cardPrices", false);
    }
    done.add("futbin-modes");
    setSetting("meta.migrations", Array.from(done));
  }
};
