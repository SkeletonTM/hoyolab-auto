# HoyoLab Auto — Google Apps Script edition

A self-contained [Google Apps Script](https://script.google.com/) that signs you into Genshin Impact, Honkai: Star Rail, Honkai Impact 3rd, and Zenless Zone Zero every day, and (optionally) redeems active promo codes. Runs entirely on Google's infrastructure — no local machine, no Docker, no cost.

This is a fork of [torikushiii/hoyolab-auto](https://github.com/torikushiii/hoyolab-auto) trimmed down to just the Apps Script file, with a fixed Discord notification flow that actually works for code redemption.

## What's different from upstream

| Area | Upstream (Google Script) | This fork |
| --- | --- | --- |
| Discord notifications on check-in | ✅ (but only when a new sign-in happens) | ✅ (always — even when already signed in) |
| Discord notifications on code redemption | ❌ | ✅ |
| Discord notifications on errors | ❌ | ✅ |
| Number of webhook POSTs per run | up to 4 × accounts | exactly 1 |
| `checkInAllGames()` flushes the buffer | ❌ | ✅ |
| `manuallyRedeemCodes()` flushes the buffer | ❌ (had no notifications at all) | ✅ |
| Files in the repo | 100+ (Node.js, Docker, …) | 5 |
| Code source | `api.ennead.cc` (single source) | `api.ennead.cc` + [Hum-Bao/hoyoverse-codes](https://github.com/Hum-Bao/hoyoverse-codes) GitHub raw, merged in parallel |

## Repository layout

```text
hoyolab-auto/
├── LICENSE                                  # AGPL-3.0, inherited from upstream
├── README.md                                # you are here
├── .gitignore
├── services/
│   └── google-script/
│       ├── index.js                         # the actual script — paste this into Apps Script
│       └── README.md                        # original upstream setup guide (kept for reference)
└── setup/
    └── DISCORD_WEBHOOK.md                   # how to create a Discord webhook URL
```

## Quick start

### 1. Create the script

1. Open [https://script.google.com/](https://script.google.com/) and click **+ New project**.
2. Delete the placeholder `function myFunction() { … }` in the editor.
3. Open [`services/google-script/index.js`](services/google-script/index.js) in this repo, select all, copy, and paste it into the Apps Script editor.
4. Click the 💾 floppy-disk icon to save. Name the project anything you like (e.g. "HoyoLab Auto").

### 2. Add your accounts

In the same editor, scroll to the top of the file. You'll see:

```javascript
const config = {
	enableCodeRedemption: false, // set to true once everything else works
	redeemCodesEvenIfSignedIn: false, // true = also redeem codes for accounts already signed in today
	genshin:  { data: [ /* "ltoken_v2=…; ltuid_v2=…;", */ ] },
	honkai:   { data: [ /* "ltoken_v2=…; ltuid_v2=…;", */ ] },
	starrail: { data: [ /* "ltoken_v2=…; ltuid_v2=…;", */ ] },
	zenless:  { data: [ /* "ltoken_v2=…; ltuid_v2=…;", */ ] },
};
```

Replace the placeholders with your real cookies, one per line. For multiple accounts in the same game, add more strings inside the same `data: []` array.

#### How to get the cookie

The cleanest way is the one that works for both **check-in and code redemption** (the original repo warns that the check-in-page cookie often doesn't carry the right tokens for code redemption):

1. Open [HoyoLab](https://www.hoyolab.com/) in your browser and sign in.
2. Press `F12` to open DevTools and switch to the **Network** tab.
3. Refresh the page; in the network log, search for `getGameRecordCard` and click the matching request.
4. In the right-hand pane, open the **Headers** tab, scroll to **Request Headers**, and copy the entire `cookie` value.
5. Paste that string into the right `data: []` array in `config`.

### 3. (Optional) Enable Discord notifications

A few lines below the `config` object you'll see:

```javascript
const DISCORD_WEBHOOK = null;  // replace with your Discord webhook URL (optional)
const DISCORD_USER_ID = "";    // optional, pings you when something goes wrong
```

Follow [`setup/DISCORD_WEBHOOK.md`](setup/DISCORD_WEBHOOK.md) to create a webhook, then paste the URL into `DISCORD_WEBHOOK` (inside quotes). To also get a `@mention` whenever an error appears in the report, paste your numeric Discord user ID into `DISCORD_USER_ID`.

With the webhook set, **every** run ends with a single Discord message that looks like this:

```text
✅ [Genshin Impact] Alice (800000001): Got Primogem x20 (total: 31)
⏭️ [Honkai: Star Rail] Bob (800000002): Already signed in today (total: 14)
✅ [Zenless Zone Zero] Carol (800000003): Got Polychrome x50 (total: 8)
🎁 [Genshin Impact] Code GENSHIN2026 claimed for Alice (800000001)
⏭️ [Honkai: Star Rail] Code STARRAIL1 already redeemed for Bob
```

### 4. (Optional) Enable code redemption

Once the basic check-in is working for a day or two, set:

```javascript
enableCodeRedemption: true,
```

This will additionally call `redeemCodes()` for each account that just signed in. Codes you've already redeemed are remembered in Apps Script's `PropertiesService`, so they will not be claimed twice.

If you want codes checked for **all** accounts on every run — even when everyone is already signed in (e.g. you run the script twice a day, or a limited-time livestream code drops after the morning check-in) — also set:

```javascript
redeemCodesEvenIfSignedIn: true,
```

With that on, "already signed in" accounts are still skipped for check-in but are included in code redemption. Codes the API reports as already redeemed (`retcode -2017/-2018`) or expired (`-2001/-2003`) are logged as skips/warnings, not errors, and remembered so they're never retried.

If you ever need to force-redeem a code (e.g. the API didn't return it in time), pick one of these functions in the toolbar and run it once:

- `redeemGenshinCodes(forceRedeem = true)` — Genshin
- `redeemStarRailCodes(forceRedeem = true)` — Star Rail
- `redeemZenlessCodes(forceRedeem = true)` — Zenless Zone Zero

For Honkai Impact 3rd, code redemption is not supported by this script.

#### Code source: which APIs does the script call?

The script pulls the list of currently-active promo codes from **two** community-maintained aggregators in parallel and merges the results (deduplicated by code):

- [api.ennead.cc](https://api.ennead.cc) — torikushiii's JSON aggregator (~300 ms)
- [Hum-Bao/hoyoverse-codes](https://github.com/Hum-Bao/hoyoverse-codes) — GitHub-hosted txt files (~12 ms, updated daily at 1:15 PST)

Why two? `api.ennead.cc` is one person's Cloudflare project with no SLA; the GitHub raw URL is a CDN-fronted fallback. Hitting both in parallel means a single outage does not block code redemption, and the second source often picks up codes the first missed (region-locked codes, livestream codes, etc.). The cost is negligible: the two requests run in parallel via `Promise.allSettled`, so wall-clock latency is the slower of the two, not the sum. If both fail the run reports 0 codes and moves on, same as the original single-source behaviour.

**What we measured on 2026-07-04 (4 July, ~04:00 UTC):**

| Game | ennead active | Hum-Bao active | Union (deduplicated) |
|---|---|---|---|
| Genshin Impact | 4 | 3 | 4 |
| Honkai: Star Rail | 8 | 11 | 11 |
| Zenless Zone Zero | 7 | 6 | 8 |

Note that some codes returned by these sources are region-locked or already expired — the redemption API returns a dedicated retcode for those (`-2001`/`-2003`), and the script logs them as ⚠️ skips rather than ❌ errors. If you only play in one region, you can filter those out later by editing `redeemCodes()` to compare against your account's `account.region`.

To add a third source, append a new entry to the `CODE_SOURCES` table at the top of `index.js` and to the `CODE_SOURCE_ORDER` array right below it. Each entry is `{ name, urlFor(gameParam) → string, parse(text) → [{code, rewards?}] }`.

### 5. Set up a daily trigger

1. In the Apps Script editor, click the clock icon ⏰ on the left ("Triggers").
2. Click **+ Add Trigger** in the bottom-right.
3. Configure:
   - **Choose which function to run:** `checkInAllGames`
   - **Which deployment should run:** `Head`
   - **Select event source:** `Time-driven`
   - **Select type of time-based trigger:** `Day timer`
   - **Select time of day:** see [Daily reset schedule](#daily-reset-schedule) below — pick **05:00–06:00 server time** for the latest region you play on, not your own morning.
4. Save. Google will ask you to authorise the script to access external services and your script properties — accept.

### 6. Run it once manually

Click the ▶ **Run** button with `checkInAllGames` selected in the toolbar. The first run will pop up an authorisation dialog — accept it. Open the **Executions** tab in the left sidebar to see logs and any errors.

If you set `DISCORD_WEBHOOK`, you should see the report message arrive in Discord within a few seconds.

## Daily reset schedule

The daily check-in bonus for **all four supported games** (Genshin Impact, Honkai Impact 3rd, Honkai: Star Rail, Zenless Zone Zero) refreshes at the same wall-clock moment: **04:00 server time**. The reset is server-relative, not UTC-relative, so the actual UTC tick depends on which region your account is on.

Times in the table below are in **standard time** (EST / CET — no DST applied). DST shifts are noted below the table.

| Region | Server TZ | UTC | US (ET) | Moscow (UTC+3) | Japan (JST, UTC+9) |
|---|---|---|---|---|---|
| **NA** (America) | EST (UTC−5) | **09:00** | 04:00 | 12:00 | 18:00 |
| **EU** (Europe) | CET (UTC+1) | **03:00** | 22:00 prev day | 06:00 | 12:00 |
| **SEA** (Southeast Asia) | SGT (UTC+8) | **20:00** prev day | 15:00 prev day | 23:00 prev day | 05:00 next day |
| **TW** (Taiwan / HK / MO) | CST (UTC+8) | **20:00** prev day | 15:00 prev day | 23:00 prev day | 05:00 next day |

### DST shift (Northern Hemisphere summer)

Between the 2nd Sunday of March and the 1st Sunday of November, US and EU clocks spring forward by one hour. The table values change as follows (SEA and TW are not affected — they have no DST):

| Region | UTC | US (ET) | Moscow (UTC+3) | Japan (JST, UTC+9) |
|---|---|---|---|---|
| **NA** | 08:00 | 05:00 (EDT) | 11:00 | 17:00 |
| **EU** | 02:00 | 22:00 prev day (EDT) | 05:00 | 11:00 |

If your account is in the EU region, the EU reset happens **2 hours after** the SEA / TW reset in the same 24-hour day. If you have a NA account, the NA reset happens **6 hours after** the SEA / TW reset on the *next* calendar day (i.e. 26 hours after SEA / TW reset if you look at absolute UTC time).

### How to find your region

The cookie you pasted is tied to a specific region — that's the region the account was created on, and you can't change it later. To find out which one you have:

1. Open the **Executions** tab in Apps Script after running `checkInAllGames` at least once.
2. Click the latest successful run and open the logs.
3. Look for a line like `Successful check-ins for genshin: [...]` — each entry's `region` field (one of `NA`, `EU`, `SEA`, `TW`) is your region for that game.

Or, the easy way: just look at which one matches your in-game server name in the title screen.

### Picking a trigger time

The script's `sign()` call is a no-op if you've already signed in today (`is_sign` returns `true` from the API). So **any time after the reset works** — but you want a small buffer to absorb server clock drift.

Rule of thumb: schedule the trigger for **05:00 server time** in the region you play on (or in the **latest** region, if you have multiple).

Concrete recipes in UTC:

- **NA only:** `09:30 UTC` (winter) / `08:30 UTC` (summer, DST) — also equals `04:30 EST` / `05:30 EDT` / `12:30 MSK` / `18:30 JST` (winter)
- **EU only:** `03:30 UTC` (winter) / `02:30 UTC` (summer) — also equals `04:30 CET` / `04:30 CEST` / `06:30 MSK` / `12:30 JST` (winter)
- **SEA / TW only:** `20:30 UTC` — also equals `04:30 SGT` / `04:30 CST` / `23:30 MSK` (previous day) / `05:30 JST` (next day)
- **All four regions:** `09:30 UTC` is safe in winter; `08:30 UTC` in summer. NA reset is always the last one to fire, so scheduling for NA's reset covers everything.

You can also set **two triggers** if you want each region to be picked up as close to its reset as possible. The script is idempotent — extra runs just log `⏭️ Already signed in today`.

## What the script actually does

`checkInAllGames()` does, in order:

1. Resets the in-memory notification buffer.
2. For each of the four games (Genshin, Honkai, Star Rail, Zenless):
   - Calls `checkAndExecute()`, which for each cookie:
     - looks up the account (`getAccountDetails`),
     - reads today's sign-in status (`getSignInfo`),
     - reads the award pool (`getAwardsData`),
     - if the account hasn't signed in yet, performs the sign-in (`sign`).
   - If `enableCodeRedemption` is on, redeems any new promo codes for each successful account (`redeemCodes`).
3. Flushes the entire buffer to Discord as a single message (`flushDiscordNotifications`).

`manuallyRedeemCodes(gameName, forceRedeem)` is the same idea but only for code redemption, without the check-in step. It's used by the convenience wrappers `redeemGenshinCodes`, `redeemStarRailCodes`, and `redeemZenlessCodes`.

## Troubleshooting

**Nothing happens in Discord.**
- Check that `DISCORD_WEBHOOK` is the full URL (`https://discord.com/api/webhooks/…`).
- Check the **Executions** tab in Apps Script for a `flushDiscordNotifications` error.
- Make sure `NOTIFICATIONS.length > 0`. If every account was already signed in *and* there are no code events and no errors, the buffer is empty and the script deliberately sends nothing.

**The report says "Cookie is missing ltuid/ltuid_v2".**
The cookie string you pasted doesn't contain an `ltuid` or `ltuid_v2` field — usually a partial copy or an expired login. Re-grab the full cookie following step 2 (from the `getGameRecordCard` request), making sure you copy the entire `cookie` header value.

**I get `Error: undefined` in the report.**
This is what the script writes when the underlying error has no `.message` field. Look at the surrounding text (e.g. `Failed to fetch promo codes: undefined`) — the function name usually tells you which API call failed. The full error is also in the **Executions** tab.

**Code redemption says "retcode -1071".**
Your cookie has expired. Repeat step 2 to grab a fresh one. The error message in the report includes the exact `retcode` and the API's own message.

**My account was already signed in and codes weren't claimed.**
By default, code redemption in `checkInAllGames` only runs for accounts that *just* signed in (upstream behaviour). Two ways around it: set `redeemCodesEvenIfSignedIn: true` in the config to always check codes for every account, or use `redeemGenshinCodes(true)` / `redeemStarRailCodes(true)` / `redeemZenlessCodes(true)` from the toolbar to force a one-off run.

## License

[AGPL-3.0](LICENSE), inherited from the upstream project. If you fork and run this as a service, the AGPL requires you to publish your modifications under the same licence.
