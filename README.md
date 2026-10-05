Español: [README.es.md](README.es.md)

# MagicBuyer-UT — sniper for the EA FC 27 web app

Tampermonkey script that adds a sniper / autobuyer to the **EA SPORTS FC 27 Ultimate Team** web app:
looping searches on the Transfer Market, instant Buy Now on cards under your max price (fixed or a % of the
live-tracked FUTBIN price), automatic listing at the FUTBIN price, FUTBIN prices on every card, import of FUTBIN
SBC solutions with purchase of the missing players, and configurable pauses and stops.

> ⚠️ **Read this before using it.** Automating the web app is against EA's terms of service.
> EA can restrict access to the Transfer Market (soft ban), ask for captchas, or even ban the account.
> Use this script at your own risk; the authors are not responsible for any penalty on your account.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) on Chrome, Edge or Brave.
   On recent Chrome versions, enable **"Allow User Scripts"** in the Tampermonkey extension details.
2. Open `fut-auto-buyer.user.js` from the [latest release](https://github.com/AMINE1921/MagicBuyer-UT/releases/latest) and click **Install**.
3. Open the [FC 27 web app](https://www.ea.com/ea-sports-fc/ultimate-team/web-app/) and log in.

The Transfer Market must be unlocked on your account.

## Quick start

1. Click the **MagicBuyer** tab (EA navigation bar) or the **MB** badge at the bottom right.
2. **Target** tab: type the player's name and pick them from the list.
3. Set the **Max Buy Now price** and, if you want to resell, the **Resale price**
   (the panel shows the net amount after EA's 5% tax and the profit per card).
4. Click **Test search (no buying)** to see what the market returns (in green: what the bot would buy).
5. Click **▶ Start**. You can close the panel: the badge shows the status, searches and purchases.

Another way: set up your search in EA's **Transfers → Transfer Market** (rarity, position, chemistry style…)
then click **⚡ Snipe this search**: a filter is created with exactly those criteria.

## Language

The interface is available in English and Spanish. Pick the language from the selector in the panel header:

- **Auto** (default): follows the EA web app language, then your browser language, and falls back to English.
- **English** / **Español**: forces that language.

Your choice is saved with the rest of the settings.

## FUTBIN prices

All price features use **FUTBIN** (pages are read just like in your browser, console or PC platform
depending on your account). **FUTBIN** tab: the **Test FUTBIN** button checks access.

- **Buy at a % of the FUTBIN price** (Target tab → Buy price → Mode): for example 90%; the max buy price
  is recalculated on every price update. A fixed price can act as an absolute cap.
  Without a recent FUTBIN price (less than 5 min old), the filter waits: it never buys on a stale price.
- **Resell at a % of the FUTBIN price** (Sell tab, or per filter): the price of the version bought is read again right
  after the purchase. Without a FUTBIN price, the card goes to the Transfer List without being listed.
- **Relist at the FUTBIN price** and the **List at FUTBIN price** button (Transfers tab) for available and unsold cards.
- **Price tag** at the top of every player card (club, market, transfers, squads, SBC); click it to open the FUTBIN page.
- **EA's "List on Transfer Market" panel**: the card's FUTBIN price and a **Fill** button (you confirm with EA's button).

Smart refresh: the bot's targets and SBC purchases are re-read every 60 to 120 s, displayed cards every
~2 min (less often if the price does not move), only one FUTBIN request at a time, spaced out,
automatic slowdown if FUTBIN blocks, and an abnormal price jump is checked a second time before being used.
FUTBIN does not push its prices: they are re-read regularly as long as the card is tracked.

If FUTBIN returns a Cloudflare check, open futbin.com in a tab and pass the check;
the "hidden FUTBIN page" fallback (invisible iframe) takes over when the direct request is refused.

## SBC: FUTBIN solutions

1. Open a challenge's squad (the screen with the pitch) and click **⚡ FUTBIN solution** at the top of the screen.
2. Paste the FUTBIN solution link (the squad page) then **Load**: formation, 11 players, the ones from your club
   (and from SBC storage, loans excluded, untradeables first) and the ones **to buy** with their FUTBIN price.
3. **Place in squad**: the formation is applied and players are placed in a position where they can play.
4. Check or edit the **max price** of each missing player (FUTBIN price + adjustable margin), then **Buy missing players**:
   exact search for the version, cheapest first, purchase, sent to the club and placed in the challenge.

The challenge is never submitted automatically: you are the one who clicks "Submit". A captcha, an expired session or an
EA rate limit stops the buying immediately; the **Stop** button stops it at any time.

## How the sniper avoids missing a deal

- **Fresh results on every search**: the web app cache is cleared and every request is different
  ("automatic" anti-cache: the max bid varies *above* your max buy price, so no buyable listing is excluded).
- **Instant Buy Now** as soon as EA responds, without waiting for FUTBIN or any other request.
- **Cheapest first**, then the most recent at equal price; your own listings are ignored.
- **Resale after the purchase**, never during: the next search is not delayed.
- **Tab kept active in the background**: Chrome throttles hidden tabs; the "Keep tab active" option prevents it
  (a speaker icon appears on the tab, no sound is played).

## Settings

| Tab | Main settings |
| --- | --- |
| **Target** | Saved filters, rotation between filters, player, quality, position, min/max rating, buy price (fixed or live FUTBIN %, cap), resale (Sell tab, fixed or FUTBIN %), max bid, advanced IDs (exact version, rarity, nation, league, club, chemistry style). |
| **Buy** | Max purchases per search, stop after N purchases, coin reserve, results threshold, skip goalkeepers, bids (end time window, outbid, max active bids). |
| **Sell** | Automatic listing / send to Transfer List / nothing, fixed price or % of FUTBIN price, duration, minimum profit. |
| **Timing** | Safe / Normal / Fast profiles, time between searches, max searches per minute, pause every N searches, pause duration, auto stop, delay after purchase, anti-cache, pages browsed, safety pause on EA rate limit. |
| **Transfers** | List status, relist unsold (same price or FUTBIN price), bulk listing at FUTBIN price, clear sold, stop if the list is full. |
| **FUTBIN** | Access test, price platform, refresh frequency, price jump guard, tags on cards, SBC purchase settings. |
| **Alerts** | Sounds, browser notifications, Discord webhook, Telegram bot, choice of notified events. |

Accepted duration formats: `5-9` (seconds), `4.5-7`, `40-80S`, `5M`, `1-2H`, `1D`.
All values are saved automatically (Tampermonkey storage).

### Timing profiles

| Profile | Between searches | Max / minute | Pause | Auto stop |
| --- | --- | --- | --- | --- |
| Safe | 8 to 14 s | 6 | 60–120 s every 12–18 searches | 1–2 h |
| Normal (default) | 5 to 9 s | 10 | 40–80 s every 15–25 searches | 2–3 h |
| Fast | 3 to 5 s | 15 | 30–60 s every 20–30 searches | 1–1.5 h |

The faster the pace, the sooner EA triggers captchas and rate limits.

### Safety

- **Captcha (458)**, **expired session (401)**, **market locked (494)**, **account blocked**: immediate stop + alert.
- **Too many requests (429) / temporary block (512, 521)**: safety pause (4 to 8 min by default), stop if it repeats.
- **3 failed searches in a row**: stop.
- Custom error codes: Timing tab → EA errors.

The script never solves captchas: solve it yourself in the web app, then restart.

## Build from source

```bash
npm install
npm run build:prod
```

The script is generated in `dist/fut-auto-buyer.user.js` (Tampermonkey header in `tampermonkey-header.js`).

## What's new in 5.1.1

- SBC: fixed reading of FUTBIN solutions (the squad is read from the page data, no longer from the rendered view):
  formation, exact position of each player as on FUTBIN, locked challenge position respected, page prices picked up right away.

## What's new in 5.1.0

- Buy at a % of the FUTBIN price per filter, with the price tracked live while the bot runs (optional cap).
- Resale and relist at a % of the FUTBIN price, bulk listing of the Transfer List at the FUTBIN price.
- FUTBIN price tag on every player card and a "Fill" button in EA's listing panel.
- SBC: import of a FUTBIN solution (formation + club players), purchase of missing players at an editable FUTBIN price.
- New FUTBIN tab (access test, smart refresh, price jump guard).
- FUTWIZ removed: FUTBIN is the single source. Old "reference price" settings are converted automatically.

## What's new in 5.0.0

Complete rewrite of the engine and interface for FC 27:

- Snipe engine rewritten on the real FC 27 web app APIs (`UTSearchCriteriaDTO`, `services.Item`), without URL rewriting or fragile hooks.
- Fixes the bot getting stuck after the first purchase, no stop on captcha, the FUTBIN price replacing the max price,
  anti-cache disabled on targeted players, settings never saved and the render loop that loaded the CPU.
- New side panel (the web app stays usable), floating badge, filterable log, CSV export, search test without buying,
  import of an EA search, rotation between several filters, timing profiles, bids, Discord/Telegram notifications.
